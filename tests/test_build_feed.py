#!/usr/bin/env python3
"""scripts/build-feed.py: the Python enforcer of the post rules, and the feed it
builds. Run with: make validate

It answers the same tests/post-vectors.json and tests/hash-vectors.json that
tests/post-mirror.test.mjs holds the JavaScript enforcers to, then drives every
command. Each command runs against a throwaway copy of the site in a temporary
directory, never this tree: a plain run rewrites feed.xml's lastBuildDate and
--merge rewrites data/posts.json. Story text is marked, and no marker may reach
stdout or stderr.
"""

import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COPIED = ["scripts/build-feed.py", "data/posts.json", "index.html", "feed.xml",
          "tests/post-vectors.json", "tests/hash-vectors.json"]
MODES = ("read", "archive", "desk", "submit")

failed = 0
checks = 0
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


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def make_site():
    site = tempfile.mkdtemp(prefix="dispatch-site-test-")
    temp_dirs.append(site)
    for rel in COPIED:
        dst = os.path.join(site, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), dst)
    return site


def load(site):
    spec = importlib.util.spec_from_file_location("build_feed", os.path.join(site, "scripts", "build-feed.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(site, *args):
    done = subprocess.run([sys.executable, os.path.join(site, "scripts", "build-feed.py"), *args],
                          capture_output=True, text=True, cwd=site)
    return done.returncode, done.stdout, done.stderr


def exit_code(fn):
    """The code a fail() inside fn exits with, and what it printed; None if it returned."""
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            fn()
    except SystemExit as stop:
        return stop.code, err.getvalue()
    return None, err.getvalue()


def raises(fn):
    try:
        fn()
    except (ValueError, TypeError):
        return True
    return False


def dump_json(path, value):
    write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


REAL = {rel: read_bytes(os.path.join(ROOT, rel)) for rel in ("data/posts.json", "feed.xml", "index.html")}
SITE = make_site()
bf = load(SITE)
POST_VECTORS = json.loads(read_text(os.path.join(SITE, "tests", "post-vectors.json")))
HASH_VECTORS = json.loads(read_text(os.path.join(SITE, "tests", "hash-vectors.json")))
ARCHIVE_TEXT = read_text(os.path.join(SITE, "data", "posts.json"))
ARCHIVE = json.loads(ARCHIVE_TEXT)

try:
    # ── The rules ─────────────────────────────────────────────────────────────
    with section("build-feed.py holds the pinned KINDS, CAPS, HOSTS and JavaScript trim set"):
        rules = POST_VECTORS["rules"]
        eq(list(bf.KINDS), rules["kinds"], "KINDS")
        eq(bf.CAPS, rules["caps"], "CAPS, in order")
        eq(list(bf.HOSTS), rules["hosts"], "HOSTS")
        eq(bf.JS_WHITESPACE, rules["trim"], "JS_WHITESPACE is exactly what String.prototype.trim removes")

    with section("build-feed.py answers every post vector in every mode"):
        for v in POST_VECTORS["vectors"]:
            for mode in MODES:
                raw = copy.deepcopy(v["raw"])
                got = bf.validate_post(raw, mode, v["today"])
                want = v["expect"][mode]
                eq([got["ok"], got["problems"], got["external"], got["post"]],
                   [want["ok"], want["problems"], want["external"], want["post"]], "%s [%s]" % (v["name"], mode))
                eq(sorted(got), ["external", "ok", "post", "problems"], "%s [%s] returns ok, post, problems, external" % (v["name"], mode))
                eq(raw == v["raw"], True, "%s [%s] leaves its input untouched" % (v["name"], mode))

    with section("build-feed.py refuses an unknown mode and a submit with no real today"):
        base = POST_VECTORS["vectors"][0]["raw"]
        eq(raises(lambda: bf.validate_post(base, "published")), True, "an unknown mode raises")
        eq(raises(lambda: bf.validate_post(base, "submit")), True, "submit without today raises")
        eq(raises(lambda: bf.validate_post(base, "submit", "2026-02-30")), True, "submit with an impossible today raises")
        eq(raises(lambda: bf.validate_post(base, "submit", "2026-09-15\n")), True, "submit with a padded today raises")
        eq(raises(lambda: bf.validate_post(base, "archive")), False, "archive needs no today")

    with section("build-feed.py answers every hash vector"):
        for h in HASH_VECTORS["vectors"]:
            if h.get("error"):
                eq(raises(lambda: bf.canonical_json(h["value"])), True, "canonical_json refuses " + h["name"])
                eq(raises(lambda: bf.content_hash(h["value"])), True, "content_hash refuses " + h["name"])
            else:
                eq(bf.canonical_json(h["value"]), h["canonical"], "canonical_json of " + h["name"])
                eq(bf.content_hash(h["value"]), h["sha256"], "content_hash of " + h["name"])
        # JSON has no such value, so it has no vector: json.dumps would quietly
        # write the key 1 as "1", a text JavaScript could never hash from it.
        eq([raises(lambda: bf.canonical_json({1: "a"})), raises(lambda: bf.content_hash({"a": {2: "b"}}))], [True, True],
           "canonical_json and content_hash refuse a key that is not a string, nested too")

    with section("day_number counts days as datetime does, 1600 to 2400, and knows impossible dates"):
        epoch = bf.day_number("1970-01-01")
        day, last, drift = dt.date(1600, 1, 1), dt.date(2400, 12, 31), 0
        while day <= last:
            if bf.day_number(day.isoformat()) - epoch != (day - dt.date(1970, 1, 1)).days:
                drift += 1
            day += dt.timedelta(days=1)
        eq(drift, 0, "every day from 1600 to 2400 agrees with datetime.date")
        wrong = []
        for year in (0, 1, 1900, 2000, 2024, 2026, 2100, 2400, 9999):
            for month in range(0, 14):
                for d in range(0, 33):
                    iso = "%04d-%02d-%02d" % (year, month, d)
                    try:
                        real = year >= 1 and dt.date(year, month, d) is not None
                    except ValueError:
                        real = False
                    if (bf.day_number(iso) is not None) != real:
                        wrong.append(iso)
        eq(wrong, [], "a date is real exactly when datetime.date accepts it, and year 0000 is not")

    with section("every post in data/posts.json passes archive, desk and read mode unchanged"):
        for p in ARCHIVE["posts"]:
            for mode in ("archive", "desk", "read"):
                got = bf.validate_post(p, mode)
                eq([got["ok"], got["problems"], got["external"], got["post"]], [True, [], False, p], "%s [%s]" % (p["id"], mode))

    # ── The feed and the stamp ────────────────────────────────────────────────
    with section("a plain run on the unchanged archive rewrites nothing but lastBuildDate"):
        site = make_site()
        code, out, err = run(site)
        eq(code, 0, "exit 0")
        eq(read_bytes(os.path.join(site, "index.html")) == REAL["index.html"], True, "index.html is byte-identical")
        mask = lambda text: re.sub(rb"<lastBuildDate>[^<]*</lastBuildDate>", b"<lastBuildDate/>", text)
        eq(mask(read_bytes(os.path.join(site, "feed.xml"))) == mask(REAL["feed.xml"]), True,
           "feed.xml is byte-identical apart from lastBuildDate")
        eq(read_bytes(os.path.join(site, "data", "posts.json")) == REAL["data/posts.json"], True, "data/posts.json is untouched")
        eq(run(site, "--check")[0], 0, "--check passes")
        eq(run(site, "--selftest")[0], 0, "--selftest passes")

    with section("--check fails on a stale stamp"):
        site = make_site()
        index = os.path.join(site, "index.html")
        write_text(index, read_text(index).replace("30 stories<!-- /gen:edition -->", "29 stories<!-- /gen:edition -->"))
        code, out, err = run(site, "--check")
        eq([code, "stale" in err], [1, True], "exit 1, naming the stale stamp")

    with section("a stray posts.json at the project root fails every build"):
        site = make_site()
        shutil.copy2(os.path.join(site, "data", "posts.json"), os.path.join(site, "posts.json"))
        feed_before = read_bytes(os.path.join(site, "feed.xml"))
        code, out, err = run(site, "--check")
        eq([code, "posts.json exists at the project root" in err], [1, True], "--check exits 1 and says why")
        code, out, err = run(site)
        eq(code, 1, "a plain run exits 1")
        eq(read_bytes(os.path.join(site, "feed.xml")) == feed_before, True, "and writes no feed.xml")
        os.remove(os.path.join(site, "posts.json"))
        eq(run(site, "--check")[0], 0, "removing the copy clears it")

    with section("an impossible date never crashes fmt_date, rfc822 or the build"):
        eq(bf.fmt_date("2026-09-10"), "Sep 10, 2026", "fmt_date of a real date")
        eq(bf.fmt_date("2026-02-30"), "Feb 30, 2026", "fmt_date, like js/utils.js fmtDate, does not check the day")
        eq(bf.fmt_date("2026-13-01"), "undefined 1, 2026", "month 13 reads as js/utils.js fmtDate prints it")
        eq(bf.fmt_date("2026-00-05"), "undefined 5, 2026", "and so does month 0")
        eq(bf.fmt_date("2026-09-10\n"), "2026-09-10\n", "a trailing newline is not a date")
        eq(bf.fmt_date("\uff12\uff10\uff12\uff16-09-10"), "\uff12\uff10\uff12\uff16-09-10", "full-width digits are not a date")
        eq(bf.fmt_date(None), "", "nothing formats as nothing")
        eq(bf.rfc822("2026-09-10"), "Thu, 10 Sep 2026 12:00:00 +0000", "rfc822 of a real date")
        for bad in ("2026-02-30", "2026-13-01", "2026-00-00", "0000-01-01", "2100-02-29", "garbage", "", None, "2026-09-10\n"):
            eq(bf.rfc822(bad), "", "rfc822(%r) is empty" % (bad,))
        post = dict(ARCHIVE["posts"][0], date="2026-02-30")
        eq("<pubDate>" in bf.item_xml(post), False, "an item with an impossible date carries no pubDate")
        eq(bf.edition_line({"updated": "2026-13-40"}, []), "Edition of today · 0 stories", "an impossible updated date reads as today")
        site = make_site()
        doc = json.loads(ARCHIVE_TEXT)
        doc["posts"][5]["date"] = "2026-02-30"
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        for args in ((), ("--check",)):
            code, out, err = run(site, *args)
            eq([code, "date calendar" in err, "Traceback" in err], [1, True, False],
               "build-feed.py %s exits 1 naming date calendar, with no traceback" % " ".join(args))

    with section("item_xml refuses characters XML 1.0 cannot carry"):
        good = ARCHIVE["posts"][0]
        for ch, name in (("\ufffe", "U+FFFE"), ("\uffff", "U+FFFF"), ("\ud800", "a lone surrogate"), ("\x01", "U+0001"), ("\x0b", "a vertical tab")):
            for field in ("title", "summary"):
                code, err = exit_code(lambda: bf.item_xml(dict(good, **{field: "MARKER-" + ch})))
                eq([code, "XML 1.0" in err, "MARKER" in err], [1, True, False], "%s in the %s is refused without echoing it" % (name, field))
        eq(exit_code(lambda: bf.item_xml(dict(good, summary="tab\tand\nnewline")))[0], None, "tab and newline are XML characters")
        site = make_site()
        doc = json.loads(ARCHIVE_TEXT)
        doc["posts"][0]["title"] = "A title with \ufffe inside"
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        feed_before = read_bytes(os.path.join(site, "feed.xml"))
        code, out, err = run(site)
        eq([code, "XML 1.0" in err, "Traceback" in err], [1, True, False], "a plain run exits 1 before writing")
        eq(read_bytes(os.path.join(site, "feed.xml")) == feed_before, True, "feed.xml is untouched")
        eq(read_bytes(os.path.join(site, "index.html")) == REAL["index.html"], True, "index.html is untouched")

    # ── --validate-story ──────────────────────────────────────────────────────
    MARKERS = ["MARKER-TITLE", "MARKER-SUMMARY", "MARKER-BODY", "MARKER-LABEL", "marker-url-path", "marker-tag", "marker-site"]

    def story(**patch):
        s = {"id": "2026-09-14-marker-story", "date": "2026-09-14", "kind": "note", "site": "marker-site",
             "title": "MARKER-TITLE story", "summary": "MARKER-SUMMARY line.", "body": ["MARKER-BODY paragraph."],
             "links": [{"label": "MARKER-LABEL", "url": "https://dispatch.neorgon.com/marker-url-path"}], "tags": ["marker-tag"]}
        s.update(patch)
        return s

    def no_story_text(what, *outputs):
        blob = "".join(outputs)
        eq([m for m in MARKERS if m in blob], [], what + ": no story text in stdout or stderr")

    with section("--validate-story prints ids, verdicts and problem codes, never story text"):
        site = make_site()
        one = os.path.join(site, "one.json")
        dump_json(one, story())
        code, out, err = run(site, "--validate-story", one)
        eq([code, json.loads(out)], [0, {"results": [{"id": "2026-09-14-marker-story", "ok": True, "problems": []}]}],
           "one valid post: exit 0")
        no_story_text("one valid post", out, err)

        batch = os.path.join(site, "batch.json")
        dump_json(batch, {"stories": [
            story(),
            story(id="2026-09-14-marker-long", title="MARKER-TITLE " + "x" * 200),
            story(id="marker-no-date"),
            story(id="2026-09-14-xoxb-leak", summary=""),
            "MARKER-TITLE not a post",
        ]})
        code, out, err = run(site, "--validate-story", batch)
        eq([code, json.loads(out)], [1, {"results": [
            {"id": "2026-09-14-marker-story", "ok": True, "problems": []},
            {"id": "2026-09-14-marker-long", "ok": False, "problems": [{"field": "title", "code": "too-long"}]},
            {"id": "marker-no-date", "ok": False, "problems": [{"field": "id", "code": "id-date"}]},
            {"id": None, "ok": False, "problems": [{"field": "id", "code": "token"}, {"field": "summary", "code": "required"}]},
            {"id": None, "ok": False, "problems": [{"field": "post", "code": "format"}]},
        ]}], "a batch: exit 1, an id only where the id itself is sound")
        no_story_text("a batch", out, err)

        outside = os.path.join(site, "outside.json")
        dump_json(outside, {"stories": [story(date="2026-06-01", id="2026-06-01-marker-old",
                                              links=[{"label": "MARKER-LABEL", "url": "https://example.com/marker-url-path"}])]})
        code, out, err = run(site, "--validate-story", outside, "--mode", "submit", "--today", "2026-09-15")
        eq([code, json.loads(out)["results"][0]["problems"]],
           [1, [{"field": "date", "code": "window"}, {"field": "links[0].url", "code": "host"}]], "--mode submit adds the window and the host rule")
        no_story_text("submit mode", out, err)
        eq(run(site, "--validate-story", outside)[0], 0, "the same story passes the default desk mode")

        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        fresh = os.path.join(site, "fresh.json")
        dump_json(fresh, story(id=today + "-marker-story", date=today))
        eq(run(site, "--validate-story", fresh, "--mode", "submit")[0], 0, "submit mode without --today uses today in UTC")

        broken = os.path.join(site, "broken.json")
        write_text(broken, '{"stories": [')
        for path, what in ((broken, "malformed JSON"), (os.path.join(site, "missing.json"), "a missing file")):
            code, out, err = run(site, "--validate-story", path)
            eq([code, out], [2, ""], what + " exits 2 and prints no results")
        notalist = os.path.join(site, "notalist.json")
        dump_json(notalist, {"stories": "MARKER-TITLE"})
        code, out, err = run(site, "--validate-story", notalist)
        eq([code, out], [2, ""], "stories that are not an array exit 2")
        no_story_text("a refused file", out, err)

    with section("flags that do not belong together exit 2"):
        site = make_site()
        one = os.path.join(site, "one.json")
        dump_json(one, story())
        eq(run(site, "--mode", "submit")[0], 2, "--mode without --validate-story")
        eq(run(site, "--check", "--today", "2026-09-15")[0], 2, "--today with --check")
        eq(run(site, "--validate-story", one, "--today", "2026-02-30")[0], 2, "an impossible --today")
        eq(run(site, "--validate-story", one, "--merge", one)[0], 2, "--validate-story with --merge")

    # ── --merge ───────────────────────────────────────────────────────────────
    with section("--merge adds, recognizes, conflicts and refuses by id, and writes posts.json byte for byte"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        mode_before = os.stat(posts_path).st_mode & 0o777
        archive = json.loads(ARCHIVE_TEXT)
        by_date = lambda date: [p["id"] for p in archive["posts"] if p["date"] == date]
        existing_same = copy.deepcopy(archive["posts"][5])
        existing_padded = copy.deepcopy(archive["posts"][6])
        existing_padded["title"] = "  " + existing_padded["title"] + " "
        existing_changed = copy.deepcopy(archive["posts"][2])
        existing_changed["summary"] = "MARKER-SUMMARY rewritten."
        new_a = story(id="2026-09-09-marker-merge", date="2026-09-09")
        new_b = story(id="2026-09-08-zz-marker", date="2026-09-08")
        new_r = story(id="2026-09-08-r-marker", date="2026-09-08")
        new_old = story(id="2020-01-01-marker-old", date="2020-01-01")
        stories = [
            new_a, existing_same, existing_changed, new_b,
            story(id="2026-09-14-marker-untitled", title=""),
            existing_padded, new_r,
            story(id="2026-09-14-xoxb-leak", title=""),
            copy.deepcopy(new_a), story(id="2026-09-09-marker-merge", date="2026-09-09", title="MARKER-TITLE changed"),
            new_old,
        ]
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": stories})
        code, out, err = run(site, "--merge", batch, "--today", "2026-09-15")
        eq(code, 0, "exit 0")
        eq(json.loads(out), {
            "added": ["2026-09-09-marker-merge", "2026-09-08-zz-marker", "2026-09-08-r-marker", "2020-01-01-marker-old"],
            "identical": [existing_same["id"], existing_padded["id"], "2026-09-09-marker-merge"],
            "conflict": [existing_changed["id"], "2026-09-09-marker-merge"],
            "invalid": ["2026-09-14-marker-untitled", None],
        }, "each story lands in exactly one list, by id, in file order")
        eq(list(json.loads(out)), ["added", "identical", "conflict", "invalid"], "the output keys, in order")
        no_story_text("--merge", out, err)

        added = [bf.validate_post(s, "desk")["post"] for s in (new_a, new_b, new_r, new_old)]
        expected = json.loads(ARCHIVE_TEXT)
        expected["updated"] = "2026-09-15"
        expected["posts"] = sorted(expected["posts"] + added, key=lambda p: (p["date"], p["id"]), reverse=True)
        written = read_text(posts_path)
        eq(written == json.dumps(expected, indent=2, ensure_ascii=False) + "\n", True,
           "posts.json is json.dumps(doc, indent=2, ensure_ascii=False) plus a newline, sorted by (date, id), updated set to --today")
        ids = [p["id"] for p in json.loads(written)["posts"]]
        eq(ids[:2], [archive["posts"][0]["id"], "2026-09-09-marker-merge"], "a new date slots in between its neighbours")
        eq(ids[2:2 + len(by_date("2026-09-08")) + 2],
           sorted(by_date("2026-09-08") + ["2026-09-08-zz-marker", "2026-09-08-r-marker"], reverse=True),
           "on a shared date, ids sort descending among the existing ones")
        eq(ids[-1], "2020-01-01-marker-old", "desk mode has no date window, so an old story merges, last")
        restored = json.loads(written)
        restored["posts"] = [p for p in restored["posts"] if p["id"] not in {q["id"] for q in added}]
        restored["updated"] = archive["updated"]
        eq(json.dumps(restored, indent=2, ensure_ascii=False) + "\n" == ARCHIVE_TEXT, True,
           "every existing post is kept byte for byte")
        eq(os.stat(posts_path).st_mode & 0o777, mode_before, "the file keeps its permissions")
        eq([name for name in os.listdir(os.path.join(site, "data")) if name != "posts.json"], [], "no temporary file is left behind")

        code, out, err = run(site, "--check")
        eq([code, "stale" in err], [1, True], "the merged archive validates, and only the stamp is stale")
        eq(run(site)[0], 0, "a plain build after the merge succeeds")
        eq(run(site, "--check")[0], 0, "and --check then passes")

    with section("--merge writes non-ASCII text as UTF-8 characters, never as \\u escapes"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        accented = story(id="2026-09-12-marker-accent", date="2026-09-12", title="MARKER-TITLE café crème")
        eq(ARCHIVE_TEXT.isascii(), True, "the archive itself is ASCII, so only the merged story can tell the two serializations apart")
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [accented]})
        code, out, err = run(site, "--merge", batch, "--today", "2026-09-15")
        eq([code, json.loads(out)], [0, {"added": ["2026-09-12-marker-accent"], "identical": [], "conflict": [], "invalid": []}], "the story is added")
        no_story_text("--merge with non-ASCII text", out, err)
        eq("caf" in out + err, False, "the accented title reaches neither stdout nor stderr")
        written = read_bytes(posts_path)
        eq(["café crème".encode("utf-8") in written, b"\\u00e9" in written], [True, False],
           "the accented title is on disk as UTF-8 bytes, not as an escape")
        expected = json.loads(ARCHIVE_TEXT)
        expected["updated"] = "2026-09-15"
        expected["posts"] = sorted(expected["posts"] + [bf.validate_post(accented, "desk")["post"]],
                                   key=lambda p: (p["date"], p["id"]), reverse=True)
        eq(written == (json.dumps(expected, indent=2, ensure_ascii=False) + "\n").encode("utf-8"), True,
           "byte for byte json.dumps(doc, indent=2, ensure_ascii=False) plus a newline")
        eq(written == (json.dumps(expected, indent=2, ensure_ascii=True) + "\n").encode("utf-8"), False,
           "which is not what ensure_ascii=True writes")
        eq(run(site)[0], 0, "a plain build after the merge succeeds")
        eq("café crème".encode("utf-8") in read_bytes(os.path.join(site, "feed.xml")), True, "and feed.xml carries the title as UTF-8")

    with section("--merge that adds nothing leaves posts.json alone"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        before = read_bytes(posts_path)
        changed = copy.deepcopy(ARCHIVE["posts"][1])
        changed["title"] = "MARKER-TITLE changed"
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [copy.deepcopy(ARCHIVE["posts"][0]), changed, story(kind="rumour")]})
        code, out, err = run(site, "--merge", batch, "--today", "2026-12-31")
        eq([code, json.loads(out)], [0, {"added": [], "identical": [ARCHIVE["posts"][0]["id"]],
                                       "conflict": [ARCHIVE["posts"][1]["id"]], "invalid": ["2026-09-14-marker-story"]}],
           "identical, conflict and invalid only")
        eq(read_bytes(posts_path) == before, True, "posts.json is byte-identical, updated included")
        no_story_text("--merge with nothing added", out, err)

    with section("--merge without --today stamps today in UTC"):
        site = make_site()
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [story()]})
        before = dt.datetime.now(dt.timezone.utc).date().isoformat()
        code, out, err = run(site, "--merge", batch)
        after = dt.datetime.now(dt.timezone.utc).date().isoformat()
        updated = json.loads(read_text(os.path.join(site, "data", "posts.json")))["updated"]
        eq([code, updated in (before, after)], [0, True], "updated is today in UTC")

    with section("--merge exits 2 when the file or the archive cannot be read"):
        site = make_site()
        one = os.path.join(site, "one.json")
        dump_json(one, story())
        code, out, err = run(site, "--merge", one)
        eq([code, out], [2, ""], "a single post instead of {stories}")
        code, out, err = run(site, "--merge", os.path.join(site, "missing.json"))
        eq([code, out], [2, ""], "a missing file")
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [story()]})
        write_text(os.path.join(site, "data", "posts.json"), "{")
        code, out, err = run(site, "--merge", batch)
        eq([code, out, read_text(os.path.join(site, "data", "posts.json"))], [2, "", "{"], "an unreadable archive, left as it was")
        no_story_text("a refused merge", out, err)
        for text, what in (("[]\n", "an archive that is a list"), ('{"posts": 3}\n', "an archive whose posts is not a list"),
                           ('{"updated": "2026-09-15"}\n', "an archive with no posts")):
            write_text(os.path.join(site, "data", "posts.json"), text)
            code, out, err = run(site, "--merge", batch)
            eq([code, out, "Traceback" in err, read_text(os.path.join(site, "data", "posts.json"))], [2, "", False, text],
               what + " exits 2 with no traceback, left as it was")

    with section("--merge judges each story in desk mode, so an id must start with its date"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        before = read_bytes(posts_path)
        wrong = story(id="2026-09-13-marker-story")
        eq([bf.validate_post(wrong, "archive")["ok"], bf.validate_post(wrong, "desk")["problems"]],
           [True, [{"field": "id", "code": "id-date"}]], "archive mode would take the story; desk mode finds only id-date")
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [wrong]})
        code, out, err = run(site, "--merge", batch, "--today", "2026-09-15")
        eq([code, json.loads(out)], [0, {"added": [], "identical": [], "conflict": [], "invalid": ["2026-09-13-marker-story"]}],
           "the story is invalid and nothing is added")
        eq(read_bytes(posts_path) == before, True, "posts.json is untouched")
        no_story_text("--merge in desk mode", out, err)

    with section("--merge hashes each archived post as archive mode normalizes it, and never adds an id the archive holds"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        doc = json.loads(ARCHIVE_TEXT)
        target = next(i for i, p in enumerate(doc["posts"]) if p["links"] and i + 1 < len(doc["posts"]))
        spelled = doc["posts"][target]
        spelled["title"] = "  " + spelled["title"] + " "
        spelled["links"][0]["rel"] = "me"
        spelled["draft"] = True
        broken = doc["posts"][target + 1]
        repaired = copy.deepcopy(broken)
        broken["title"] = "x" * 200
        dump_json(posts_path, doc)
        before = read_bytes(posts_path)
        normalized = bf.validate_post(spelled, "archive")["post"]
        eq([normalized == ARCHIVE["posts"][target], bf.content_hash(spelled) == bf.content_hash(normalized), bf.validate_post(broken, "archive")["ok"]],
           [True, False, False], "the archived post normalizes to the original, its raw spelling hashes differently, and the next post fails archive mode")
        batch = os.path.join(site, "merge.json")
        dump_json(batch, {"stories": [normalized, copy.deepcopy(spelled), repaired]})
        code, out, err = run(site, "--merge", batch, "--today", "2026-09-15")
        eq([code, json.loads(out)], [0, {"added": [], "identical": [spelled["id"], spelled["id"]], "conflict": [broken["id"]], "invalid": []}],
           "the normalized story and the raw spelling are both identical; an id whose archived post fails archive mode is a conflict, not added twice")
        eq(read_bytes(posts_path) == before, True, "posts.json is untouched")

    with section("write_atomic leaves no temporary file and the old file when the final rename fails"):
        site = make_site()
        posts_path = os.path.join(site, "data", "posts.json")
        before = read_bytes(posts_path)
        real_replace = bf.os.replace

        def refuse(src, dst):
            raise OSError("rename refused")

        bf.os.replace = refuse
        try:
            try:
                bf.write_atomic(bf.Path(posts_path), "{}\n")
                propagated = False
            except OSError:
                propagated = True
        finally:
            bf.os.replace = real_replace
        eq([propagated, os.listdir(os.path.join(site, "data")), read_bytes(posts_path) == before], [True, ["posts.json"], True],
           "the error propagates, no temporary file is left, and posts.json is as it was")

    # ── What a build refuses in the archive, and what it says ─────────────────
    def problem_lines(err):
        return [line for line in err.splitlines() if not line.startswith("build-feed: data/posts.json has ")]

    with section("a build refuses a repeated id and posts out of (date, id) order, with one line each"):
        posts = ARCHIVE["posts"]
        newer_first = next(i for i in range(1, len(posts)) if posts[i]["date"] != posts[i - 1]["date"])
        shared = next(i for i in range(1, len(posts)) if posts[i]["date"] == posts[i - 1]["date"])
        eq(posts[shared - 1]["id"] > posts[shared]["id"], True, "the archive holds a shared date, ids descending")

        def repeat_fourth(doc):
            doc["posts"].insert(4, copy.deepcopy(doc["posts"][3]))

        def swap_at(i):
            def change(doc):
                doc["posts"][i - 1], doc["posts"][i] = doc["posts"][i], doc["posts"][i - 1]
            return change

        order_line = "build-feed: posts[%d] is out of order: posts sort by (date, id), newest first"
        for change, lines, what in (
            (repeat_fourth, ["build-feed: posts[4] (%s) repeats an earlier id" % posts[3]["id"]], "a repeated id, still in order"),
            (swap_at(newer_first), [order_line % newer_first], "an older date before a newer one"),
            (swap_at(shared), [order_line % shared], "ascending ids on a shared date, which a date-only order check passes"),
        ):
            site = make_site()
            doc = json.loads(ARCHIVE_TEXT)
            change(doc)
            dump_json(os.path.join(site, "data", "posts.json"), doc)
            for args in ((), ("--check",)):
                code, out, err = run(site, *args)
                eq([code, problem_lines(err)], [1, lines], "%s: build-feed.py %s exits 1 with exactly that line" % (what, " ".join(args)))
            eq([read_bytes(os.path.join(site, "feed.xml")) == REAL["feed.xml"], read_bytes(os.path.join(site, "index.html")) == REAL["index.html"]],
               [True, True], what + ": feed.xml and index.html are untouched")

    with section("a failing build names positions, ids, fields and codes, never story text"):
        site = make_site()
        doc = json.loads(ARCHIVE_TEXT)
        broken = doc["posts"]
        broken[0]["title"] = "MARKER-TITLE " + "x" * 200
        broken[1]["summary"] = "MARKER-SUMMARY with a " + chr(0x2014) + " dash"
        broken[2]["body"] = ["MARKER-BODY with ghp_marker inside"]
        broken[3]["links"] = [{"label": "MARKER-LABEL" + chr(7), "url": "ftp://marker-url-path.example/"}]
        broken[4]["tags"] = ["marker-tag", "marker-tag"]
        broken[5]["site"] = "MARKER-SITE"
        broken[6]["kind"] = "MARKER-KIND"
        broken[7]["id"] = "MARKER-ID"
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        shape = re.compile(r"build-feed: (posts\[\d+\]( \([a-z0-9-]+\))? ([a-z]+(\[\d+\])?(\.[a-z]+)? [a-z-]+"
                           r"|repeats an earlier id)|posts\[\d+\] is out of order: posts sort by \(date, id\), newest first"
                           r"|data/posts\.json has \d+ problem\(s\))")
        secrets = MARKERS + ["MARKER-SITE", "MARKER-KIND", "MARKER-ID", "ghp_marker", "x" * 20]
        for args in ((), ("--check",)):
            what = "build-feed.py " + " ".join(args)
            code, out, err = run(site, *args)
            eq(code, 1, what + " exits 1")
            eq([m for m in secrets if m in out + err], [], what + ": no story text in stdout or stderr")
            eq([line for line in err.splitlines() if not shape.fullmatch(line)], [], what + ": every line is a position, an id, a field and a code")
            eq({int(n) for n in re.findall(r"posts\[(\d+)\]", err)} >= set(range(8)), True, what + ": each broken post is reported")

    with section("the stamp shows each story as the page does, through read mode"):
        doc = json.loads(ARCHIVE_TEXT)
        doc["posts"][0]["title"] = "  " + doc["posts"][0]["title"] + "\n"
        doc["posts"][0]["summary"] = " " + doc["posts"][0]["summary"] + " "
        doc["posts"][0]["body"] = ["\n" + par + " " for par in doc["posts"][0]["body"]]
        site = make_site()
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        eq(run(site)[0], 0, "a padded title, summary and body build, since archive mode trims them")
        eq(read_bytes(os.path.join(site, "index.html")) == REAL["index.html"], True,
           "and the stamp shows them trimmed, as normalizePost does: index.html is byte-identical")
        eq(run(site, "--check")[0], 0, "--check agrees")

        doc = json.loads(ARCHIVE_TEXT)
        target = next(i for i, p in enumerate(doc["posts"]) if p["links"])
        padded = {"label": "  Padded label ", "url": "https://dispatch.neorgon.com/padded", "rel": "me"}
        doc["posts"][target]["links"].insert(0, padded)
        eq([bf.validate_post(doc["posts"][target], "archive")["post"]["links"][0], bf.validate_post(doc["posts"][target], "read")["post"]["links"][0]],
           [{"label": "Padded label", "url": padded["url"]}, {"label": "  Padded label ", "url": padded["url"]}],
           "archive mode trims the label; read mode, like the page, keeps it as written")
        site = make_site()
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        eq(run(site)[0], 0, "a plain run builds")
        index = read_text(os.path.join(site, "index.html"))
        eq(['rel="noopener noreferrer">  Padded label  ↗</a>' in index, 'rel="noopener noreferrer">Padded label ↗</a>' in index],
           [True, False], "the stamp carries the label as the page renders it, padding and all")
        eq(run(site, "--check")[0], 0, "--check agrees")

        doc = json.loads(ARCHIVE_TEXT)
        doc["posts"][target]["links"] = [{"label": '<b>&"quoted"</b>', "url": "https://dispatch.neorgon.com/?a=1&b='x'"}]
        site = make_site()
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        eq(run(site)[0], 0, "a url with & and ' in its query, and a label holding markup, build")
        index = read_text(os.path.join(site, "index.html"))
        eq(["href=\"https://dispatch.neorgon.com/?a=1&amp;b='x'\"" in index,
            ">&lt;b&gt;&amp;&quot;quoted&quot;&lt;/b&gt; ↗</a>" in index, '<b>&"quoted"</b>' in index],
           [True, True, False], "and both are stamped as escaped text")

        doc = json.loads(ARCHIVE_TEXT)
        doc["posts"][target]["links"] = [{"label": "Markup", "url": 'https://dispatch.neorgon.com/"><script>stamp()</script>'}]
        site = make_site()
        dump_json(os.path.join(site, "data", "posts.json"), doc)
        code, out, err = run(site)
        eq([code, "links[0].url format" in err, "stamp()" in out + err], [1, True, False],
           "a url holding markup is refused by the grammar before anything is stamped, and not echoed")
        eq([read_bytes(os.path.join(site, "index.html")) == REAL["index.html"], read_bytes(os.path.join(site, "feed.xml")) == REAL["feed.xml"]],
           [True, True], "index.html and feed.xml are untouched")

    # ── --selftest can fail ───────────────────────────────────────────────────
    with section("--selftest exits 1 on any mismatch: ok, problems, their order, external, the post and its key order"):
        def archive_expect(doc, test):
            return next(v["expect"]["archive"] for v in doc["vectors"] if test(v["expect"]["archive"]))

        def swap_code(doc):
            want = archive_expect(doc, lambda e: len(e["problems"]) == 1 and e["problems"][0]["code"] != "token")
            want["problems"][0]["code"] = "token"

        def reverse_problems(doc):
            archive_expect(doc, lambda e: len(e["problems"]) >= 2)["problems"].reverse()

        def flip_external(doc):
            want = archive_expect(doc, lambda e: e["ok"])
            want["external"] = not want["external"]

        def change_post(doc):
            archive_expect(doc, lambda e: e["ok"])["post"]["title"] += " changed"

        def reorder_post(doc):
            want = archive_expect(doc, lambda e: e["ok"])
            want["post"] = dict(reversed(list(want["post"].items())))

        for rel, corrupt, what in (
            ("tests/post-vectors.json", lambda d: d["vectors"][0]["expect"]["archive"].update(ok=False), "post vector's ok"),
            ("tests/post-vectors.json", swap_code, "post vector's problem code"),
            ("tests/post-vectors.json", reverse_problems, "post vector's problem order"),
            ("tests/post-vectors.json", flip_external, "post vector's external"),
            ("tests/post-vectors.json", change_post, "post vector's normalized post"),
            ("tests/post-vectors.json", reorder_post, "post vector's normalized key order"),
            ("tests/post-vectors.json", lambda d: d["rules"].update(trim=d["rules"]["trim"][1:]), "the pinned trim set"),
            ("tests/hash-vectors.json", lambda d: d["vectors"][0].update(sha256="0" * 64), "a hash vector"),
            ("tests/hash-vectors.json", lambda d: d["vectors"][-1].update(error=False, canonical="", sha256=""), "a refusal"),
        ):
            site = make_site()
            path = os.path.join(site, rel)
            doc = json.loads(read_text(path))
            corrupt(doc)
            # ASCII escapes, as the vector files are written: a vector holds a
            # lone surrogate on purpose, and UTF-8 has no form for one.
            write_text(path, json.dumps(doc, indent=2) + "\n")
            code, out, err = run(site, "--selftest")
            eq([code, "selftest mismatch" in err, "selftest failed: 1 mismatch(es)" in err], [1, True, True],
               "a corrupted %s fails the selftest, as exactly one mismatch" % what)
finally:
    for path in temp_dirs:
        shutil.rmtree(path, ignore_errors=True)

with section("this tree was never written"):
    for rel, content in REAL.items():
        eq(read_bytes(os.path.join(ROOT, rel)) == content, True, rel + " is unchanged")

print("\n%d of %d checks failed" % (failed, checks) if failed else "\nall %d checks passed" % checks)
sys.exit(1 if failed else 0)
