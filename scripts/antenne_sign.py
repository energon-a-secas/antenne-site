#!/usr/bin/env python3
"""Sign and send Antenne machine requests (docs/plans/2026-09-15-antenne-desk.md
sections 5 and 6.3). Standard library only; runs on Python 3.10.

  load_key(key_file=None)                              -> (key_id, secret_b64)
  sign(key_id, secret_b64, path, body_bytes, timestamp) -> the three X-Antenne-* headers
  encode(payload)                                      -> the body bytes post() sends
  post(site, path, payload, key)                       -> (status, body)

Other scripts load this file by path rather than as a package:

  spec = importlib.util.spec_from_file_location("antenne_sign", "<site>/scripts/antenne_sign.py")
  antenne_sign = importlib.util.module_from_spec(spec); spec.loader.exec_module(antenne_sign)

The signature is base64 HMAC-SHA256 over "<keyId>.<timestamp>.<path>.<raw body>",
the bytes convex/lib/signature.ts verifies. tests/sign-vectors.json pins the two
together. Nothing here prints, and no error message carries a secret.
"""
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import stat
import time
import urllib.error
import urllib.request
from pathlib import Path

KEY_ENV = "ANTENNE_KEY"
KEY_HEADER = "X-Antenne-Key"
TIMESTAMP_HEADER = "X-Antenne-Timestamp"
SIGNATURE_HEADER = "X-Antenne-Signature"
KEY_ID_RE = re.compile(r"[a-z0-9-]{1,32}")        # fullmatch, as convex/lib/signature.ts KEY_ID_RE
SECRET_MIN_BYTES = 32
TIMESTAMP_RE = re.compile(r"[0-9]{1,12}")         # fullmatch
# https for a deployment; plain http only on this machine, for a local stand-in.
SITE_RE = re.compile(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)+|http://(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?")
TIMEOUT_S = 20


class AntenneError(Exception):
    """A refusal worth one line on stderr. Its message never holds a secret."""


def default_key_file() -> Path:
    """Where scripts/setup-antenne.sh stage 6 writes the operator's key."""
    return Path.home() / ".config" / "antenne" / "submit-key"


def parse_key(text: str, source: str):
    """(key_id, secret_b64) from "keyId:base64secret"; source names where it came from."""
    key_id, sep, secret = text.strip().partition(":")
    if not sep or not KEY_ID_RE.fullmatch(key_id) or ":" in secret:
        raise AntenneError(f"{source} does not hold keyId:base64secret")
    try:
        raw = base64.b64decode(secret, validate=True)
    except (binascii.Error, ValueError):
        raise AntenneError(f"{source}: the secret is not base64") from None
    if len(raw) < SECRET_MIN_BYTES:
        raise AntenneError(f"{source}: the secret decodes to fewer than {SECRET_MIN_BYTES} bytes")
    return key_id, secret


def load_key(key_file=None):
    """The key from ANTENNE_KEY, else from key_file, else from default_key_file().
    A key file whose mode is wider than 600 is refused."""
    env = os.environ.get(KEY_ENV, "")
    if env.strip():
        return parse_key(env, KEY_ENV)
    path = Path(key_file).expanduser() if key_file else default_key_file()
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        raise AntenneError(f"no key: set {KEY_ENV}, pass --key-file, or write {path} (setup-antenne.sh stage 6)") from None
    except OSError:
        raise AntenneError(f"cannot read the key file {path}") from None
    if mode & 0o177:
        raise AntenneError(f"{path} is mode {mode:o}, wider than 600: run chmod 600 {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise AntenneError(f"cannot read the key file {path}") from None
    return parse_key(text, str(path))


def sign(key_id: str, secret_b64: str, path: str, body_bytes: bytes, timestamp) -> dict:
    """The three headers that sign body_bytes for path at timestamp (Unix seconds)."""
    stamp = str(timestamp)
    if not KEY_ID_RE.fullmatch(key_id) or not TIMESTAMP_RE.fullmatch(stamp):
        raise AntenneError("sign: a key id of [a-z0-9-] and a timestamp in Unix seconds are required")
    try:
        secret = base64.b64decode(secret_b64, validate=True)
    except (binascii.Error, ValueError):
        raise AntenneError("sign: the secret is not base64") from None
    message = f"{key_id}.{stamp}.{path}.".encode("utf-8") + bytes(body_bytes)
    mac = hmac.new(secret, message, hashlib.sha256).digest()
    return {KEY_HEADER: key_id, TIMESTAMP_HEADER: stamp, SIGNATURE_HEADER: base64.b64encode(mac).decode("ascii")}


def check_site(site: str) -> str:
    """The site as https://<deployment>.convex.site with no trailing slash, or AntenneError."""
    base = (site or "").strip().rstrip("/")
    if not SITE_RE.fullmatch(base):
        raise AntenneError("the site must be https://<deployment>.convex.site")
    return base


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as its own status: signed headers never follow it to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _json_or_none(data: bytes):
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def encode(payload) -> bytes:
    """The request body post() signs and sends for payload: compact JSON in UTF-8.
    The routes refuse a body over convex/lib/limits.ts BODY_MAX_BYTES of these
    bytes (413 too-large), so a caller that must stay under it measures this."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def post(site: str, path: str, payload, key, timestamp=None, timeout=TIMEOUT_S):
    """POST payload as JSON to site + path, signed with key (key_id, secret_b64).
    Returns (status, body), body being the parsed JSON answer or None. Any HTTP
    status comes back as a value; only an unreachable site raises AntenneError."""
    key_id, secret_b64 = key
    base = check_site(site)
    body = encode(payload)
    headers = sign(key_id, secret_b64, path, body, int(time.time()) if timestamp is None else timestamp)
    headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=body, headers=headers, method="POST")
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, _json_or_none(response.read())
    except urllib.error.HTTPError as err:
        try:
            return err.code, _json_or_none(err.read())
        finally:
            err.close()
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise AntenneError(f"cannot reach {base}: {type(reason).__name__}") from None
