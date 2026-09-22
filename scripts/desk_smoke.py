#!/usr/bin/env python3
"""Prove the Antenne desk's refusals on the live deployment.

make validate proves the rules in convex/lib against an in-memory database. It
cannot prove that the deployment the desk calls runs the same code, with the
env it was given. This script does, by calling the deployed functions through
`npx convex run --prod` with made-up identities, then sending signed machine
requests that must be refused (docs/plans/2026-09-15-antenne-desk.md section
6.3; the shape of projects/vitrina-site/scripts/convex_smoke.py).

    python3 scripts/desk_smoke.py                 run it, after scripts/setup-antenne.sh
    python3 scripts/desk_smoke.py --dry-run       print the commands and checks, run nothing
    python3 scripts/desk_smoke.py --site URL --key-file PATH

It writes no draft, no member, no request and no setting: every call it makes
is a read or a refusal, and a refused call writes nothing. The one write is
the rate row the signed POST /status records for the key. The identities are
synthetic (user_antennesmoke<stamp>), and the run stops if DESK_OWNERS or
DESK_DENY lists one. DESK_OWNERS, DESK_DENY and DESK_FROZEN are read into
memory to decide what to expect; no env value and no key is ever printed.

npx runs as scripts/setup-antenne.sh's convex() runs it: `npx --no convex`,
so nothing unpinned is fetched, and without CONVEX_DEPLOYMENT,
CONVEX_DEPLOY_KEY and CONVEX_DEPLOYMENT_TOKEN, so the shell cannot point it at
another deployment; --prod is the one .env.local names.

Key: ANTENNE_KEY, else --key-file, else ~/.config/antenne/submit-key: the
operator's local key (submit and status), which is exactly why /publish/claim
must refuse it. The claim is sent only with a key id the contract gives no
publish scope (local, ci, watch): any other key could hold it, and its claim
would take real approvals. Site: --site, else ANTENNE_CONVEX_SITE, else the
neo-convex-url meta in desk.html read as .convex.site.

Written with the backend; run by the owner after the deploy (setup-antenne.sh
stage 3), never by make validate.
"""

import argparse
import datetime
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ISSUER = "https://clerk.neorgon.com"
META_RE = re.compile(r'<meta name="neo-convex-url" content="([^"]*)">')
CONVEX_URL_RE = re.compile(r"https://[a-z-]+-[0-9]+\.convex\.cloud")  # fullmatch
STALE_S = 600
# The shell's deployment selection, which the wizard's convex() unsets too.
CONVEX_SELECTION = ("CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN")
# The planned keys without the publish scope (section 5): only these may send the claim probe.
NO_PUBLISH_KEYS = ("local", "ci", "watch")


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


antenne = load("antenne_sign", "antenne_sign.py")


class SmokeFailure(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def listed(subject: str, raw: str) -> bool:
    return subject in [part.strip() for part in raw.split(",")]


class Smoke:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.checks = 0

    # ── the deployment ───────────────────────────────────────────────────────

    def _npx(self, args):
        cmd = ["npx", "--no", "convex"] + args
        if self.dry_run:
            print("  $ " + " ".join(shlex.quote(part) for part in cmd))
            return None
        env = {name: value for name, value in os.environ.items() if name not in CONVEX_SELECTION}
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=180, env=env)
        if proc.returncode != 0:
            # A refusal is a value, so a non-zero exit is a real failure. The CLI's own output is not
            # echoed, since it can quote what it read; the command is named so the owner can run it.
            target = "run %s" % args[-2] if args[0] == "run" else " ".join(args)
            raise SmokeFailure("npx convex %s exited %d; run it by hand to read why" % (target, proc.returncode))
        return proc.stdout

    def run(self, function, args=None, subject=None):
        cmd = ["run", "--prod"]
        if subject:
            cmd += ["--identity", json.dumps({"subject": subject, "issuer": ISSUER})]
        out = self._npx(cmd + [function, json.dumps(args or {})])
        if out is None:
            return None
        out = out.strip()
        return None if out == "" else json.loads(out)

    def env_value(self, name):
        """An env var, in memory only. Never printed; empty means unset."""
        return (self._npx(["env", "get", "--prod", name]) or "").strip()

    # ── checking ─────────────────────────────────────────────────────────────

    def check(self, what, condition):
        self.checks += 1
        if self.dry_run:
            print("    check: " + what)
            return
        if not condition():
            raise SmokeFailure("FAILED: " + what)
        print("  ok   " + what)

    def refused(self, who, function, args, subject, code):
        answer = self.run(function, args, subject)
        self.check("%s: %s is refused with %s" % (who, function, code),
                   lambda: isinstance(answer, dict) and answer.get("ok") is False and answer.get("code") == code)


def site_of(args) -> str:
    site = args.site or os.environ.get("ANTENNE_CONVEX_SITE", "").strip()
    if not site:
        found = META_RE.findall((ROOT / "desk.html").read_text(encoding="utf-8"))
        url = found[0].strip() if len(found) == 1 else ""
        if not CONVEX_URL_RE.fullmatch(url):
            raise SmokeFailure("desk.html has no .convex.cloud URL yet (scripts/setup-antenne.sh stage 2); pass --site")
        site = url[: -len(".convex.cloud")] + ".convex.site"
    try:
        return antenne.check_site(site)
    except antenne.AntenneError as err:
        raise SmokeFailure(str(err)) from None


def send(site, path, body: bytes, headers: dict):
    """POST exactly these bytes and headers; every status is an answer."""
    request = urllib.request.Request(site + path, data=body, headers={**headers, "Content-Type": "application/json"}, method="POST")
    try:
        with _OPENER.open(request, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as err:
        err.close()
        return err.code
    except (urllib.error.URLError, OSError) as err:
        raise SmokeFailure("cannot reach %s: %s" % (site, type(getattr(err, "reason", err)).__name__)) from None


def functions(s, stranger):
    print("\nPreconditions on prod")
    owners, denied = s.env_value("DESK_OWNERS"), s.env_value("DESK_DENY")
    frozen = s.env_value("DESK_FROZEN") == "1"
    s.check("the smoke subject is neither an owner nor denied", lambda: not listed(stranger, owners) and not listed(stranger, denied))
    s.check("DESK_OWNERS names at least one owner", lambda: bool(owners.strip()))
    if not s.dry_run:
        print("  the desk is %s" % ("frozen: mutations must answer frozen" if frozen else "not frozen"))

    def write_code(code):
        """A mutation's refusal: DESK_FROZEN is checked before the caller, so a frozen desk answers frozen."""
        return "frozen" if frozen else code

    print("\nNobody signed in")
    me = s.run("desk:me")
    s.check("desk:me says signed out", lambda: me.get("ok") is True and me.get("signedIn") is False)
    queue = s.run("desk:queue")
    s.check("desk:queue answers no drafts", lambda: queue.get("ok") is True and queue.get("drafts") == [])
    status = s.run("publish:status")
    s.check("publish:status answers empty data", lambda: status.get("ok") is True and status.get("counts") is None and status.get("lastRun") is None)
    s.refused("anonymous", "drafts:submit", {"post": {}}, None, write_code("not-signed-in"))
    s.refused("anonymous", "publish:now", {}, None, write_code("not-signed-in"))

    print("\nA signed-in account with no role")
    me = s.run("desk:me", subject=stranger)
    s.check("desk:me says signed in, role null", lambda: me.get("signedIn") is True and me.get("role") is None and me.get("subject") == stranger)
    queue = s.run("desk:queue", subject=stranger)
    s.check("desk:queue answers no drafts, not a refusal", lambda: queue.get("ok") is True and queue.get("drafts") == [])
    settings = s.run("settings:get", subject=stranger)
    s.check("settings:get answers empty data", lambda: settings.get("ok") is True and settings.get("publishDelayMs") is None)
    status = s.run("publish:status", subject=stranger)
    s.check("publish:status answers empty data", lambda: status.get("ok") is True and status.get("counts") is None)
    members = s.run("members:list", subject=stranger)
    s.check("members:list answers empty data", lambda: members.get("ok") is True and members.get("members") == [] and members.get("owners") == [])
    for function, args in (("drafts:submit", {"post": {}}), ("publish:now", {}), ("publish:retry", {}),
                           ("members:grant", {"subject": stranger, "role": "editor", "label": "smoke"}), ("settings:update", {})):
        s.refused("no role", function, args, stranger, write_code("not-member"))


def routes(s, site, key):
    print("\nSigned machine routes")
    if s.dry_run:
        for what in ("POST /status signed now: 200", "POST /publish/claim with the local, ci or watch key: 403 scope",
                     "POST /status signed %d s ago: 401" % STALE_S, "POST /submit carrying the signature made for /status: 401",
                     "POST /submit with no signature: 401", "POST /submit signed as a key id nobody holds: 401"):
            s.check(what, lambda: True)
        return
    key_id, secret = key
    now, body = int(time.time()), b"{}"
    ok = send(site, "/status", body, antenne.sign(key_id, secret, "/status", body, now))
    s.check("POST /status signed now answers 200, so the key and the site work", lambda: ok == 200)
    if key_id in NO_PUBLISH_KEYS:
        claim = b'{"runId":null}'
        scoped = send(site, "/publish/claim", claim, antenne.sign(key_id, secret, "/publish/claim", claim, now))
        s.check("POST /publish/claim with the %s key answers 403 scope" % key_id, lambda: scoped == 403)
    else:
        # Sent with a key that holds the publish scope, the claim would take the due approvals for real.
        print("  skip POST /publish/claim: key %s is not local, ci or watch, so it may hold the publish scope" % key_id)
    stale = send(site, "/status", body, antenne.sign(key_id, secret, "/status", body, now - STALE_S))
    s.check("a timestamp %d s old answers 401" % STALE_S, lambda: stale == 401)
    swapped = send(site, "/submit", body, antenne.sign(key_id, secret, "/status", body, now))
    s.check("a signature for /status sent to /submit answers 401", lambda: swapped == 401)
    bare = send(site, "/submit", body, {})
    s.check("no signature answers 401", lambda: bare == 401)
    unknown = send(site, "/submit", body, antenne.sign("smoke-nobody", secret, "/submit", body, now))
    s.check("a key id nobody holds answers 401", lambda: unknown == 401)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the commands and checks, run nothing")
    parser.add_argument("--site", help="https://<deployment>.convex.site (default: ANTENNE_CONVEX_SITE, then desk.html)")
    parser.add_argument("--key-file", help="the key file (default: ANTENNE_KEY, then ~/.config/antenne/submit-key)")
    opts = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
    s = Smoke(opts.dry_run)
    try:
        functions(s, "user_antennesmoke%s" % stamp)
        if opts.dry_run:
            routes(s, None, None)
        else:
            try:
                key = antenne.load_key(opts.key_file)
            except antenne.AntenneError as err:
                raise SmokeFailure(str(err)) from None
            routes(s, site_of(opts), key)
    except SmokeFailure as err:
        print("\n%s" % err, file=sys.stderr)
        sys.exit(1)
    print("\nprod: %d checks %s" % (s.checks, "listed" if opts.dry_run else "passed"))


if __name__ == "__main__":
    main()
