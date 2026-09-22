#!/usr/bin/env python3
"""scripts/submit-drafts.py: the operator's and the cloud drafter's way into the
desk queue (docs/plans/2026-09-15-antenne-desk.md section 6.3). Run with: make validate

Every run is a subprocess against a throwaway copy of the scripts and desk.html,
with HOME pointed at a temporary directory and ANTENNE_KEY and
ANTENNE_CONVEX_SITE removed, so nothing here reads the operator's real key or
reaches a deployment. A local HTTP server in a thread stands in for the Convex
site: it checks every signature it receives and answers the route's byte and
count caps, read from convex/lib/limits.ts. Story text is marked, and no
marker may reach stdout or stderr on any run.
"""

import base64
import datetime as dt
import hashlib
import hmac
import http.server
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COPIED = ["scripts/submit-drafts.py", "scripts/antenne_sign.py", "scripts/build-feed.py", "desk.html"]
MARK = "SECRET-TEXT"
SECRET = base64.b64encode(hashlib.sha256(b"submit-drafts test key").digest()).decode("ascii")
KEY = "local:" + SECRET
TODAY = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def limit(name):
    """A cap as convex/lib/limits.ts states it, so the stand and the client are held to the route's own number."""
    with open(os.path.join(ROOT, "convex", "lib", "limits.ts"), encoding="utf-8") as fh:
        found = re.findall(r"^export const %s = ([0-9]+);" % name, fh.read(), re.M)
    if len(found) != 1:
        raise SystemExit("convex/lib/limits.ts states %s %d times, not once" % (name, len(found)))
    return int(found[0])


BODY_MAX = limit("BODY_MAX_BYTES")
COUNT_MAX = limit("SUBMIT_BATCH_MAX")


def encoded(stories):
    """Bytes of a /submit body carrying stories, written here independently of antenne_sign.encode."""
    return len(json.dumps({"stories": stories}, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


failed = 0
checks = 0
outputs = []
temp_dirs = []


def eq(actual, expected, what):
    global failed, checks
    checks += 1
    if json.dumps(actual) == json.dumps(expected):
        return True
    failed += 1
    print("FAIL %s\n  expected %r\n  got      %r" % (what, expected, actual), file=sys.stderr)
    return False


class section:
    def __init__(self, title):
        self.title = title

    def __enter__(self):
        self.before = (failed, checks)

    def __exit__(self, kind, value, tb):
        if kind:
            return False
        n = checks - self.before[1]
        if failed == self.before[0]:
            print("ok   %s (%d checks)" % (self.title, n))
        else:
            print("FAIL %s: %d of %d checks" % (self.title, failed - self.before[0], n), file=sys.stderr)
        return False


def story(slug, **over):
    post = {"id": "%s-%s" % (TODAY, slug), "date": TODAY, "kind": "feature", "site": "dispatch-site",
            "title": "A title %s" % MARK, "summary": "A summary %s." % MARK, "body": ["A paragraph %s." % MARK],
            "links": [{"label": "Desk", "url": "https://dispatch.neorgon.com/desk.html"}], "tags": ["desk"]}
    post.update(over)
    return post


def at_caps(slug, ch):
    """A valid story at every section 3.2 cap (id 80, site 40, title 100, summary 320,
    5 paragraphs of 900, 6 links of 40 and 300, 8 tags of 32), its text padded with ch."""
    def fill(prefix, pad, n):
        return prefix + pad * (n - len(prefix))
    pid = "%s-%s" % (TODAY, slug)
    return {"id": fill(pid, "x", 80), "date": TODAY, "kind": "feature", "site": "s" * 40,
            "title": fill("T %s " % MARK, ch, 100), "summary": fill("S %s " % MARK, ch, 320),
            "body": [fill("P%d %s " % (i, MARK), ch, 900) for i in range(5)],
            "links": [{"label": fill("L%d " % i, ch, 40), "url": fill("https://dispatch.neorgon.com/%d/" % i, "a", 300)} for i in range(6)],
            "tags": [fill("t%d-" % i, "x", 32) for i in range(8)]}


def make_site():
    site = tempfile.mkdtemp(prefix="submit-drafts-test-")
    temp_dirs.append(site)
    for rel in COPIED:
        os.makedirs(os.path.dirname(os.path.join(site, rel)), exist_ok=True)
        shutil.copyfile(os.path.join(ROOT, rel), os.path.join(site, rel))
    # The copy's meta is emptied, as it is before the wizard runs, so no run
    # here can reach a real deployment even after the meta is set.
    desk = os.path.join(site, "desk.html")
    with open(desk, encoding="utf-8") as fh:
        text = fh.read()
    with open(desk, "w", encoding="utf-8") as fh:
        fh.write(re.sub(r'<meta name="neo-convex-url" content="[^"]*">', '<meta name="neo-convex-url" content="">', text))
    os.makedirs(os.path.join(site, "home", ".config", "antenne"))
    return site


def write_json(site, name, doc):
    path = os.path.join(site, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return path


def run(site, *args, env=None):
    clean = {k: v for k, v in os.environ.items() if k not in ("ANTENNE_KEY", "ANTENNE_CONVEX_SITE")}
    clean.update({"HOME": os.path.join(site, "home"), "PYTHONDONTWRITEBYTECODE": "1"}, **(env or {}))
    proc = subprocess.run([sys.executable, os.path.join(site, "scripts", "submit-drafts.py"), *args],
                          capture_output=True, text=True, env=clean, timeout=60)
    outputs.append(proc.stdout + proc.stderr)
    try:
        doc = json.loads(proc.stdout) if proc.stdout.strip() else None
    except ValueError:
        doc = "not json"
    return proc.returncode, doc, proc.stderr


class Stand:
    """The Convex site, for one test: records each request, its size and whether its
    signature verifies, and refuses as convex/lib/routes.ts does a body over
    BODY_MAX_BYTES (413, before the signature is looked at) and a /submit of more
    than SUBMIT_BATCH_MAX stories (400)."""

    def __init__(self, reply):
        stand = self
        self.seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                key_id = self.headers.get("X-Antenne-Key", "")
                stamp = self.headers.get("X-Antenne-Timestamp", "")
                want = base64.b64encode(hmac.new(base64.b64decode(SECRET), ("%s.%s.%s." % (key_id, stamp, self.path)).encode() + raw,
                                                 hashlib.sha256).digest()).decode()
                verified = (key_id == "local" and stamp.isdigit() and abs(int(stamp) - time.time()) <= 300
                            and hmac.compare_digest(want, self.headers.get("X-Antenne-Signature", "")))
                body = json.loads(raw.decode("utf-8"))
                stand.seen.append({"path": self.path, "verified": verified, "body": body, "bytes": len(raw)})
                if len(raw) > BODY_MAX:
                    status, doc = 413, {"ok": False, "code": "too-large"}
                elif not verified:
                    status, doc = 401, {"ok": False, "code": "unauthorized"}
                elif self.path == "/submit" and len(body.get("stories", [])) > COUNT_MAX:
                    status, doc = 400, {"ok": False, "code": "too-many"}
                else:
                    status, doc = reply(self.path, body)
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def created(path, body):
    return 200, {"ok": True, "outcomes": [{"id": s["id"], "outcome": "created", "problems": []} for s in body["stories"]]}


REAL = {rel: open(os.path.join(ROOT, rel), "rb").read() for rel in ("desk.html", "data/posts.json", "feed.xml", "index.html")}
_spec = importlib.util.spec_from_file_location("build_feed", os.path.join(ROOT, "scripts", "build-feed.py"))
FEED = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(FEED)

try:
    with section("--dry-run validates in submit mode and prints ids only, with no key and no site"):
        site = make_site()
        one = write_json(site, "one.json", story("one"))
        two = write_json(site, "two.json", {"stories": [story("two"), story("three")]})
        code, doc, err = run(site, "--dry-run", one, two)
        eq([code, doc["dryRun"], doc["today"], [r["id"] for r in doc["results"]], [r["ok"] for r in doc["results"]]],
           [0, True, TODAY, ["%s-one" % TODAY, "%s-two" % TODAY, "%s-three" % TODAY], [True, True, True]],
           "three valid stories from a post and a {stories} file, by id")
        eq("nothing sent" in err, True, "and says nothing was sent")
        stale = write_json(site, "stale.json", story("old", date="2020-01-01", id="2020-01-01-old"))
        code, doc, _ = run(site, "--dry-run", one, stale)
        eq([code, [r["problems"] for r in doc["results"]]], [1, [[], [{"field": "date", "code": "window"}]]],
           "a story outside the submit window fails the dry run with its problem code")

    with section("one invalid story refuses the whole batch: nothing reaches the site"):
        stand = Stand(created)
        try:
            site = make_site()
            key = os.path.join(site, "key")
            with open(key, "w", encoding="utf-8") as fh:
                fh.write(KEY)
            os.chmod(key, 0o600)
            bad = write_json(site, "bad.json", {"stories": [story("fine"), story("bad", title=""), {"id": "Not An Id %s" % MARK}]})
            code, doc, err = run(site, "--site", stand.url, "--key-file", key, bad)
            eq([code, doc["refused"], [r["id"] for r in doc["results"]], [r["ok"] for r in doc["results"]]],
               [1, True, ["%s-fine" % TODAY, "%s-bad" % TODAY, None], [True, False, False]],
               "refused, every story listed by id; an id that is not one prints as null")
            eq(["2 of 3 stories are invalid" in err, stand.seen], [True, []], "stderr counts them, and the site saw nothing")
        finally:
            stand.close()

    with section("the key: ANTENNE_KEY, else --key-file, else ~/.config/antenne/submit-key, refused when wider than 600"):
        stand = Stand(created)
        try:
            site = make_site()
            post = write_json(site, "post.json", story("key"))
            key = os.path.join(site, "key")
            default = os.path.join(site, "home", ".config", "antenne", "submit-key")
            for path in (key, default):
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(KEY)
            for mode in (0o644, 0o640, 0o700):
                os.chmod(key, mode)
                code, _, err = run(site, "--site", stand.url, "--key-file", key, post)
                eq([code, "chmod 600" in err, SECRET[:16] in err], [2, True, False], "a --key-file at mode %o is refused (exit 2)" % mode)
            os.chmod(default, 0o644)
            code, _, err = run(site, "--site", stand.url, post)
            eq([code, "submit-key" in err, stand.seen], [2, True, []], "so is the default key file at 644, and nothing was sent")
            os.chmod(default, 0o600)
            code, doc, _ = run(site, "--site", stand.url, post)
            eq([code, doc["outcomes"][0]["outcome"], len(stand.seen)], [0, "created", 1], "the default key file at 600 is used")
            os.chmod(key, 0o644)
            code, _, _ = run(site, "--site", stand.url, "--key-file", key, post, env={"ANTENNE_KEY": KEY})
            eq(code, 0, "ANTENNE_KEY comes first, so a loose --key-file is never opened")
            os.remove(default)
            code, _, err = run(site, "--site", stand.url, post)
            eq([code, "ANTENNE_KEY" in err], [2, True], "no key anywhere: exit 2, naming ANTENNE_KEY")
        finally:
            stand.close()

    with section("the site: --site, else ANTENNE_CONVEX_SITE, else desk.html's meta read as .convex.site; an empty meta is a clear error"):
        site = make_site()
        post = write_json(site, "post.json", story("site"))
        code, _, err = run(site, post, env={"ANTENNE_KEY": KEY})
        eq([code, "neo-convex-url meta in desk.html is empty" in err, "not set up yet" in err, "--site" in err], [2, True, True, True],
           "an empty meta: exit 2, saying the backend is not set up and how to pass a site")
        spec = importlib.util.spec_from_file_location("submit_drafts", os.path.join(site, "scripts", "submit-drafts.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        desk = os.path.join(site, "desk.html")
        text = open(desk, encoding="utf-8").read()
        for content, want in (("https://happy-otter-123.convex.cloud", "https://happy-otter-123.convex.site"),
                              ("https://evil.example.com", "Unreadable"), ("", "Unreadable")):
            with open(desk, "w", encoding="utf-8") as fh:
                fh.write(text.replace('<meta name="neo-convex-url" content="">', '<meta name="neo-convex-url" content="%s">' % content))
            try:
                got = mod.site_from_desk()
            except mod.Unreadable:
                got = "Unreadable"
            eq(got, want, "meta %r gives %s" % (content, want))
        with open(desk, "w", encoding="utf-8") as fh:
            fh.write(text.replace('<meta name="neo-convex-url" content="">', ""))
        try:
            mod.site_from_desk()
            eq("read", "Unreadable", "no meta at all is refused")
        except mod.Unreadable as err:
            eq("0 neo-convex-url metas" in str(err), True, "no meta at all is refused")
        stand = Stand(created)
        try:
            code, doc, _ = run(site, post, env={"ANTENNE_KEY": KEY, "ANTENNE_CONVEX_SITE": stand.url})
            eq([code, len(stand.seen)], [0, 1], "ANTENNE_CONVEX_SITE is used when there is no --site")
            code, _, err = run(site, "--site", "http://example.com", post, env={"ANTENNE_KEY": KEY, "ANTENNE_CONVEX_SITE": stand.url})
            eq([code, "https://" in err, len(stand.seen)], [2, True, 1], "--site comes first, and plain http off this machine is refused")
        finally:
            stand.close()

    with section("the signed requests arrive and verify, in batches of at most 12, and print outcomes by id"):
        stand = Stand(created)
        try:
            site = make_site()
            stories = [story("s%02d" % i) for i in range(13)]
            path = write_json(site, "batch.json", {"stories": stories})
            code, doc, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            eq([code, [s["path"] for s in stand.seen], [s["verified"] for s in stand.seen], [len(s["body"]["stories"]) for s in stand.seen]],
               [0, ["/submit", "/submit"], [True, True], [12, 1]], "13 stories go as two signed /submit requests of 12 and 1")
            eq([o["id"] for o in doc["outcomes"]] == [s["id"] for s in stories] and all(o["outcome"] == "created" for o in doc["outcomes"]), True,
               "every story's outcome, by id")
            sent = stand.seen[0]["body"]["stories"][0]
            eq(list(sent.keys()), ["id", "date", "kind", "site", "title", "summary", "body", "links", "tags"], "the normalized post is what is sent")
        finally:
            stand.close()

        stand = Stand(created)
        try:
            # Keys reversed, text padded, no site: build-feed.py's normalized
            # post differs from this file in all three ways, and is what goes.
            raw = {"tags": ["desk"], "links": [{"label": " Desk ", "url": "https://dispatch.neorgon.com/desk.html"}],
                   "body": ["  A paragraph %s.  " % MARK], "summary": " A summary. ", "title": "  A title %s  " % MARK,
                   "kind": "feature", "date": TODAY, "id": "%s-padded" % TODAY}
            path = write_json(site, "padded.json", raw)
            code, _, _ = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            want = FEED.validate_post(raw, "submit", TODAY)["post"]
            sent = stand.seen[0]["body"]["stories"][0]
            eq([code, sent == want, list(sent) == list(want), sent == raw, sent.get("title"), sent.get("site", "missing"), sent.get("body")],
               [0, True, True, False, "A title %s" % MARK, None, ["A paragraph %s." % MARK]],
               "the file's story goes as build-feed.py normalizes it: fields in order, text trimmed, a missing site as null")
        finally:
            stand.close()

        def mixed(path, body):
            outs = [{"id": s["id"], "outcome": o, "problems": []} for s, o in zip(body["stories"], ("unchanged", "queue-full"))]
            outs.append({"id": "The Title %s" % MARK, "outcome": "created %s" % MARK, "problems": [{"field": MARK, "code": "x"}]})
            return 200, {"ok": True, "outcomes": outs, "title": MARK}

        stand = Stand(mixed)
        try:
            path = write_json(site, "two.json", {"stories": [story("a"), story("b")]})
            code, doc, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            eq([code, [o["outcome"] for o in doc["outcomes"]], doc["outcomes"][2]["id"], "2 of 3 stories did not land" in err],
               [1, ["unchanged", "queue-full", "unknown"], None, True], "queue-full is exit 1; a server's odd id or outcome is never echoed")
        finally:
            stand.close()

        stand = Stand(lambda path, body: (429, {"ok": False, "code": "rate-limited", "retryAfterMs": 60000, "message": MARK}))
        try:
            code, doc, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            eq([code, doc, "answered 429 rate-limited, retry in 60000 ms" in err], [1, {"outcomes": [], "unsent": 2}, True],
               "a refused request is exit 1 with its status and code, and says what was not sent")
        finally:
            stand.close()

        sizes = []

        def second_refused(path, body):
            sizes.append(len(body["stories"]))
            return created(path, body) if len(sizes) == 1 else (429, {"ok": False, "code": "rate-limited", "retryAfterMs": 60000})

        stand = Stand(second_refused)
        try:
            code, doc, err = run(site, "--site", stand.url, os.path.join(site, "batch.json"), env={"ANTENNE_KEY": KEY})
            eq([code, sizes, [o["outcome"] for o in doc["outcomes"]], doc["unsent"], "answered 429 rate-limited" in err],
               [1, [12, 1], ["created"] * 12, 1, True],
               "a later request refused: the 12 that landed keep their outcomes, and unsent counts only the 1 never accepted")
        finally:
            stand.close()
        stand = Stand(created)
        try:
            code, _, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": "local:" + base64.b64encode(bytes(32)).decode()})
            eq([code, "answered 401 unauthorized" in err, [s["verified"] for s in stand.seen]], [1, True, [False]], "a key the site does not know: 401, exit 1")
        finally:
            stand.close()

    with section("batches are cut by body bytes as well as count, so twelve stories at every post cap never meet a 413"):
        site = make_site()
        spec = importlib.util.spec_from_file_location("submit_drafts_caps", os.path.join(site, "scripts", "submit-drafts.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        eq([getattr(mod, "BATCH_MAX", None), getattr(mod, "BODY_MAX_BYTES", None)], [COUNT_MAX, BODY_MAX],
           "the client's two caps are convex/lib/limits.ts SUBMIT_BATCH_MAX and BODY_MAX_BYTES")
        # (padding, what it is, id slug, stories per request): one at-caps story encodes
        # to about 7.6 KB of ASCII, 12.7 KB of two-byte and 22.7 KB of four-byte text.
        for ch, what, slug, want in (("x", "ASCII", "one", [8, 4]), ("\u00e9", "two-byte", "two", [5, 5, 2]),
                                     ("\U0001F600", "four-byte", "four", [2, 2, 2, 2, 2, 2])):
            stand = Stand(created)
            try:
                raws = [at_caps("%s%02d" % (slug, i), ch) for i in range(COUNT_MAX)]
                posts = [FEED.validate_post(r, "submit", TODAY)["post"] for r in raws]
                path = write_json(site, "caps-%s.json" % slug, {"stories": raws})
                code, doc, err = run(site, "--dry-run", path)
                eq([code, all(r["ok"] for r in doc["results"]), encoded(posts) > BODY_MAX, "%d requests planned" % len(want) in err],
                   [0, True, True, True], "%s: all %d pass the dry run, together they are over %d bytes, and the plan says %d requests"
                   % (what, COUNT_MAX, BODY_MAX, len(want)))
                code, doc, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
                sent = [s["body"]["stories"] for s in stand.seen]
                eq([code, [len(b) for b in sent], all(s["verified"] for s in stand.seen), all(s["bytes"] <= BODY_MAX for s in stand.seen)],
                   [0, want, True, True], "%s: sent as %r, every request signed and within the byte cap" % (what, want))
                eq([[s["bytes"] for s in stand.seen] == [encoded(b) for b in sent], [p for b in sent for p in b] == posts,
                    [o["id"] for o in doc["outcomes"]] == [p["id"] for p in posts], sorted({o["outcome"] for o in doc["outcomes"]})],
                   [True, True, True, ["created"]], "%s: in order, each story once, every outcome by id" % what)
                eq([encoded(b + [sent[i + 1][0]]) > BODY_MAX or len(b) == COUNT_MAX for i, b in enumerate(sent[:-1])], [True] * (len(want) - 1),
                   "%s: each request but the last is as full as the next story allows" % what)
            finally:
                stand.close()
        # plan() and body_bytes() in process, after the runs above, which judge the script as it behaves.
        small = [FEED.validate_post(story("p%02d" % i), "submit", TODAY)["post"] for i in range(13)]
        eq([len(b) for b in mod.plan(small)], [12, 1], "short stories are still cut by count alone: 12 and 1")
        eq([mod.plan([]), [len(b) for b in mod.plan(small[:5], bytes_max=encoded(small[:2]))]], [[], [2, 2, 1]],
           "a smaller byte cap cuts sooner, in order")
        worst = FEED.validate_post(at_caps("worst", "\U0001F600"), "submit", TODAY)
        eq([worst["ok"], mod.body_bytes([worst["post"]]) == encoded([worst["post"]]), encoded([worst["post"]]) * 2 < BODY_MAX], [True, True, True],
           "the largest story the rules allow (four-byte text at every cap) fits one request with room, measured as sent")

    with section("a story no request could carry is refused as too-large before anything is sent"):
        # The copy's byte cap is lowered between one ASCII and one two-byte
        # story at the caps, since no story the rules allow is over the real one.
        site = make_site()
        script = os.path.join(site, "scripts", "submit-drafts.py")
        with open(script, encoding="utf-8") as fh:
            text, n = re.subn(r"^BODY_MAX_BYTES = [0-9]+", "BODY_MAX_BYTES = 10000", fh.read(), flags=re.M)
        eq(n, 1, "the copy's BODY_MAX_BYTES is lowered to 10000")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(text)
        ascii_post, wide_post = at_caps("fits", "x"), at_caps("wide", "\u00e9")
        path = write_json(site, "wide.json", {"stories": [ascii_post, wide_post]})
        code, doc, err = run(site, "--dry-run", path)
        eq([code, [r["ok"] for r in doc["results"]], doc["results"][1]["problems"], "1 invalid" in err],
           [1, [True, False], [{"field": "story", "code": "too-large"}], True], "the dry run names it too-large and exits 1")
        stand = Stand(created)
        try:
            code, doc, err = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            eq([code, doc.get("refused"), [r["id"] for r in doc.get("results", [])], "1 of 2 stories are invalid" in err, stand.seen],
               [1, True, [ascii_post["id"], wide_post["id"]], True, []], "the run is refused by id and the site saw nothing")
            path = write_json(site, "two-fit.json", {"stories": [ascii_post, at_caps("also", "x")]})
            code, doc, _ = run(site, "--site", stand.url, path, env={"ANTENNE_KEY": KEY})
            eq([code, [len(s["body"]["stories"]) for s in stand.seen], all(s["bytes"] <= 10000 for s in stand.seen)], [0, [1, 1], True],
               "two that fit alone but not together go as two requests under the lowered cap")
        finally:
            stand.close()

    with section("--status prints counts, ids, ages, the last run and the token expiry, each in its shape, and nothing else the site says"):
        good_run = {"runId": "jd7abc123", "state": "failed", "trigger": "approve", "attempts": 5, "followUp": False, "createdAt": 1,
                    "updatedAt": 2, "ageMs": 3, "runUrl": "https://github.com/energon-a-secas/dispatch-site/actions/runs/123",
                    "commitSha": "a" * 40, "error": "dispatch 401", "stories": 2}
        bad_run = {"runId": "run %s" % MARK, "state": MARK, "trigger": "x\n%s" % MARK, "attempts": "5", "followUp": "no", "createdAt": True,
                   "updatedAt": None, "ageMs": 1.5, "runUrl": "https://evil.example/%s" % MARK, "commitSha": MARK,
                   "error": "one line\n%s" % MARK, "stories": [MARK], "body": MARK}
        runs = [good_run, bad_run]

        def status(path, body):
            return 200, {"ok": True, "counts": {"pending": 2, "approved": 1, "note": MARK, "extra": 7, "live": True},
                         "queue": [{"storyId": "%s-a" % TODAY, "status": "pending", "source": "machine", "assigned": False, "ageMs": 5,
                                    "approvedAgeMs": None, "claimedAgeMs": None, "committedAgeMs": None, "title": MARK},
                                   {"storyId": "Not An Id %s" % MARK, "status": "The %s" % MARK, "source": MARK, "assigned": MARK, "ageMs": MARK}],
                         "lastRun": runs.pop(0), "tokenExpires": "2027-01-31", "summary": MARK}

        stand = Stand(status)
        try:
            site = make_site()
            code, doc, _ = run(site, "--status", "--site", stand.url, env={"ANTENNE_KEY": KEY})
            eq([code, [s["path"] for s in stand.seen], stand.seen[0]["body"], stand.seen[0]["verified"]], [0, ["/status"], {}, True],
               "one signed POST /status with {}")
            eq([sorted(doc), doc["counts"], doc["queue"][0]["storyId"], "title" in doc["queue"][0], doc["lastRun"], doc["tokenExpires"]],
               [["counts", "lastRun", "queue", "tokenExpires"], {"pending": 2, "approved": 1}, "%s-a" % TODAY, False, good_run, "2027-01-31"],
               "only the fields section 5 names are printed, and well-formed values as sent")
            eq(doc["queue"][1], {"storyId": None, "status": "unknown", "source": "unknown", "assigned": None, "ageMs": None,
                                 "approvedAgeMs": None, "claimedAgeMs": None, "committedAgeMs": None}, "a queue item out of shape prints as nulls and unknown")
            code, doc, _ = run(site, "--status", "--site", stand.url, env={"ANTENNE_KEY": KEY})
            eq([code, doc["lastRun"]], [0, {"runId": None, "state": "unknown", "trigger": "unknown", "attempts": None, "followUp": None,
                                            "createdAt": None, "updatedAt": None, "ageMs": None, "runUrl": None, "commitSha": None,
                                            "error": "unknown", "stories": None}], "a last run out of shape prints as nulls and unknown")
            code, _, err = run(site, "--status", "x.json", "--site", stand.url, env={"ANTENNE_KEY": KEY})
            eq([code, "--status takes no FILE" in err], [2, True], "--status with a FILE is a usage error")
        finally:
            stand.close()

    with section("no story text reached stdout or stderr on any run, and this tree was never written"):
        eq([len(outputs) > 15, [i for i, text in enumerate(outputs) if MARK in text]], [True, []], "%d runs, no marker" % len(outputs))
        for rel, content in REAL.items():
            eq(open(os.path.join(ROOT, rel), "rb").read() == content, True, rel + " is unchanged")
finally:
    for path in temp_dirs:
        shutil.rmtree(path, ignore_errors=True)

print("\n%d of %d checks failed" % (failed, checks) if failed else "\nall %d checks passed" % checks)
sys.exit(1 if failed else 0)
