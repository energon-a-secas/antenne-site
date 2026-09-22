#!/usr/bin/env python3
"""scripts/antenne_sign.py: the Python signer of the machine routes
(docs/plans/2026-09-15-antenne-desk.md sections 5 and 6.3). Run with: make validate

sign() must produce every signature in tests/sign-vectors.json, the same file
tests/convex-submit.test.mjs holds convex/lib/signature.ts to accepting, so the
client and the server cannot drift apart. load_key() reads ANTENNE_KEY before a
key file and refuses a key file wider than mode 600. post() is driven against a
local HTTP server in a thread: it sends the bytes it signed, answers any status
as a value and never follows a redirect. No error message may carry a secret.
"""

import base64
import contextlib
import hashlib
import hmac
import http.server
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("antenne_sign", os.path.join(ROOT, "scripts", "antenne_sign.py"))
sign_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign_mod)

failed = 0
checks = 0


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


def refusal(fn):
    """The AntenneError message fn raises, or None when it returns."""
    try:
        fn()
    except sign_mod.AntenneError as err:
        return str(err)
    return None


@contextlib.contextmanager
def environ(**values):
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


with open(os.path.join(HERE, "sign-vectors.json"), encoding="utf-8") as fh:
    VECTORS = json.load(fh)["vectors"]
SECRET = base64.b64encode(bytes(range(32))).decode("ascii")
SHORT = base64.b64encode(bytes(31)).decode("ascii")
temp = tempfile.mkdtemp(prefix="antenne-sign-test-")

try:
    with section("sign() produces every signature in tests/sign-vectors.json"):
        eq(len(VECTORS) >= 4, True, "the vectors are there")
        for v in VECTORS:
            got = sign_mod.sign(v["keyId"], v["secret"], v["path"], v["body"].encode("utf-8"), v["timestamp"])
            eq(got, {"X-Antenne-Key": v["keyId"], "X-Antenne-Timestamp": v["timestamp"], "X-Antenne-Signature": v["signature"]},
               v["name"])
            eq(sign_mod.sign(v["keyId"], v["secret"], v["path"], v["body"].encode("utf-8"), int(v["timestamp"])), got,
               v["name"] + ": the timestamp as an int signs the same")
        v = VECTORS[0]
        base = (v["keyId"], v["secret"], v["path"], v["body"].encode("utf-8"), v["timestamp"])
        changed = [
            sign_mod.sign(base[0], base[1], "/status", base[3], base[4]),
            sign_mod.sign(base[0], base[1], base[2], base[3] + b" ", base[4]),
            sign_mod.sign(base[0], base[1], base[2], base[3], str(int(base[4]) + 1)),
            sign_mod.sign("watch", base[1], base[2], base[3], base[4]),
        ]
        eq([c["X-Antenne-Signature"] != v["signature"] for c in changed], [True] * 4,
           "another path, body, timestamp or key id signs differently")
        for what, args in (("a key id with capitals", ("Local", SECRET, "/submit", b"{}", 1)),
                           ("a timestamp that is not Unix seconds", ("local", SECRET, "/submit", b"{}", "12.5")),
                           ("a secret that is not base64", ("local", "not base64!", "/submit", b"{}", 1))):
            message = refusal(lambda: sign_mod.sign(*args))
            eq([message is not None, SECRET in (message or "")], [True, False], "sign refuses " + what)

    with section("load_key: ANTENNE_KEY first, then the key file; a file wider than 600 is refused; no message holds the secret"):
        home = os.path.join(temp, "home")
        os.makedirs(os.path.join(home, ".config", "antenne"))
        default = os.path.join(home, ".config", "antenne", "submit-key")
        keyfile = os.path.join(temp, "key")

        def write_key(path, text, mode):
            if os.path.exists(path):
                os.unlink(path)  # a 400 file from the last case cannot be reopened for writing
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.chmod(path, mode)

        with environ(HOME=home, ANTENNE_KEY="local:" + SECRET):
            eq(sign_mod.load_key(), ["local", SECRET], "ANTENNE_KEY is read as keyId:base64secret")
            write_key(keyfile, "other:" + SECRET, 0o600)
            eq(sign_mod.load_key(keyfile)[0], "local", "and wins over a key file")
        with environ(HOME=home, ANTENNE_KEY="  local:%s\n" % SECRET):
            eq(sign_mod.load_key(), ["local", SECRET], "surrounding space and a newline are ignored")
        for what, text in (("no colon", SECRET), ("a key id with capitals", "Local:" + SECRET), ("a short secret", "local:" + SHORT),
                           ("a secret that is not base64", "local:" + SECRET[:-2] + "!!"), ("an extra part", "local:submit:" + SECRET)):
            with environ(HOME=home, ANTENNE_KEY=text):
                message = refusal(sign_mod.load_key)
                echoed = any(part in (message or "") for part in (SECRET[:20], SHORT[:12]))
                eq([message is not None, echoed], [True, False], "ANTENNE_KEY with %s is refused, without echoing it" % what)
        with environ(HOME=home, ANTENNE_KEY=None):
            # The wizard's own form: local:<44 base64 characters>, no trailing newline.
            for mode in (0o600, 0o400):
                write_key(keyfile, "local:" + SECRET, mode)
                eq(sign_mod.load_key(keyfile), ["local", SECRET], "a key file at mode %o is read" % mode)
            # Each bit outside 600 alone, then two common modes.
            for mode in (0o700, 0o640, 0o620, 0o610, 0o604, 0o602, 0o601, 0o644, 0o660):
                write_key(keyfile, "local:" + SECRET, mode)
                message = refusal(lambda: sign_mod.load_key(keyfile))
                eq([message is not None and "chmod 600" in message, SECRET[:20] in (message or "")], [True, False],
                   "a key file at mode %o is refused, and the refusal says chmod 600" % mode)
            message = refusal(lambda: sign_mod.load_key(os.path.join(temp, "missing")))
            eq([message is not None and "missing" in message and "ANTENNE_KEY" in message], [True], "a missing key file names itself and ANTENNE_KEY")
            message = refusal(sign_mod.load_key)
            eq(message is not None and default in message, True, "no key file given: ~/.config/antenne/submit-key is named")
            write_key(default, "local:" + SECRET, 0o600)
            eq(sign_mod.load_key(), ["local", SECRET], "and read when it is there at 600")
            write_key(default, "local:" + SECRET, 0o644)
            eq(refusal(sign_mod.load_key) is not None, True, "and refused at 644")
            write_key(keyfile, "local:" + SHORT, 0o600)
            eq(refusal(lambda: sign_mod.load_key(keyfile)) is not None, True, "a key file with a short secret is refused")

    with section("check_site: https for a deployment, plain http only on this machine"):
        eq(sign_mod.check_site(" https://happy-otter-123.convex.site/ "), "https://happy-otter-123.convex.site", "trimmed, no trailing slash")
        eq(sign_mod.check_site("http://127.0.0.1:8123"), "http://127.0.0.1:8123", "a local stand-in")
        for bad in ("http://happy-otter-123.convex.site", "https://nodot", "https://a.convex.site/path", "ftp://a.b", "", "https://a.b?x=1"):
            eq(refusal(lambda: sign_mod.check_site(bad)) is not None, True, "refused: %r" % bad)

    with section("post(): the bytes it signs are the bytes it sends; any status comes back as a value; a redirect is not followed"):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/ok")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status, reply = {"/ok": (200, b'{"ok": true, "n": 1}'), "/refuse": (401, b'{"ok": false, "code": "unauthorized"}'),
                                 "/text": (200, b"not json")}.get(self.path, (404, b"{}"))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        site = "http://127.0.0.1:%d" % server.server_address[1]
        key = ("local", SECRET)
        try:
            payload = {"stories": [{"id": "2026-09-15-café", "title": "Café \U0001F600"}]}
            eq(sign_mod.post(site, "/ok", payload, key, timestamp=1789000000), [200, {"ok": True, "n": 1}], "200 and the parsed body")
            got = seen[-1]
            sent = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            expected = base64.b64encode(hmac.new(bytes(range(32)), b"local.1789000000./ok." + sent, hashlib.sha256).digest()).decode()
            eq([got["body"] == sent, got["headers"].get("X-Antenne-Key"), got["headers"].get("X-Antenne-Timestamp"),
                got["headers"].get("X-Antenne-Signature") == expected, got["headers"].get("Content-Type")],
               [True, "local", "1789000000", True, "application/json"], "the compact UTF-8 body it signed is the body it sent")
            eq(sign_mod.encode(payload) == got["body"], True, "encode() is that body, so a size measured with it is the size sent")
            eq("Authorization" in got["headers"], False, "no Authorization header is sent")
            eq(sign_mod.post(site, "/refuse", {}, key), [401, {"ok": False, "code": "unauthorized"}], "a 401 comes back as a value")
            eq(sign_mod.post(site, "/text", {}, key), [200, None], "a body that is not JSON comes back as None")
            before = len(seen)
            eq(sign_mod.post(site, "/redirect", {}, key)[0], 302, "a redirect is answered as its own status")
            eq([s["path"] for s in seen[before:]], ["/redirect"], "and not followed, so the signed headers go nowhere else")
            now = seen[-1]["headers"].get("X-Antenne-Timestamp")
            eq(now.isdigit() and abs(int(now) - int(time.time())) < 60, True, "without a timestamp, post() signs the current time")
        finally:
            server.shutdown()
            server.server_close()
        port = server.server_address[1]
        message = refusal(lambda: sign_mod.post("http://127.0.0.1:%d" % port, "/ok", {}, key))
        eq([message is not None, SECRET[:20] in (message or "")], [True, False], "a site that cannot be reached raises AntenneError, without the key")
finally:
    shutil.rmtree(temp, ignore_errors=True)

print("\n%d of %d checks failed" % (failed, checks) if failed else "\nall %d checks passed" % checks)
sys.exit(1 if failed else 0)
