#!/usr/bin/env python3
"""Publish the approved Antenne stories: the job .github/workflows/publish.yml runs.

  python3 scripts/publish-approved.py run

docs/plans/2026-09-15-antenne-desk.md section 6.2, steps 1 to 10:

   1  claim the due approvals (POST /publish/claim, with dryRun true on a
      dry run, so the run it creates has trigger dryrun and a failed run
      stays paused behind it); none: print "nothing to publish" and stop
   2  recompute each story's contentHash; one that differs from its
      approvedHash is a conflict
   3  merge the rest with build-feed.py --merge from a temp file outside the
      repo, and report conflict and invalid ids (POST /publish/conflict)
   4  nothing added: report HEAD with noChange (POST /publish/pushed), go to 9
   5  build-feed.py, then build-feed.py --check
   6  the diff guard: git status may list data/posts.json, feed.xml and
      index.html and nothing else
   7  a dry run prints counts and the diff stat, releases with reason dry-run
      and stops
   8  commit as antenne-publisher[bot] and push to main with APP_TOKEN; a
      rejected push fetches, resets to origin/main and repeats from 3, at
      most 3 times, merging only the stories the run still holds (one sent
      back as a conflict is pending at the desk, so no later pass adds it);
      then POST /publish/pushed
   9  wait for Pages to build the commit or a descendant (every 15 s, up to
      10 minutes, asking for one build if none has started after 3 minutes);
      errored fails; then POST /publish/built
  10  a failure before the push releases the claim (POST /publish/release)
      and exits 1, a dry run's with reason dry-run whatever step failed, so
      Convex never requeues it as a real publish; after the push nothing is
      released

Environment: ANTENNE_CONVEX_SITE, ANTENNE_KEY (the gh key, publish scope),
RUN_ID (empty for a push), DRY_RUN, GH_RUN_ID, GH_RUN_URL, APP_TOKEN (the
App's push token; not needed for a dry run) and GITHUB_TOKEN (Pages and the
bot's user id). ANTENNE_GITHUB_API and ANTENNE_PAGES_POLL_S, _KICK_S and
_WAIT_S exist for tests/test_publish_approved.py; the API may only be moved to
this machine. Config removes ANTENNE_KEY, APP_TOKEN and GITHUB_TOKEN from the
environment once it has read them, so git and build-feed.py inherit none of
them; push() hands APP_TOKEN to the one git push that needs it.

Output is ids and counts only: never a title, a summary, a body or a link, and
never what git or build-feed.py printed. A failure also appends stage=<word> to
$GITHUB_OUTPUT for the workflow's issue step.

Exit 0: published, nothing to publish, or a dry run. 1: a failure. 2: the
invocation or the environment cannot be used, and nothing was claimed.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FEED = HERE / "build-feed.py"
REPO = "energon-a-secas/dispatch-site"
BOT = "antenne-publisher[bot]"
GUARDED = ("data/posts.json", "feed.xml", "index.html")
PUSH_RETRIES = 3
API = "https://api.github.com"
LOCAL_API_RE = re.compile(r"http://(?:127\.0\.0\.1|localhost):[0-9]{1,5}")      # fullmatch
RUN_ID_RE = re.compile(r"[a-z0-9]{1,64}")                                         # fullmatch: a Convex id
GH_RUN_ID_RE = re.compile(r"[0-9]{1,20}")                                         # fullmatch
RUN_URL_RE = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]{1,20}(?:/attempts/[0-9]{1,6})?")
SHA_RE = re.compile(r"[0-9a-f]{40}")                                              # fullmatch
HASH_RE = re.compile(r"[0-9a-f]{64}")                                             # fullmatch
STORY_ID_RE = re.compile(r"[a-z0-9-]{1,80}")                                      # fullmatch
TIMEOUT_S = 20
# The credentials the workflow step holds. Read once by Config, then removed from the environment.
CREDENTIALS = ("ANTENNE_KEY", "APP_TOKEN", "GITHUB_TOKEN")


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


antenne = load("antenne_sign", "antenne_sign.py")
feed = load("build_feed", "build-feed.py")


def say(message: str) -> None:
    print(f"publish-approved: {message}", file=sys.stderr)


class Unusable(Exception):
    """The environment cannot be used: exit 2, before anything is claimed."""


class Failure(Exception):
    """A step failed. stage is one word: the release reason and the workflow's stage output."""

    def __init__(self, stage: str, detail: str = ""):
        super().__init__(stage)
        self.stage = stage
        self.detail = detail


def seconds(env, name: str, default: float) -> float:
    raw = env.get(name, "")
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise Unusable(f"{name} is not a number") from None
    if not 0 <= value <= 3600:
        raise Unusable(f"{name} is out of range")
    return value


class Config:
    """The run's settings, read from env (os.environ). The credentials are then removed from env, so no
    subprocess inherits them: git and build-feed.py need none, and push() passes APP_TOKEN to git push alone."""

    def __init__(self, env):
        try:
            self.site = antenne.check_site(env.get("ANTENNE_CONVEX_SITE", ""))
        except antenne.AntenneError:
            raise Unusable("ANTENNE_CONVEX_SITE must be https://<deployment>.convex.site") from None
        if not env.get("ANTENNE_KEY", "").strip():
            raise Unusable("ANTENNE_KEY is not set")
        try:
            self.key = antenne.load_key()
        except antenne.AntenneError as err:
            raise Unusable(str(err)) from None
        run_id = env.get("RUN_ID", "").strip()
        if run_id and not RUN_ID_RE.fullmatch(run_id):
            raise Unusable("RUN_ID is not a publish run id")
        self.run_id = run_id or None
        dry = env.get("DRY_RUN", "").strip().lower()
        if dry not in ("", "false", "true"):
            raise Unusable("DRY_RUN must be true or false")
        self.dry_run = dry == "true"
        gh_run_id = env.get("GH_RUN_ID", "").strip()
        run_url = env.get("GH_RUN_URL", "").strip()
        if gh_run_id and not GH_RUN_ID_RE.fullmatch(gh_run_id):
            raise Unusable("GH_RUN_ID is not a workflow run id")
        if run_url and not RUN_URL_RE.fullmatch(run_url):
            raise Unusable("GH_RUN_URL is not a workflow run page")
        self.gh_run_id = gh_run_id or None
        self.run_url = run_url or None
        self.app_token = env.get("APP_TOKEN", "").strip()
        self.github_token = env.get("GITHUB_TOKEN", "").strip()
        if not self.dry_run and not (self.app_token and self.github_token):
            raise Unusable("APP_TOKEN and GITHUB_TOKEN are needed to publish")
        api = env.get("ANTENNE_GITHUB_API", "").strip().rstrip("/")
        if api and not LOCAL_API_RE.fullmatch(api):
            raise Unusable("ANTENNE_GITHUB_API may only point at this machine")
        self.api = api or API
        self.poll_s = seconds(env, "ANTENNE_PAGES_POLL_S", 15)
        self.kick_s = seconds(env, "ANTENNE_PAGES_KICK_S", 180)
        self.wait_s = seconds(env, "ANTENNE_PAGES_WAIT_S", 600)
        for name in CREDENTIALS:
            env.pop(name, None)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer of its own, so the token is never sent anywhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def git(*args, env=None):
    """git in the repo, output captured and never printed: it can hold paths and text."""
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, env=env)


def head() -> str:
    sha = git("rev-parse", "HEAD").stdout.strip()
    if not SHA_RE.fullmatch(sha):
        raise Failure("git")
    return sha


class Publisher:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.run_id = None
        self.pushed = False
        self.bot_id = None
        self.covered = {}
        self.summary = {"runId": None, "claimed": 0, "added": [], "identical": [], "conflict": [], "noChange": False,
                        "dryRun": cfg.dry_run, "sha": None, "pushAttempts": 0}

    # ── the desk backend and the GitHub API ─────────────────────────────────

    def convex(self, path: str, payload: dict, stage: str) -> dict:
        try:
            status, body = antenne.post(self.cfg.site, path, payload, self.cfg.key)
        except antenne.AntenneError:
            raise Failure(stage, f"{path} unreachable") from None
        if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
            code = body.get("code") if isinstance(body, dict) and isinstance(body.get("code"), str) else None
            word = code if code and re.fullmatch(r"[a-z-]{1,40}", code) else "unknown"
            raise Failure(stage, f"{path} answered {status} {word}")
        return body

    def github(self, method: str, path: str):
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "antenne-publisher", "Authorization": f"Bearer {self.cfg.github_token}"}
        request = urllib.request.Request(self.cfg.api + path, method=method, headers=headers,
                                         data=b"" if method == "POST" else None)
        try:
            with _OPENER.open(request, timeout=TIMEOUT_S) as response:
                return response.status, _json(response.read())
        except urllib.error.HTTPError as err:
            try:
                return err.code, _json(err.read())
            finally:
                err.close()
        except (urllib.error.URLError, OSError):
            return None, None

    # ── the steps ───────────────────────────────────────────────────────────

    def claim(self) -> list:
        # dryRun: a dry run's claim is not a trigger, and Convex gives the run it creates trigger dryrun.
        body = self.convex("/publish/claim", {"runId": self.cfg.run_id, "ghRunId": self.cfg.gh_run_id,
                                              "runUrl": self.cfg.run_url, "dryRun": self.cfg.dry_run}, "claim")
        stories, run_id = body.get("stories"), body.get("runId")
        if not isinstance(stories, list):
            raise Failure("claim", "no stories list")
        if stories and not (isinstance(run_id, str) and RUN_ID_RE.fullmatch(run_id)):
            raise Failure("claim", "stories without a run id")
        self.run_id = run_id if stories else None
        for story in stories:
            if not (isinstance(story, dict) and isinstance(story.get("storyId"), str) and STORY_ID_RE.fullmatch(story["storyId"])
                    and isinstance(story.get("post"), dict) and isinstance(story.get("approvedHash"), str)
                    and HASH_RE.fullmatch(story["approvedHash"])):
                raise Failure("claim", "a story of the wrong shape")
        return stories

    @staticmethod
    def matches(story: dict) -> bool:
        """Step 2: the post is the one that was approved, byte for byte after canonicalization."""
        try:
            return story["post"].get("id") == story["storyId"] and feed.content_hash(story["post"]) == story["approvedHash"]
        except (TypeError, ValueError):
            # canonical_json refuses what it cannot hash; such a post is not the approved one.
            return False

    def merge(self, posts: list) -> dict:
        with tempfile.TemporaryDirectory(prefix="antenne-publish-") as tmp:
            if Path(tmp).resolve().is_relative_to(ROOT):
                raise Failure("merge", "the temp directory is inside the repo")
            path = Path(tmp) / "stories.json"
            path.write_text(json.dumps({"stories": posts}, ensure_ascii=False), encoding="utf-8")
            proc = subprocess.run([sys.executable, str(FEED), "--merge", str(path)], cwd=ROOT, capture_output=True, text=True)
        try:
            out = json.loads(proc.stdout) if proc.returncode == 0 else None
        except ValueError:
            out = None
        if not isinstance(out, dict) or not all(isinstance(out.get(k), list) for k in ("added", "identical", "conflict", "invalid")):
            raise Failure("merge", f"build-feed.py --merge exited {proc.returncode}")
        return out

    def build(self) -> None:
        for stage, args in (("build", []), ("check", ["--check"])):
            proc = subprocess.run([sys.executable, str(FEED), *args], cwd=ROOT, capture_output=True, text=True)
            if proc.returncode != 0:
                raise Failure(stage, f"build-feed.py {' '.join(args) or '(no flag)'} exited {proc.returncode}")

    def guard(self) -> None:
        proc = git("status", "--porcelain", "--untracked-files=all")
        if proc.returncode != 0:
            raise Failure("diff-guard", "git status failed")
        paths = [line[3:] for line in proc.stdout.splitlines() if line.strip()]
        outside = [p for p in paths if p not in GUARDED]
        if outside:
            raise Failure("diff-guard", f"{len(outside)} changed path(s) besides the three the feed owns")

    def commit(self, added: list) -> None:
        if self.bot_id is None:
            status, user = self.github("GET", "/users/" + urllib.parse.quote(BOT))
            bot_id = user.get("id") if isinstance(user, dict) else None
            if status != 200 or not isinstance(bot_id, int) or isinstance(bot_id, bool) or bot_id <= 0:
                raise Failure("bot-id", f"GET /users/{BOT} answered {status}")
            self.bot_id = bot_id
        email = f"{self.bot_id}+{BOT}@users.noreply.github.com"
        env = dict(os.environ, GIT_AUTHOR_NAME=BOT, GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME=BOT, GIT_COMMITTER_EMAIL=email)
        message = f"feat(feed): publish {len(added)} approved stories\n\n" + "\n".join(added) + "\n"
        if git("add", "--", *GUARDED).returncode != 0 or git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message, env=env).returncode != 0:
            raise Failure("commit", "git commit failed")

    def push(self) -> bool:
        """Push HEAD to main with the App token. It is in this one git process's environment, where the
        credential helper reads it, and never in argv; Config removed it from the environment every other
        subprocess inherits. A plain push: another commit on main makes it fail, and the run merges again."""
        helper = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$APP_TOKEN"; }; f'
        env = dict(os.environ, APP_TOKEN=self.cfg.app_token, GIT_TERMINAL_PROMPT="0")
        self.summary["pushAttempts"] += 1
        return git("-c", "credential.helper=", "-c", f"credential.helper={helper}", "push", "-q", "origin", "HEAD:refs/heads/main", env=env).returncode == 0

    def reset(self) -> None:
        if git("fetch", "-q", "origin", "main").returncode != 0 or git("reset", "-q", "--hard", "origin/main").returncode != 0:
            raise Failure("push", "could not reset to origin/main after a rejected push")

    def covers(self, sha: str, built: str) -> bool:
        """True when Pages built sha or a descendant of it."""
        if built == sha:
            return True
        if built not in self.covered:
            proc = git("merge-base", "--is-ancestor", sha, built)
            if proc.returncode not in (0, 1):
                git("fetch", "-q", "origin")
                proc = git("merge-base", "--is-ancestor", sha, built)
            self.covered[built] = proc.returncode == 0
        return self.covered[built]

    def pages(self, sha: str) -> None:
        start, kicked, seen = time.monotonic(), False, False
        while True:
            status, build = self.github("GET", f"/repos/{REPO}/pages/builds/latest")
            commit = build.get("commit") if status == 200 and isinstance(build, dict) else None
            if isinstance(commit, str) and SHA_RE.fullmatch(commit) and self.covers(sha, commit):
                seen = True
                if build.get("status") == "built":
                    return
                if build.get("status") == "errored":
                    raise Failure("pages", "the Pages build errored")
            elapsed = time.monotonic() - start
            if not seen and not kicked and elapsed >= self.cfg.kick_s:
                kicked = True
                status, _ = self.github("POST", f"/repos/{REPO}/pages/builds")
                say(f"no Pages build yet; requested one ({status})")
            if elapsed >= self.cfg.wait_s:
                raise Failure("pages", "no Pages build of the commit in time")
            time.sleep(self.cfg.poll_s)

    def release(self, reason: str) -> None:
        try:
            status, body = antenne.post(self.cfg.site, "/publish/release", {"runId": self.run_id, "reason": reason}, self.cfg.key)
        except antenne.AntenneError:
            status, body = None, None
        released = body.get("released") if isinstance(body, dict) and body.get("ok") is True else None
        if isinstance(released, int):
            say(f"released {released} stories ({reason})")
        else:
            say(f"the release failed ({status}); reconcile returns the claim after 30 minutes")

    # ── the run ─────────────────────────────────────────────────────────────

    def publish(self) -> int:
        stories = self.claim()
        if not stories:
            print("nothing to publish")
            return 0
        self.summary.update(runId=self.run_id, claimed=len(stories))
        say(f"claimed {len(stories)} stories for run {self.run_id}")
        mismatched = [s["storyId"] for s in stories if not self.matches(s)]
        reported = set()
        sha = None
        for attempt in range(PUSH_RETRIES + 1):
            # Only what the run still holds: a story sent back on an earlier pass is pending at the desk,
            # so it is never merged again, even when the main this pass reset to no longer collides with it.
            posts = [s["post"] for s in stories if s["storyId"] not in mismatched and s["storyId"] not in reported]
            merged = self.merge(posts)
            self.summary.update(added=merged["added"], identical=merged["identical"])
            conflicts = [i for i in mismatched + merged["conflict"] + merged["invalid"] if isinstance(i, str) and i not in reported]
            if conflicts:
                self.convex("/publish/conflict", {"runId": self.run_id, "storyIds": conflicts}, "conflict")
                reported.update(conflicts)
                self.summary["conflict"] = sorted(reported)
                say(f"sent back as conflicts: {', '.join(conflicts)}")
            if not merged["added"]:
                if self.cfg.dry_run:
                    return self.dry([])
                sha = head()
                self.convex("/publish/pushed", {"runId": self.run_id, "sha": sha, "noChange": True}, "pushed")
                self.pushed = True
                self.summary.update(noChange=True, sha=sha)
                break
            self.build()
            self.guard()
            if self.cfg.dry_run:
                return self.dry(git("diff", "--stat", "--", *GUARDED).stdout.splitlines())
            self.commit(merged["added"])
            if self.push():
                self.pushed = True
                sha = head()
                self.summary["sha"] = sha
                say(f"pushed {len(merged['added'])} stories as {sha}")
                self.convex("/publish/pushed", {"runId": self.run_id, "sha": sha, "noChange": False}, "pushed")
                break
            if attempt == PUSH_RETRIES:
                raise Failure("push", f"the push was rejected {PUSH_RETRIES + 1} times")
            say("the push was rejected; fetching main and merging again")
            self.reset()
        self.pages(sha)
        self.convex("/publish/built", {"runId": self.run_id, "sha": sha, "pagesStatus": "built"}, "built")
        print(json.dumps(self.summary))
        return 0

    def dry(self, stat: list) -> int:
        self.summary["diffStat"] = stat
        self.release("dry-run")
        print(json.dumps(self.summary))
        return 0

    def run(self) -> int:
        try:
            return self.publish()
        except Failure as failure:
            return self.failed(failure.stage, failure.detail)
        except Exception as err:
            # Named by type only: an unforeseen error's message could quote story text.
            return self.failed("error", type(err).__name__)

    def failed(self, stage: str, detail: str) -> int:
        say(f"failed at {stage}" + (f": {detail}" if detail else ""))
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a", encoding="utf-8") as fh:
                fh.write(f"stage={stage}\n")
        if self.run_id and not self.pushed:
            # A dry run's claim goes back as a dry run's, whatever step failed: Convex requeues a run
            # released for any other reason, and reconcile would dispatch it again without dry_run.
            self.release("dry-run" if self.cfg.dry_run else stage)
        elif self.pushed:
            say("the commit is on main, so nothing is released")
        self.summary["failed"] = stage
        print(json.dumps(self.summary))
        return 1


def _json(data: bytes):
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def main(argv) -> int:
    if argv != ["run"]:
        print("usage: python3 scripts/publish-approved.py run", file=sys.stderr)
        return 2
    try:
        cfg = Config(os.environ)
    except Unusable as err:
        say(str(err))
        return 2
    return Publisher(cfg).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
