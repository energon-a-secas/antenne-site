#!/usr/bin/env python3
"""scripts/publish-approved.py run, the publish workflow's one job
(docs/plans/2026-09-15-antenne-desk.md section 6.2), plus the Makefile's owner
steps and scripts/desk_smoke.py --dry-run. Run with: make validate

Every run is a subprocess in a throwaway git repo: a bare origin, and a clone
holding copies of the scripts and the archive. A fake Convex site that checks
every signature and a fake GitHub API stand in for the network, each an
http.server in a thread. HOME and git's global config point into the temp
directory, so nothing reads the operator's key, git identity or signing
setup, and nothing reaches GitHub or a deployment. Story text is marked, and
no marker may reach stdout or stderr on any run.
"""

import base64
import contextlib
import hashlib
import hmac
import http.server
import importlib.util
import io
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
COPIED = ["scripts/publish-approved.py", "scripts/build-feed.py", "scripts/antenne_sign.py", "data/posts.json", "feed.xml",
          "index.html", ".gitignore"]
MARK = "SECRET-TEXT"
SECRET = base64.b64encode(hashlib.sha256(b"publish-approved test key").digest()).decode("ascii")
KEY = "gh:" + SECRET
BOT = "antenne-publisher[bot]"
BOT_ID = 4242
RUN_URL = "https://github.com/energon-a-secas/antenne-site/actions/runs/77/attempts/1"
PAGES = "/repos/energon-a-secas/antenne-site/pages/builds"
GUARDED = ["data/posts.json", "feed.xml", "index.html"]

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


_spec = importlib.util.spec_from_file_location("build_feed", os.path.join(ROOT, "scripts", "build-feed.py"))
FEED = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(FEED)
ARCHIVE = json.load(open(os.path.join(ROOT, "data", "posts.json"), encoding="utf-8"))["posts"]


def raw_story(slug, **over):
    post = {"id": "2026-09-15-%s" % slug, "date": "2026-09-15", "kind": "feature", "site": "dispatch-site",
            "title": "A title %s" % MARK, "summary": "A summary %s." % MARK, "body": ["A paragraph %s." % MARK],
            "links": [{"label": "Desk", "url": "https://antenne.neorgon.com/desk.html"}], "tags": ["desk"]}
    post.update(over)
    return post


def story(slug, **over):
    """A post as the desk backend stores it: normalized in desk mode."""
    result = FEED.validate_post(raw_story(slug, **over), "desk")
    assert result["ok"], result["problems"]
    return result["post"]


def claimed(post, approved_hash=None):
    return {"storyId": post["id"], "post": post, "approvedHash": approved_hash or FEED.content_hash(post)}


def serve(handler_class):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_class)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


class Repo:
    """A bare origin and a clone of it holding the files publish-approved.py touches."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="publish-approved-test-")
        temp_dirs.append(self.tmp)
        os.makedirs(os.path.join(self.tmp, "home"))
        config = os.path.join(self.tmp, "gitconfig")
        open(config, "w").close()
        self.env = {"PATH": os.environ.get("PATH", ""), "HOME": os.path.join(self.tmp, "home"), "GIT_CONFIG_GLOBAL": config,
                    "GIT_CONFIG_NOSYSTEM": "1", "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1"}
        self.origin = os.path.join(self.tmp, "origin.git")
        self.site = os.path.join(self.tmp, "site")
        self.git("init", "-q", "--bare", "-b", "main", self.origin, cwd=self.tmp)
        self.git("init", "-q", "-b", "main", self.site, cwd=self.tmp)
        for rel in COPIED:
            os.makedirs(os.path.dirname(os.path.join(self.site, rel)), exist_ok=True)
            shutil.copyfile(os.path.join(ROOT, rel), os.path.join(self.site, rel))
        self.git("add", "-A")
        self.git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "initial")
        self.git("remote", "add", "origin", self.origin)
        self.git("push", "-q", "origin", "main")
        self.initial = self.origin_main()
        self.reject(0)

    def git(self, *args, cwd=None):
        proc = subprocess.run(["git", *args], cwd=cwd or self.site, env=self.env, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError("git %s failed: %s" % (args[0], proc.stderr))
        return proc.stdout

    def origin_main(self):
        return self.git("--git-dir", self.origin, "rev-parse", "main").strip()

    def reject(self, times):
        """A pre-receive hook on origin that counts pushes and refuses the first `times` of them."""
        count, limit = os.path.join(self.tmp, "attempts"), os.path.join(self.tmp, "reject")
        with open(limit, "w") as fh:
            fh.write(str(times))
        hook = os.path.join(self.origin, "hooks", "pre-receive")
        with open(hook, "w") as fh:
            fh.write('#!/bin/sh\nn=$(( $(cat "%s" 2>/dev/null || echo 0) + 1 ))\necho "$n" > "%s"\n[ "$n" -gt "$(cat "%s")" ]\n'
                     % (count, count, limit))
        os.chmod(hook, 0o755)

    def attempts(self):
        path = os.path.join(self.tmp, "attempts")
        return int(open(path).read()) if os.path.exists(path) else 0

    def stage(self):
        path = os.path.join(self.tmp, "output")
        return open(path).read() if os.path.exists(path) else ""


class Convex:
    """The desk backend's /publish/* routes: checks each signature, records each call, answers as told."""

    def __init__(self, stories, run_id="run1", refuse=(), claim_doc=None):
        convex = self
        self.calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                key_id, ts = self.headers.get("X-Antenne-Key", ""), self.headers.get("X-Antenne-Timestamp", "")
                want = base64.b64encode(hmac.new(base64.b64decode(SECRET), ("%s.%s.%s." % (key_id, ts, self.path)).encode() + raw,
                                                 hashlib.sha256).digest()).decode()
                verified = key_id == "gh" and ts.isdigit() and abs(int(ts) - time.time()) <= 300 and \
                    hmac.compare_digest(want, self.headers.get("X-Antenne-Signature", ""))
                body = json.loads(raw.decode("utf-8"))
                convex.calls.append({"path": self.path, "body": body, "verified": verified})
                if not verified:
                    status, doc = 401, {"ok": False, "code": "unauthorized"}
                elif self.path in refuse:
                    status, doc = 400, {"ok": False, "code": "status", "message": "refused"}
                elif self.path == "/publish/claim":
                    status, doc = 200, claim_doc or {"ok": True, "runId": run_id if stories else None, "stories": stories}
                elif self.path == "/publish/release":
                    status, doc = 200, {"ok": True, "released": len(stories)}
                else:
                    status, doc = 200, {"ok": True}
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server, self.url = serve(Handler)

    @property
    def paths(self):
        return [c["path"] for c in self.calls]

    def body(self, path):
        return [c["body"] for c in self.calls if c["path"] == path]


class GitHub:
    """The API: the bot's user id, and Pages builds. mode built, errored, kick (an older build until one is
    requested) or never (only the older build). user replaces the bot's user answer; redirect answers it with
    a 302 to that URL instead."""

    def __init__(self, repo, mode="built", user=None, redirect=None):
        github = self
        self.calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def answer(self, status, doc):
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                github.calls.append(("GET", self.path, self.headers.get("Authorization")))
                if self.path == "/users/antenne-publisher%5Bbot%5D" and redirect:
                    self.send_response(302)
                    self.send_header("Location", redirect)
                    self.send_header("Content-Length", "0")
                    return self.end_headers()
                if self.path == "/users/antenne-publisher%5Bbot%5D":
                    return self.answer(200, {"login": BOT, "id": BOT_ID} if user is None else user)
                if self.path == PAGES + "/latest":
                    kicked = any(c[0] == "POST" for c in github.calls)
                    commit = repo.initial if mode == "never" or (mode == "kick" and not kicked) else repo.origin_main()
                    return self.answer(200, {"status": "errored" if mode == "errored" else "built", "commit": commit})
                self.answer(404, {"message": "Not Found"})

            def do_POST(self):
                github.calls.append(("POST", self.path, self.headers.get("Authorization")))
                self.answer(201 if self.path == PAGES else 404, {"status": "queued"})

            def log_message(self, *args):
                pass

        self.server, self.url = serve(Handler)

    def count(self, method, path):
        return len([c for c in self.calls if c[0] == method and c[1] == path])


def run(repo, convex, github, run_id="run1", dry=False, env=None, args=("run",)):
    full = dict(repo.env, ANTENNE_CONVEX_SITE=convex.url, ANTENNE_KEY=KEY, RUN_ID=run_id, DRY_RUN="true" if dry else "false",
                GH_RUN_ID="77", GH_RUN_URL=RUN_URL, APP_TOKEN="app-token-for-tests", GITHUB_TOKEN="github-token-for-tests",
                ANTENNE_GITHUB_API=github.url, ANTENNE_PAGES_POLL_S="0.05", ANTENNE_PAGES_KICK_S="0.4",
                ANTENNE_PAGES_WAIT_S="5", GITHUB_OUTPUT=os.path.join(repo.tmp, "output"))
    full.update(env or {})
    proc = subprocess.run([sys.executable, os.path.join(repo.site, "scripts", "publish-approved.py"), *args], cwd=repo.site,
                          env=full, capture_output=True, text=True, timeout=180)
    outputs.append(proc.stdout + proc.stderr)
    lines = proc.stdout.strip().splitlines()
    try:
        summary = json.loads(lines[-1]) if lines else None
    except ValueError:
        summary = lines[-1]
    return proc.returncode, summary, proc.stdout, proc.stderr


def world(stories, mode="built", refuse=(), reject=0, claim_doc=None, user=None, redirect=None):
    repo = Repo()
    repo.reject(reject)
    return repo, Convex(stories, refuse=refuse, claim_doc=claim_doc), GitHub(repo, mode, user=user, redirect=redirect)


def close(*servers):
    for s in servers:
        s.server.shutdown()
        s.server.server_close()


def origin_file(repo, rel, rev="main"):
    return repo.git("--git-dir", repo.origin, "show", "%s:%s" % (rev, rel))


def origin_ids(repo):
    return [p["id"] for p in json.loads(origin_file(repo, "data/posts.json"))["posts"]]


def human_commit(repo, name, edit):
    """Another clone of origin commits edit(clone) as someone else and pushes it, so main moves under the run's checkout."""
    path = os.path.join(repo.tmp, name)
    repo.git("clone", "-q", repo.origin, path, cwd=repo.tmp)
    edit(path)
    repo.git("add", "-A", cwd=path)
    repo.git("-c", "user.name=human", "-c", "user.email=human@example.invalid", "commit", "-q", "-m", "a human commit", cwd=path)
    repo.git("push", "-q", "origin", "main", cwd=path)
    return repo.git("rev-parse", "HEAD", cwd=path).strip()


def is_ancestor(repo, sha, rev="main"):
    return subprocess.run(["git", "--git-dir", repo.origin, "merge-base", "--is-ancestor", sha, rev], env=repo.env,
                          capture_output=True).returncode == 0


# Stand-ins that record which of the step's credentials each subprocess inherited: a git on PATH, and a
# sitecustomize every python3 imports at startup. Names only, never a value.
GIT_PROBE = """#!/bin/sh
held=""
for name in ANTENNE_KEY APP_TOKEN GITHUB_TOKEN; do
  eval "isset=\\${$name+x}"
  [ -n "$isset" ] && held="$held $name"
done
sub=""; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -c) skip=1;; -*) ;; *) sub="$a"; break;; esac
done
echo "git $sub:$held" >> "$PROBE_LOG"
exec "%s" "$@"
"""
PY_PROBE = """import atexit, os, sys
_held = [n for n in ("ANTENNE_KEY", "APP_TOKEN", "GITHUB_TOKEN") if n in os.environ]
def _record():
    flag = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("--") else ""
    with open(os.environ["PROBE_LOG"], "a") as fh:
        fh.write("python %s %s:%s\\n" % (os.path.basename(sys.argv[0]), flag, " ".join(_held)))
if os.environ.get("PROBE_LOG"):
    atexit.register(_record)
"""


REAL = {rel: open(os.path.join(ROOT, rel), "rb").read() for rel in ("data/posts.json", "feed.xml", "index.html", "Makefile")}

try:
    with section("nothing to publish: one claim, no git, no Pages, exit 0"):
        repo, cx, gh = world([])
        code, summary, out, _ = run(repo, cx, gh, run_id="")
        eq([code, out.strip(), cx.paths, gh.calls, repo.origin_main() == repo.initial], [0, "nothing to publish", ["/publish/claim"], [], True],
           "prints nothing to publish and stops")
        eq([cx.calls[0]["body"], cx.calls[0]["verified"]], [{"runId": None, "ghRunId": "77", "runUrl": RUN_URL, "dryRun": False}, True],
           "the claim is signed by the gh key, with runId null for a push, the workflow run, and dryRun false")
        close(cx, gh)

    with section("one approved story: merged, built, committed as antenne-publisher[bot], pushed, Pages waited for"):
        post = story("publish-one")
        repo, cx, gh = world([claimed(post)])
        code, summary, _, _ = run(repo, cx, gh)
        sha = repo.origin_main()
        eq([code, cx.paths, all(c["verified"] for c in cx.calls)], [0, ["/publish/claim", "/publish/pushed", "/publish/built"], True],
           "claim, pushed and built, each signed")
        eq([cx.body("/publish/claim")[0]["runId"], cx.body("/publish/pushed"), cx.body("/publish/built")],
           ["run1", [{"runId": "run1", "sha": sha, "noChange": False}], [{"runId": "run1", "sha": sha, "pagesStatus": "built"}]],
           "the run id Convex dispatched, then the pushed sha twice")
        who = repo.git("--git-dir", repo.origin, "log", "-1", "--format=%an|%ae|%cn|%ce", "main").strip().split("|")
        email = "%d+%s@users.noreply.github.com" % (BOT_ID, BOT)
        eq(who, [BOT, email, BOT, email], "author and committer are the App bot, its email from GET /users/antenne-publisher[bot]")
        message = repo.git("--git-dir", repo.origin, "log", "-1", "--format=%B", "main")
        eq([message.splitlines()[0], post["id"] in message, MARK in message], ["feat(feed): publish 1 approved stories", True, False],
           "the message names the count, with the ids in the body and no story text")
        changed = repo.git("--git-dir", repo.origin, "diff", "--name-only", repo.initial, "main").split()
        eq(sorted(changed), GUARDED, "the commit changes data/posts.json, feed.xml and index.html only")
        eq(post["id"] in [p["id"] for p in json.loads(origin_file(repo, "data/posts.json"))["posts"]], True, "the story is in the archive on main")
        eq([summary["added"], summary["claimed"], summary["pushAttempts"], summary["sha"], repo.attempts()], [[post["id"]], 1, 1, sha, 1],
           "the summary: ids and counts")
        eq([gh.count("GET", PAGES + "/latest") >= 1, gh.count("POST", PAGES), sorted({c[2] for c in gh.calls})],
           [True, 0, ["Bearer github-token-for-tests"]], "Pages polled with GITHUB_TOKEN, no build requested")
        close(cx, gh)

    with section("a story whose hash is not its approvedHash is a conflict; the rest publish"):
        good, bad = story("good"), story("tampered")
        repo, cx, gh = world([claimed(bad, "0" * 64), claimed(good)])
        code, summary, _, _ = run(repo, cx, gh)
        ids = [p["id"] for p in json.loads(origin_file(repo, "data/posts.json"))["posts"]]
        eq([code, cx.paths, cx.body("/publish/conflict")], [0, ["/publish/claim", "/publish/conflict", "/publish/pushed", "/publish/built"],
                                                            [{"runId": "run1", "storyIds": [bad["id"]]}]], "the mismatch is reported as a conflict")
        eq([good["id"] in ids, bad["id"] in ids, summary["conflict"]], [True, False, [bad["id"]]], "and never merged")
        close(cx, gh)

    with section("merge conflict and invalid are reported; nothing added is noChange with HEAD, then built"):
        existing = FEED.validate_post(ARCHIVE[0], "archive")["post"]
        changed_post = dict(existing, title=existing["title"] + " changed " + MARK)
        invalid = raw_story("invalid-kind", kind="bogus")
        repo, cx, gh = world([claimed(existing), claimed(changed_post), claimed(invalid)])
        code, summary, _, _ = run(repo, cx, gh)
        eq([code, cx.paths], [0, ["/publish/claim", "/publish/conflict", "/publish/pushed", "/publish/built"]], "conflict, pushed, built")
        eq(cx.body("/publish/conflict"), [{"runId": "run1", "storyIds": [existing["id"], invalid["id"]]}],
           "the id holding different content and the invalid story are conflicts; the identical one is not")
        eq([cx.body("/publish/pushed"), repo.origin_main(), repo.attempts(), summary["identical"], summary["noChange"]],
           [[{"runId": "run1", "sha": repo.initial, "noChange": True}], repo.initial, 0, [existing["id"]], True],
           "nothing added: HEAD with noChange, and nothing pushed")
        close(cx, gh)

    with section("the diff guard: a fourth changed path releases and fails before any push"):
        for what, touch in (("an untracked file", "stray.txt"), ("a tracked file", ".gitignore")):
            repo, cx, gh = world([claimed(story("guard"))])
            with open(os.path.join(repo.site, touch), "a") as fh:
                fh.write("\nx\n")
            code, summary, _, err = run(repo, cx, gh)
            eq([code, cx.paths, cx.body("/publish/release"), repo.attempts(), repo.origin_main() == repo.initial, repo.stage()],
               [1, ["/publish/claim", "/publish/release"], [{"runId": "run1", "reason": "diff-guard"}], 0, True, "stage=diff-guard\n"],
               "%s: exit 1, released with reason diff-guard, nothing pushed" % what)
            eq(["failed at diff-guard" in err, touch in err], [True, False], "stderr names the stage and counts paths, never a path")
            close(cx, gh)

    with section("a dry run merges and builds, prints counts and the diff stat, releases with dry-run, needs no push token"):
        post = story("dry")
        repo, cx, gh = world([claimed(post)])
        code, summary, _, _ = run(repo, cx, gh, dry=True, env={"APP_TOKEN": "", "GITHUB_TOKEN": ""})
        eq([code, cx.paths, cx.body("/publish/release"), gh.calls, repo.origin_main() == repo.initial, repo.attempts()],
           [0, ["/publish/claim", "/publish/release"], [{"runId": "run1", "reason": "dry-run"}], [], True, 0], "released as dry-run, no push, no API")
        eq([summary["dryRun"], summary["added"], any("data/posts.json" in line for line in summary["diffStat"]),
            all(any(g in line for g in GUARDED) or "changed" in line for line in summary["diffStat"])],
           [True, [post["id"]], True, True], "the summary: the ids it would add and the diff stat of the three files")
        eq(cx.body("/publish/claim"), [{"runId": "run1", "ghRunId": "77", "runUrl": RUN_URL, "dryRun": True}],
           "the claim says dryRun true, so a run it creates has trigger dryrun and a failed run stays paused")
        close(cx, gh)

    with section("a rejected push: fetch, reset, merge again, at most 3 retries; then release and fail"):
        repo, cx, gh = world([claimed(story("rejected"))], reject=99)
        code, summary, _, _ = run(repo, cx, gh)
        eq([code, repo.attempts(), cx.paths, cx.body("/publish/release"), repo.origin_main() == repo.initial, summary["pushAttempts"]],
           [1, 4, ["/publish/claim", "/publish/release"], [{"runId": "run1", "reason": "push"}], True, 4],
           "4 pushes (one and 3 retries), then released with reason push and exit 1")
        close(cx, gh)
        repo, cx, gh = world([claimed(story("second-try"))], reject=2)
        code, summary, _, _ = run(repo, cx, gh)
        eq([code, repo.attempts(), cx.paths, summary["pushAttempts"], repo.origin_main() != repo.initial],
           [0, 3, ["/publish/claim", "/publish/pushed", "/publish/built"], 3, True], "rejected twice, then accepted: published on the third push")
        close(cx, gh)

    with section("after a push nothing is released: a Pages error or a refused report still fails, exit 1"):
        repo, cx, gh = world([claimed(story("pages-error"))], mode="errored")
        code, summary, _, err = run(repo, cx, gh)
        eq([code, cx.paths, repo.stage(), repo.origin_main() != repo.initial, "the Pages build errored" in err],
           [1, ["/publish/claim", "/publish/pushed"], "stage=pages\n", True, True], "Pages errored: exit 1 at once, no release, no built")
        close(cx, gh)
        repo, cx, gh = world([claimed(story("pushed-refused"))], refuse=("/publish/pushed",))
        code, summary, _, err = run(repo, cx, gh)
        eq([code, cx.paths, "nothing is released" in err, repo.stage()], [1, ["/publish/claim", "/publish/pushed"], True, "stage=pushed\n"],
           "/publish/pushed refused after the push landed: exit 1, and still no release")
        close(cx, gh)

    with section("no Pages build of the commit after the kick time: one POST /pages/builds, then built"):
        repo, cx, gh = world([claimed(story("kick"))], mode="kick")
        code, summary, _, _ = run(repo, cx, gh)
        eq([code, gh.count("POST", PAGES), cx.paths[-1]], [0, 1, "/publish/built"], "exactly one build requested")
        close(cx, gh)

    with section("failures before a push release; a refused claim has nothing to release; a bad environment is exit 2"):
        repo, cx, gh = world([claimed(story("merge-fails"))])
        with open(os.path.join(repo.site, "data", "posts.json"), "w") as fh:
            fh.write("{not json")
        code, _, _, _ = run(repo, cx, gh)
        eq([code, cx.body("/publish/release"), repo.stage()], [1, [{"runId": "run1", "reason": "merge"}], "stage=merge\n"],
           "an archive build-feed.py cannot read: released with reason merge, exit 1")
        close(cx, gh)
        repo, cx, gh = world([claimed(story("wrong-key"))])
        wrong = "gh:" + base64.b64encode(b"k" * 32).decode()
        code, _, _, err = run(repo, cx, gh, env={"ANTENNE_KEY": wrong})
        eq([code, cx.paths, repo.stage(), "401" in err], [1, ["/publish/claim"], "stage=claim\n", True],
           "a claim answered 401: exit 1, and no release, since nothing was claimed")
        for what, env, args in (("RUN_ID not an id", {"RUN_ID": "Run 1!"}, ("run",)), ("no ANTENNE_KEY", {"ANTENNE_KEY": ""}, ("run",)),
                                ("a real run without APP_TOKEN", {"APP_TOKEN": ""}, ("run",)), ("the API moved off this machine",
                                {"ANTENNE_GITHUB_API": "https://evil.example"}, ("run",)), ("no command", {}, ()),
                                ("DRY_RUN neither true nor false", {"DRY_RUN": "yes"}, ("run",)),
                                ("GH_RUN_URL not a run page on GitHub", {"GH_RUN_URL": "https://evil.example/o/r/actions/runs/1"}, ("run",)),
                                ("GH_RUN_ID not digits", {"GH_RUN_ID": "12x"}, ("run",))):
            before = len(cx.calls)
            code, _, _, _ = run(repo, cx, gh, env=env, args=args)
            eq([code, len(cx.calls) - before], [2, 0], "%s: exit 2, nothing sent" % what)
        close(cx, gh)

    with section("a claimed story whose id is not its post's id is a conflict, never merged"):
        post = story("original")
        repo, cx, gh = world([{"storyId": "2026-09-15-renamed", "post": post, "approvedHash": FEED.content_hash(post)}])
        code, summary, _, _ = run(repo, cx, gh)
        ids = [p["id"] for p in json.loads(origin_file(repo, "data/posts.json"))["posts"]]
        eq([code, cx.body("/publish/conflict"), post["id"] in ids, summary["noChange"]],
           [0, [{"runId": "run1", "storyIds": ["2026-09-15-renamed"]}], False, True], "the hash matches, the id does not: a conflict")
        close(cx, gh)

    with section("a claim answer of the wrong shape fails at claim; only a claim that named a run is released"):
        post = story("shape")
        for what, doc, released in (("stories without a run id", {"ok": True, "runId": "Bad Id!", "stories": [claimed(post)]}, []),
                                    ("stories that are not a list", {"ok": True, "runId": "run1", "stories": "none"}, []),
                                    ("a story with no approvedHash", {"ok": True, "runId": "run1", "stories": [{"storyId": post["id"], "post": post}]},
                                     [{"runId": "run1", "reason": "claim"}]),
                                    ("a story id that is not an id", {"ok": True, "runId": "run1", "stories": [dict(claimed(post), storyId="Not An Id")]},
                                     [{"runId": "run1", "reason": "claim"}])):
            repo, cx, gh = world([], claim_doc=doc)
            code, _, _, _ = run(repo, cx, gh)
            eq([code, cx.body("/publish/release"), repo.stage(), repo.attempts(), gh.calls], [1, released, "stage=claim\n", 0, []],
               "%s: exit 1 at claim, nothing merged or pushed" % what)
            close(cx, gh)

    with section("the bot's user id must be a positive integer from a 200, and a redirect never takes GITHUB_TOKEN elsewhere"):
        for what, user in (("an id that is a string", {"login": BOT, "id": str(BOT_ID)}), ("an id that is true", {"login": BOT, "id": True}),
                           ("an id of 0", {"login": BOT, "id": 0})):
            repo, cx, gh = world([claimed(story("bot"))], user=user)
            code, _, _, _ = run(repo, cx, gh)
            eq([code, cx.body("/publish/release"), repo.stage(), repo.attempts()], [1, [{"runId": "run1", "reason": "bot-id"}], "stage=bot-id\n", 0],
               "%s: released with reason bot-id, nothing pushed" % what)
            close(cx, gh)
        stolen = []

        class Elsewhere(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                stolen.append(self.headers.get("Authorization"))
                data = json.dumps({"login": BOT, "id": BOT_ID}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        elsewhere, elsewhere_url = serve(Elsewhere)
        repo, cx, gh = world([claimed(story("redirect"))], redirect=elsewhere_url + "/users/antenne-publisher%5Bbot%5D")
        code, _, _, err = run(repo, cx, gh)
        eq([code, stolen, repo.stage(), "answered 302" in err, repo.attempts()], [1, [], "stage=bot-id\n", True, 0],
           "a 302 is an answer: not followed, so the token went nowhere else")
        elsewhere.shutdown()
        elsewhere.server_close()
        close(cx, gh)

    with section("a temp directory inside the repo fails the merge before build-feed.py runs"):
        repo, cx, gh = world([claimed(story("inside"))])
        inside = os.path.join(repo.site, "tmp-inside")
        os.makedirs(inside)
        code, _, _, err = run(repo, cx, gh, env={"TMPDIR": inside})
        eq([code, cx.body("/publish/release"), repo.stage(), "the temp directory is inside the repo" in err, os.listdir(inside)],
           [1, [{"runId": "run1", "reason": "merge"}], "stage=merge\n", True, []], "released with reason merge, and nothing left inside")
        close(cx, gh)

    with section("Pages never building the commit: one build requested, then a failure at pages after the wait, and no release"):
        repo, cx, gh = world([claimed(story("never"))], mode="never")
        code, _, _, err = run(repo, cx, gh, env={"ANTENNE_PAGES_WAIT_S": "1.2"})
        eq([code, cx.paths, gh.count("POST", PAGES), repo.stage(), "no Pages build of the commit in time" in err, repo.origin_main() != repo.initial],
           [1, ["/publish/claim", "/publish/pushed"], 1, "stage=pages\n", True, True], "exit 1 at pages, with the commit on main and its claim kept")
        close(cx, gh)

    with section("another commit lands on main first: the plain push is refused, and the run resets, merges again and publishes on top"):
        post = story("race")
        repo, cx, gh = world([claimed(post)])

        def note(clone):
            with open(os.path.join(clone, "NOTE.txt"), "w") as fh:
                fh.write("a human note\n")

        human = human_commit(repo, "other", note)
        code, summary, _, _ = run(repo, cx, gh)
        head = repo.origin_main()
        eq([code, summary["pushAttempts"], is_ancestor(repo, human), post["id"] in origin_ids(repo)], [0, 2, True, True],
           "exit 0 on the second push, with the human commit kept under the story")
        eq([cx.paths, cx.body("/publish/pushed")], [["/publish/claim", "/publish/pushed", "/publish/built"],
                                                    [{"runId": "run1", "sha": head, "noChange": False}]], "pushed reports the new head of main")
        source = open(os.path.join(ROOT, "scripts", "publish-approved.py"), encoding="utf-8").read()
        eq(["--force" in source, '"+HEAD' in source, "+refs/" in source], [False, False, False], "and the script never forces a push")
        close(cx, gh)

    with section("a story sent back as a conflict stays out of every later pass, even once the main it resets to stops colliding"):
        collide, plain = story("collide"), story("plain")
        repo, cx, gh = world([claimed(collide), claimed(plain)])
        other = os.path.join(repo.tmp, "human.json")
        with open(other, "w", encoding="utf-8") as fh:
            json.dump({"stories": [story("collide", title="A human story under the same id %s" % MARK)]}, fh)
        for args in (["--merge", other], []):
            subprocess.run([sys.executable, os.path.join("scripts", "build-feed.py"), *args], cwd=repo.site, env=repo.env, capture_output=True,
                           check=True)
        repo.git("add", "-A")
        repo.git("-c", "user.name=human", "-c", "user.email=human@example.invalid", "commit", "-q", "-m", "a human story")
        repo.git("push", "-q", "origin", "main")

        def unpublish(clone):
            rel = os.path.join(clone, "data", "posts.json")
            doc = json.load(open(rel, encoding="utf-8"))
            doc["posts"] = [p for p in doc["posts"] if p["id"] != collide["id"]]
            with open(rel, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

        removal = human_commit(repo, "other", unpublish)
        code, summary, _, _ = run(repo, cx, gh)
        ids = origin_ids(repo)
        eq([code, cx.body("/publish/conflict"), summary["conflict"], summary["added"], summary["pushAttempts"]],
           [0, [{"runId": "run1", "storyIds": [collide["id"]]}], [collide["id"]], [plain["id"]], 2],
           "the collision is sent back once, and the pass after the reset merges only the other story")
        message = repo.git("--git-dir", repo.origin, "log", "-1", "--format=%B", "main")
        eq([collide["id"] in ids, plain["id"] in ids, is_ancestor(repo, removal), message.splitlines()[0], collide["id"] in message],
           [False, True, True, "feat(feed): publish 1 approved stories", False], "the sent-back story is not on main; the other one and the human commit are")
        close(cx, gh)

    with section("a dry run that fails after its claim releases it as a dry run, so Convex never requeues it as a real publish"):
        repo, cx, gh = world([claimed(story("dry-fails"), "0" * 64)], refuse=("/publish/conflict",))
        code, _, _, _ = run(repo, cx, gh, dry=True, env={"APP_TOKEN": "", "GITHUB_TOKEN": ""})
        eq([code, cx.paths, cx.body("/publish/release"), repo.stage(), gh.calls, repo.origin_main() == repo.initial],
           [1, ["/publish/claim", "/publish/conflict", "/publish/release"], [{"runId": "run1", "reason": "dry-run"}], "stage=conflict\n", [], True],
           "/publish/conflict refused: exit 1, stage conflict for the issue step, released with reason dry-run")
        close(cx, gh)
        repo, cx, gh = world([claimed(story("dry-guard"))])
        with open(os.path.join(repo.site, "stray.txt"), "w") as fh:
            fh.write("x\n")
        code, _, _, _ = run(repo, cx, gh, dry=True, env={"APP_TOKEN": "", "GITHUB_TOKEN": ""})
        eq([code, cx.paths, cx.body("/publish/release"), repo.stage()],
           [1, ["/publish/claim", "/publish/release"], [{"runId": "run1", "reason": "dry-run"}], "stage=diff-guard\n"],
           "the diff guard on a dry run: exit 1 at diff-guard, released with reason dry-run")
        close(cx, gh)

    with section("a dry run whose merge adds nothing goes to step 7: a claim and a dry-run release, no push report, no Pages"):
        existing = FEED.validate_post(ARCHIVE[0], "archive")["post"]
        repo, cx, gh = world([claimed(existing)])
        code, summary, _, _ = run(repo, cx, gh, dry=True, env={"APP_TOKEN": "", "GITHUB_TOKEN": ""})
        eq([code, cx.paths, cx.body("/publish/release"), gh.calls, repo.origin_main() == repo.initial],
           [0, ["/publish/claim", "/publish/release"], [{"runId": "run1", "reason": "dry-run"}], [], True], "released as dry-run, nothing reported pushed")
        eq([summary.get(k) for k in ("identical", "added", "noChange", "sha", "diffStat")], [[existing["id"]], [], False, None, []],
           "the summary: the one identical id, and an empty diff stat")
        close(cx, gh)

    with section("no subprocess inherits ANTENNE_KEY, APP_TOKEN or GITHUB_TOKEN; only git push gets APP_TOKEN"):
        repo, cx, gh = world([claimed(story("env"))], reject=1)
        probe = os.path.join(repo.tmp, "probe")
        os.makedirs(os.path.join(probe, "bin"))
        with open(os.path.join(probe, "bin", "git"), "w") as fh:
            fh.write(GIT_PROBE % shutil.which("git", path=repo.env["PATH"]))
        os.chmod(os.path.join(probe, "bin", "git"), 0o755)
        with open(os.path.join(probe, "sitecustomize.py"), "w") as fh:
            fh.write(PY_PROBE)
        log = os.path.join(probe, "log")
        code, summary, _, _ = run(repo, cx, gh, env={"PATH": os.path.join(probe, "bin") + os.pathsep + repo.env["PATH"], "PYTHONPATH": probe,
                                                     "PROBE_LOG": log})
        seen = [(line.rsplit(":", 1)[0], line.rsplit(":", 1)[1].split()) for line in open(log).read().splitlines()]
        gits = [(what.split(" ", 1)[1], held) for what, held in seen if what.startswith("git ")]
        feeds = [(what.split(" ", 2)[2], held) for what, held in seen if what.startswith("python build-feed.py")]
        eq([code, summary["pushAttempts"], [held for what, held in seen if what.startswith("python publish-approved.py")]],
           [0, 2, [["ANTENNE_KEY", "APP_TOKEN", "GITHUB_TOKEN"]]], "published on the second push; the step itself held all three")
        eq([sorted({flag for flag, _ in feeds}), len(feeds), [f for f in feeds if f[1]]], [["", "--check", "--merge"], 6, []],
           "build-feed.py --merge, the build and --check, twice each: none holds a credential")
        eq([{sub for sub, _ in gits} >= {"add", "commit", "fetch", "push", "reset", "rev-parse", "status"},
            [g for g in gits if g[0] != "push" and g[1]], [held for sub, held in gits if sub == "push"]],
           [True, [], [["APP_TOKEN"], ["APP_TOKEN"]]], "git status, add, commit, fetch and reset hold none; each push holds APP_TOKEN alone")
        close(cx, gh)

    with section("make convex refuses a production selection; the other owner steps run what they say, and -n only prints"):
        tmp = tempfile.mkdtemp(prefix="publish-make-test-")
        temp_dirs.append(tmp)
        shutil.copyfile(os.path.join(ROOT, "Makefile"), os.path.join(tmp, "Makefile"))
        os.makedirs(os.path.join(tmp, "bin"))
        for tool in ("npx", "gh", "python3"):
            path = os.path.join(tmp, "bin", tool)
            with open(path, "w") as fh:
                fh.write('#!/bin/sh\necho "%s $*" >> "%s/calls"\n' % (tool, tmp))
            os.chmod(path, 0o755)
        base = {k: v for k, v in os.environ.items() if not k.startswith("CONVEX_") and not k.startswith("MAKE")}
        base["PATH"] = os.path.join(tmp, "bin") + os.pathsep + base.get("PATH", "")

        def make(*args, env_local=None, env=None):
            local = os.path.join(tmp, ".env.local")
            if os.path.exists(local):
                os.remove(local)
            if env_local is not None:
                with open(local, "w") as fh:
                    fh.write(env_local)
            calls = os.path.join(tmp, "calls")
            if os.path.exists(calls):
                os.remove(calls)
            proc = subprocess.run(["make", "-s", "-C", tmp, *args], env=dict(base, **(env or {})), capture_output=True, text=True)
            made = open(calls).read().splitlines() if os.path.exists(calls) else []
            return proc.returncode, made, proc.stdout, proc.stderr

        wizard = ("# Production, written by scripts/setup-antenne.sh stage 2. Never run npx convex dev here.\n"
                  "CONVEX_DEPLOYMENT=prod:happy-otter-123 # team: energon, project: antenne\n")
        for what, env_local, env in (("the wizard's prod line", wizard, None), ("a quoted, exported prod line", "export CONVEX_DEPLOYMENT='prod:x'\n", None),
                                     ("a prod line a later dev line overrides", wizard + "CONVEX_DEPLOYMENT=dev:y\n", None),
                                     ("a dev .env.local but a prod CONVEX_DEPLOYMENT in the shell", "CONVEX_DEPLOYMENT=dev:y\n", {"CONVEX_DEPLOYMENT": "prod:x"}),
                                     ("a prod deploy key in the shell", None, {"CONVEX_DEPLOY_KEY": "prod:x|%s" % MARK})):
            code, made, out, err = make("convex", env_local=env_local, env=env)
            eq([code != 0, made, err.count("make convex refuses") == 1, MARK in err + out], [True, [], True, False],
               "%s: refused in one sentence, npx never runs, and no key is echoed" % what)
        for what, env_local in (("no .env.local", None), ("a dev deployment", "CONVEX_DEPLOYMENT=dev:happy-otter-123 # team: energon\n")):
            eq(make("convex", env_local=env_local)[:2], (0, ["npx convex dev"]), "%s: npx convex dev runs" % what)
        eq([make("deploy")[:2], make("publish-now")[:2], make("publish-dryrun")[:2], make("status")[:2]],
           [(0, ["npx convex deploy"]), (0, ["gh workflow run publish.yml"]), (0, ["gh workflow run publish.yml -f dry_run=true"]),
            (0, ["python3 scripts/submit-drafts.py --status"])], "deploy, publish-now, publish-dryrun and status run exactly their command")
        code, made, out, _ = make("-n", "publish-dryrun")
        eq([code, made, out.strip()], [0, [], "gh workflow run publish.yml -f dry_run=true"], "make -n publish-dryrun prints it and runs nothing")

    with section("scripts/desk_smoke.py --dry-run lists its checks, runs no npx and needs no key"):
        tmp = tempfile.mkdtemp(prefix="desk-smoke-test-")
        temp_dirs.append(tmp)
        os.makedirs(os.path.join(tmp, "bin"))
        with open(os.path.join(tmp, "bin", "npx"), "w") as fh:
            fh.write('#!/bin/sh\ntouch "%s/ran"\n' % tmp)
        os.chmod(os.path.join(tmp, "bin", "npx"), 0o755)
        env = {k: v for k, v in os.environ.items() if k not in ("ANTENNE_KEY", "ANTENNE_CONVEX_SITE")}
        env.update(HOME=tmp, PATH=os.path.join(tmp, "bin") + os.pathsep + env.get("PATH", ""), PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "desk_smoke.py"), "--dry-run"], env=env, capture_output=True,
                              text=True, timeout=60)
        outputs.append(proc.stdout + proc.stderr)
        eq([proc.returncode, os.path.exists(os.path.join(tmp, "ran")), proc.stdout.count("    check: ") >= 20,
            "403 scope" in proc.stdout, "--identity" in proc.stdout], [0, False, True, True, True], "checks listed, nothing run")

    with section("scripts/desk_smoke.py runs npx --no convex without the shell's deployment selection; it stops when DESK_OWNERS or "
                 "DESK_DENY lists its subject, and echoes no env value or CLI output"):
        tmp = tempfile.mkdtemp(prefix="desk-smoke-guard-test-")
        temp_dirs.append(tmp)
        os.makedirs(os.path.join(tmp, "bin"))
        with open(os.path.join(tmp, "bin", "npx"), "w") as fh:
            fh.write("#!" + sys.executable + "\n" + (
                "import datetime, os, sys\n"
                "args = sys.argv[1:]\n"
                "held = [k for k in ('CONVEX_DEPLOYMENT', 'CONVEX_DEPLOY_KEY', 'CONVEX_DEPLOYMENT_TOKEN') if k in os.environ]\n"
                "open(os.path.join(os.environ['SMOKE_TMP'], 'calls'), 'a').write(' '.join(args[:3]) + '|' + ','.join(held) + '\\n')\n"
                "args = args[1:] if args[:1] == ['--no'] else args\n"
                "now = datetime.datetime.now(datetime.timezone.utc)\n"
                "stamps = ','.join('user_antennesmoke' + (now - datetime.timedelta(seconds=k)).strftime('%Y%m%d%H%M%S') for k in range(60))\n"
                "mode, mark = os.environ['SMOKE_MODE'], os.environ['SMOKE_MARK']\n"
                "if args[:2] == ['convex', 'env']:\n"
                "    name = args[-1]\n"
                "    if name == 'DESK_OWNERS':\n"
                "        print('user_' + mark + ',' + (stamps if mode == 'owner' else 'user_owner'))\n"
                "    elif name == 'DESK_DENY':\n"
                "        print(stamps if mode == 'deny' else '')\n"
                "    sys.exit(0)\n"
                "print('the CLI said ' + mark, file=sys.stderr)\n"
                "sys.exit(1)\n"))
        os.chmod(os.path.join(tmp, "bin", "npx"), 0o755)
        env = {k: v for k, v in os.environ.items() if k not in ("ANTENNE_KEY", "ANTENNE_CONVEX_SITE")}
        env.update(HOME=tmp, PATH=os.path.join(tmp, "bin") + os.pathsep + env.get("PATH", ""), PYTHONDONTWRITEBYTECODE="1", SMOKE_TMP=tmp,
                   SMOKE_MARK=MARK, CONVEX_DEPLOYMENT="prod:vitrina-other-123", CONVEX_DEPLOY_KEY="prod:other|" + MARK,
                   CONVEX_DEPLOYMENT_TOKEN="token-" + MARK)
        for mode, calls, said in (("owner", ["--no convex env|"] * 3, "FAILED: the smoke subject is neither an owner nor denied"),
                                  ("deny", ["--no convex env|"] * 3, "FAILED: the smoke subject is neither an owner nor denied"),
                                  ("none", ["--no convex env|"] * 3 + ["--no convex run|"], "npx convex run desk:me exited 1")):
            if os.path.exists(os.path.join(tmp, "calls")):
                os.remove(os.path.join(tmp, "calls"))
            proc = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "desk_smoke.py")], env=dict(env, SMOKE_MODE=mode),
                                  capture_output=True, text=True, timeout=60)
            outputs.append(proc.stdout + proc.stderr)
            made = open(os.path.join(tmp, "calls")).read().splitlines()
            eq([proc.returncode, made, said in proc.stderr, MARK in proc.stdout + proc.stderr], [1, calls, True, False],
               "%s: npx --no convex with no CONVEX_DEPLOYMENT, _DEPLOY_KEY or _DEPLOYMENT_TOKEN; exit 1 before any further call, "
               "no env value or CLI output echoed" % mode)

    with section("scripts/desk_smoke.py sends its /publish/claim probe only with a local, ci or watch key"):
        _spec = importlib.util.spec_from_file_location("desk_smoke", os.path.join(ROOT, "scripts", "desk_smoke.py"))
        smoke = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(smoke)
        scopes = {"local": ["submit", "status"], "gh": ["publish", "status"]}
        needs = {"/status": "status", "/submit": "submit", "/publish/claim": "publish"}
        sent = []

        class Site(http.server.BaseHTTPRequestHandler):
            """The machine routes as section 5 answers them: 401 for any signature problem, 403 for a scope the key lacks."""

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                key_id, ts, sig = (self.headers.get(h, "") for h in ("X-Antenne-Key", "X-Antenne-Timestamp", "X-Antenne-Signature"))
                sent.append(self.path)
                want = base64.b64encode(hmac.new(base64.b64decode(SECRET), ("%s.%s.%s." % (key_id, ts, self.path)).encode() + raw,
                                                 hashlib.sha256).digest()).decode()
                if key_id not in scopes or not ts.isdigit() or abs(int(ts) - time.time()) > 300 or not hmac.compare_digest(want, sig):
                    status = 401
                else:
                    status = 200 if needs.get(self.path) in scopes[key_id] else 403
                data = json.dumps({"ok": status == 200}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        site, site_url = serve(Site)
        for key_id, claims, count in (("local", 1, 6), ("gh", 0, 5)):
            sent.clear()
            printed, s, failure = io.StringIO(), smoke.Smoke(False), None
            with contextlib.redirect_stdout(printed):
                try:
                    smoke.routes(s, site_url, (key_id, SECRET))
                except smoke.SmokeFailure as err:
                    failure = str(err)
            outputs.append(printed.getvalue())
            eq([failure, sent.count("/publish/claim"), s.checks, "skip POST /publish/claim" in printed.getvalue()], [None, claims, count, not claims],
               "the %s key: %s" % (key_id, "the claim is sent and refused 403" if claims else "no claim is sent, and the skip is said"))
        site.shutdown()
        site.server_close()

    with section("publish.yml keeps what section 6.2 asks for (a text check: no runner or actionlint here)"):
        text = open(os.path.join(ROOT, ".github", "workflows", "publish.yml"), encoding="utf-8").read()
        raw_lines = text.splitlines()
        lines = [line.strip() for line in raw_lines]
        uses = [line for line in lines if line.startswith(("- uses:", "uses:"))]
        eq([len(uses), all(re.fullmatch(r"(?:- )?uses: actions/[a-z-]+@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+", u) for u in uses)], [3, True],
           "three actions, each pinned to a full commit sha with its version in a comment")
        eq("    if: github.event_name != 'push' || github.actor != 'antenne-publisher[bot]'" in raw_lines, True,
           "the job is skipped for the App's own push to main")
        wanted = ["branches: [main]", "run_id:", "dry_run:", "group: antenne-publish", "cancel-in-progress: false", "contents: read", "pages: write",
                  "issues: write", "environment: antenne-publish", "timeout-minutes: 20", "persist-credentials: false", "fetch-depth: 0",
                  "if: ${{ !inputs.dry_run }}", "client-id: ${{ vars.ANTENNE_APP_CLIENT_ID }}", "private-key: ${{ secrets.ANTENNE_APP_PRIVATE_KEY }}",
                  "repositories: antenne-site", "permission-contents: write", "ANTENNE_CONVEX_SITE: ${{ vars.ANTENNE_CONVEX_SITE }}",
                  "ANTENNE_KEY: ${{ secrets.ANTENNE_PUBLISH_KEY }}", "RUN_ID: ${{ inputs.run_id }}", "APP_TOKEN: ${{ steps.app-token.outputs.token }}",
                  "GITHUB_TOKEN: ${{ github.token }}", "run: python3 scripts/publish-approved.py run", "if: failure()", "if: success()"]
        eq([w for w in wanted if w not in lines], [], "triggers, concurrency, permissions, environment, the token step and the script's env")
        eq([text.count("title='Antenne publish needs attention'"), "storyId" in text, "secrets." in text.split("Report the failure")[1]], [2, False, False],
           "one issue title to open and to close; no story id and no secret in the issue steps")
        lookups = [line for line in lines if "gh issue list" in line]
        eq([len(lookups), [line for line in lookups if "--app github-actions" not in line]], [2, []],
           "both issue lookups take only an issue the workflow opened, never one a stranger titled the same")

    with section("no story text reached stdout or stderr on any run, and this tree was never written"):
        eq([len(outputs) >= 20, [i for i, text in enumerate(outputs) if MARK in text]], [True, []], "%d runs, no marker" % len(outputs))
        for rel, content in REAL.items():
            eq(open(os.path.join(ROOT, rel), "rb").read() == content, True, rel + " is unchanged")
finally:
    for path in temp_dirs:
        shutil.rmtree(path, ignore_errors=True)

print("\n%d of %d checks failed" % (failed, checks) if failed else "\nall %d checks passed" % checks)
sys.exit(1 if failed else 0)
