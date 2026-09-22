#!/usr/bin/env python3
"""Submit stories to the private Antenne desk queue, or read its status.

  python3 scripts/submit-drafts.py [--dry-run] [--site URL] [--key-file PATH] FILE...
  python3 scripts/submit-drafts.py --status [--site URL] [--key-file PATH]

Each FILE holds one post or {"stories": [...]}. Every story is validated in
submit mode by scripts/build-feed.py, loaded by path, against today's UTC date.
One invalid story refuses the whole run and nothing is sent. Valid stories go
to POST /submit, signed by scripts/antenne_sign.py, in order, cut into batches
of at most 12 stories and at most 64000 bytes of request body, the two caps the
route enforces (400 too-many, 413 too-large). A story that alone is over the
byte cap is refused as too-large, like an invalid one, before anything is sent;
under the section 3.2 caps no valid story is (the largest encodes to about 23 KB).

Key: ANTENNE_KEY, else --key-file, else ~/.config/antenne/submit-key (refused
when its mode is wider than 600). Site: --site, else ANTENNE_CONVEX_SITE, else
the neo-convex-url meta in desk.html with .convex.cloud read as .convex.site.

Prints JSON on stdout: ids, outcomes, problem codes, counts and ages, never a
story's text. Exit 0 when every story landed (or, with --dry-run, when every
story is valid), 1 when a story is invalid or refused or a request failed, 2
when the input, the key or the site cannot be read.
(docs/plans/2026-09-15-antenne-desk.md sections 5 and 6.3)
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DESK = ROOT / "desk.html"
SITE_ENV = "ANTENNE_CONVEX_SITE"
BATCH_MAX = 12          # convex/lib/limits.ts SUBMIT_BATCH_MAX: past it /submit answers 400 too-many
BODY_MAX_BYTES = 64000  # convex/lib/limits.ts BODY_MAX_BYTES: past it /submit answers 413 too-large
META_RE = re.compile(r'<meta name="neo-convex-url" content="([^"]*)">')
CONVEX_URL_RE = re.compile(r"https://[a-z-]+-[0-9]+\.convex\.cloud")  # fullmatch
# Outcomes that leave the story where it should be; anything else is exit 1.
LANDED = ("created", "updated", "unchanged", "kept-human-edits", "already-decided", "published")
STATUSES = ("pending", "approved", "publishing", "committed", "live", "spiked")  # convex/lib/draftsCore.ts STATUSES
RUN_URL_RE = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(?:/attempts/[0-9]+)?")  # fullmatch
SHA_RE = re.compile(r"[0-9a-f]{40}")                 # fullmatch
RUN_ID_RE = re.compile(r"[a-z0-9]{1,64}")            # fullmatch: a Convex document id
ERROR_RE = re.compile(r"[ -~]{1,160}")               # fullmatch: one line of printable ASCII
DAY_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")    # fullmatch


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


feed = load("build_feed", "build-feed.py")
antenne = load("antenne_sign", "antenne_sign.py")


def say(message: str) -> None:
    print(f"submit-drafts: {message}", file=sys.stderr)


def emit(doc) -> None:
    print(json.dumps(doc, indent=2))


class Unreadable(Exception):
    """Input, key or site that cannot be used: exit 2."""


def read_stories(paths):
    stories = []
    for path in paths:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            raise Unreadable(f"cannot read {path} as JSON") from None
        if isinstance(data, dict) and "stories" in data:
            if not isinstance(data["stories"], list):
                raise Unreadable(f"{path}: stories must be an array")
            stories.extend(data["stories"])
        elif isinstance(data, dict):
            stories.append(data)
        else:
            raise Unreadable(f'{path} must hold a post or {{"stories": [...]}}')
    return stories


def site_from_desk() -> str:
    try:
        found = META_RE.findall(DESK.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        raise Unreadable(f"cannot read {DESK.name} for the neo-convex-url meta; pass --site or set {SITE_ENV}") from None
    if len(found) != 1:
        raise Unreadable(f"{DESK.name} has {len(found)} neo-convex-url metas, not 1; pass --site or set {SITE_ENV}")
    url = found[0].strip()
    if url == "":
        raise Unreadable(f"the neo-convex-url meta in {DESK.name} is empty, so the desk backend is not set up yet "
                         f"(scripts/setup-antenne.sh stage 2); pass --site or set {SITE_ENV}")
    if not CONVEX_URL_RE.fullmatch(url):
        raise Unreadable(f"the neo-convex-url meta in {DESK.name} is not a .convex.cloud URL; pass --site or set {SITE_ENV}")
    return url[: -len(".convex.cloud")] + ".convex.site"


def resolve(args):
    """(site, key) for a request, or Unreadable."""
    site = args.site or os.environ.get(SITE_ENV, "").strip() or site_from_desk()
    try:
        return antenne.check_site(site), antenne.load_key(args.key_file)
    except antenne.AntenneError as err:
        raise Unreadable(str(err)) from None


def word(value) -> str:
    """A code or an outcome as the server sent it, when it is one: [a-z-] only."""
    return value if isinstance(value, str) and re.fullmatch(r"[a-z-]{1,40}", value) else "unknown"


def story_id(value):
    """A story id as the server sent it, when it has an id's shape; else null."""
    return value if isinstance(value, str) and re.fullmatch(r"[a-z0-9-]{1,80}", value) else None


def code_of(body) -> str:
    return word(body.get("code") if isinstance(body, dict) else None)


def refused(route: str, status: int, body) -> int:
    extra = ""
    if isinstance(body, dict) and isinstance(body.get("retryAfterMs"), int):
        extra = f", retry in {body['retryAfterMs']} ms"
    say(f"{route} answered {status} {code_of(body)}{extra}")
    return 1


def problems_of(value):
    if not isinstance(value, list):
        return []
    return [{"field": word(p.get("field")), "code": word(p.get("code"))} for p in value if isinstance(p, dict)]


def number(value):
    """An integer as the server sent it, else null (a bool is not one)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def flag(value):
    return value if isinstance(value, bool) else None


def shaped(value, pattern, other=None):
    """value when it is a string pattern fullmatches, else other."""
    return value if isinstance(value, str) and pattern.fullmatch(value) else other


def queue_item(item):
    return {"storyId": story_id(item.get("storyId")), "status": word(item.get("status")), "source": word(item.get("source")),
            "assigned": flag(item.get("assigned")), "ageMs": number(item.get("ageMs")),
            "approvedAgeMs": number(item.get("approvedAgeMs")), "claimedAgeMs": number(item.get("claimedAgeMs")),
            "committedAgeMs": number(item.get("committedAgeMs"))}


def run_of(run):
    if not isinstance(run, dict):
        return None
    return {"runId": shaped(run.get("runId"), RUN_ID_RE), "state": word(run.get("state")), "trigger": word(run.get("trigger")),
            "attempts": number(run.get("attempts")), "followUp": flag(run.get("followUp")),
            "createdAt": number(run.get("createdAt")), "updatedAt": number(run.get("updatedAt")), "ageMs": number(run.get("ageMs")),
            "runUrl": shaped(run.get("runUrl"), RUN_URL_RE), "commitSha": shaped(run.get("commitSha"), SHA_RE),
            "error": None if run.get("error") is None else shaped(run.get("error"), ERROR_RE, "unknown"),
            "stories": number(run.get("stories"))}


def status_command(args) -> int:
    site, key = resolve(args)
    status, body = antenne.post(site, "/status", {}, key)
    if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        return refused("/status", status, body)
    # Only the fields section 5 names, each in the shape it has, so nothing
    # else a server says is printed: states and sources as [a-z-] words, ids,
    # urls and shas by their pattern, numbers and flags by type.
    counts = body.get("counts") if isinstance(body.get("counts"), dict) else {}
    queue = body.get("queue") if isinstance(body.get("queue"), list) else []
    emit({
        "counts": {k: counts[k] for k in STATUSES if number(counts.get(k)) is not None},
        "queue": [queue_item(item) for item in queue if isinstance(item, dict)],
        "lastRun": run_of(body.get("lastRun")),
        "tokenExpires": shaped(body.get("tokenExpires"), DAY_RE),
    })
    return 0


def body_bytes(posts) -> int:
    """Bytes of the /submit body that carries posts, exactly as antenne_sign.post sends it."""
    return len(antenne.encode({"stories": posts}))


def plan(posts, count_max=BATCH_MAX, bytes_max=BODY_MAX_BYTES):
    """posts cut, in order, into /submit batches of at most count_max stories
    and at most bytes_max body bytes; each batch is as full as the next story
    allows. A story over bytes_max on its own still gets a batch of its own:
    submit_command refuses such a story before it plans."""
    batches, current = [], []
    for post in posts:
        if current and (len(current) >= count_max or body_bytes(current + [post]) > bytes_max):
            batches.append(current)
            current = []
        current.append(post)
    if current:
        batches.append(current)
    return batches


def submit_command(args) -> int:
    stories = read_stories(args.files)
    today = feed.today_utc()
    results, posts = [], []
    for raw in stories:
        verdict = feed.validate_post(raw, "submit", today)
        ok, problems = verdict["ok"], verdict["problems"]
        # Valid, but no request could carry it: refused here like an invalid
        # story, so the dry run says so and nothing is sent.
        if ok and body_bytes([verdict["post"]]) > BODY_MAX_BYTES:
            ok, problems = False, problems + [{"field": "story", "code": "too-large"}]
        results.append({"id": feed.printable_id(raw, verdict), "ok": ok, "problems": problems})
        if ok:
            posts.append(verdict["post"])
    bad = sum(1 for r in results if not r["ok"])
    if args.dry_run:
        emit({"dryRun": True, "today": today, "results": results})
        batches = len(plan(posts))
        say(f"dry run: {len(results) - bad} valid, {bad} invalid, {batches} request{'' if batches == 1 else 's'} planned, nothing sent")
        return 1 if bad else 0
    if bad:
        emit({"refused": True, "today": today, "results": results})
        say(f"{bad} of {len(results)} stories are invalid, so nothing was sent")
        return 1
    if not posts:
        emit({"outcomes": []})
        say("no stories to send")
        return 0
    site, key = resolve(args)
    outcomes, sent = [], 0
    for batch in plan(posts):
        status, body = antenne.post(site, "/submit", {"stories": batch}, key)
        if status != 200 or not isinstance(body, dict) or body.get("ok") is not True or not isinstance(body.get("outcomes"), list):
            emit({"outcomes": outcomes, "unsent": len(posts) - sent})
            return refused("/submit", status, body)
        sent += len(batch)
        for item in body["outcomes"]:
            if isinstance(item, dict):
                outcomes.append({"id": story_id(item.get("id")), "outcome": word(item.get("outcome")),
                                 "problems": problems_of(item.get("problems"))})
    emit({"outcomes": outcomes})
    missed = sum(1 for o in outcomes if o["outcome"] not in LANDED)
    if missed:
        say(f"{missed} of {len(outcomes)} stories did not land")
    return 1 if missed else 0


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="submit-drafts.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="validate and print ids only; send nothing")
    ap.add_argument("--status", action="store_true", help="print the queue's counts, ids and ages")
    ap.add_argument("--site", metavar="URL", help="https://<deployment>.convex.site")
    ap.add_argument("--key-file", metavar="PATH", help="a keyId:base64secret file, mode 600")
    ap.add_argument("files", nargs="*", metavar="FILE")
    args = ap.parse_args(argv)
    if args.status and (args.files or args.dry_run):
        ap.error("--status takes no FILE and no --dry-run")
    if not args.status and not args.files:
        ap.error("give at least one FILE, or --status")
    return args


def main(argv) -> int:
    args = parse_args(argv)
    try:
        return status_command(args) if args.status else submit_command(args)
    except Unreadable as err:
        say(str(err))
        return 2
    except antenne.AntenneError as err:
        say(str(err))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
