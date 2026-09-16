#!/usr/bin/env python3
"""Validate data/posts.json and regenerate feed.xml (RSS 2.0).

Doubles as the posts linter: any schema problem exits 1 with a message, so a
hand edit, check.yml and the publish workflow all gate on it.

  python3 scripts/build-feed.py                  validate, write feed.xml, stamp index.html
  python3 scripts/build-feed.py --check          validate, fail on a stale stamp
  python3 scripts/build-feed.py --selftest       answer tests/post-vectors.json and tests/hash-vectors.json
  python3 scripts/build-feed.py --validate-story FILE [--mode desk|submit] [--today YYYY-MM-DD]
  python3 scripts/build-feed.py --merge FILE [--today YYYY-MM-DD]

Paths resolve from this file, so it runs from anywhere. What it prints names
ids, fields and problem codes, never a story's text. Exit 2 means the input
itself could not be read (or the flags were wrong).
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / "data" / "posts.json"
STRAY_POSTS = ROOT / "posts.json"
FEED = ROOT / "feed.xml"
INDEX = ROOT / "index.html"
POST_VECTORS = ROOT / "tests" / "post-vectors.json"
HASH_VECTORS = ROOT / "tests" / "hash-vectors.json"

SITE_URL = "https://dispatch.neorgon.com/"
FEED_ITEMS = 20


def fail(msg: str) -> None:
    print(f"build-feed: {msg}", file=sys.stderr)
    sys.exit(1)


def unreadable(msg: str) -> None:
    print(f"build-feed: {msg}", file=sys.stderr)
    sys.exit(2)


# ── Post rules: the Python mirror of js/schema.js ───────────────────────────
# docs/plans/2026-09-15-antenne-desk.md section 3. js/schema.js is the reading
# copy; tests/post-vectors.json is what this, it and convex/lib/post.ts must all
# answer. Every regex below is used with fullmatch, match or search as noted,
# never with $ (Python's $ also matches before a trailing newline), and says
# [0-9] where JavaScript would say \d (Python's \d takes any Unicode digit).

KINDS = ("launch", "feature", "fix", "note")
CAPS = {
    "id": 80,
    "site": 40,
    "title": 100,
    "summary": 320,
    "body": 5,
    "paragraph": 900,
    "links": 6,
    "label": 40,
    "url": 300,
    "tags": 8,
    "tag": 32,
    "windowPastDays": 60,
    "windowFutureDays": 1,
}
HOSTS = (
    {"host": "neorgon.com", "subdomains": True, "pathPrefix": ""},
    {"host": "github.com", "subdomains": False, "pathPrefix": "/energon-a-secas/"},
)
MODES = ("read", "archive", "desk", "submit")

# Exactly what JavaScript's String.prototype.trim removes. str.strip() is not
# the same set: it also strips U+001C..U+001F and U+0085, and keeps U+FEFF.
JS_WHITESPACE = ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
                 "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")

ID_RE = re.compile(r"[a-z0-9-]+")                                   # fullmatch
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")                  # fullmatch
SITE_RE = re.compile(r"[a-z0-9-]{1,%d}" % CAPS["site"])             # fullmatch
TAG_RE = re.compile(r"[a-z0-9-]{1,%d}" % CAPS["tag"])               # fullmatch
TOKEN_RE = re.compile(r"sk-ant-|ghp_|gho_|ghs_|github_pat_|sk_live_|sk_test_"
                      r"|xox[abprs]-|AKIA[0-9A-Z]{16}|-----BEGIN")  # search
LEGACY_LINK_RE = re.compile(r"https?://")                           # match
# A link url is judged by the pinned grammar of section 3.2, step for step as
# js/schema.js judgeUrl spells it, never by urlsplit: exactly https://, a bare
# host of 2+ labels, none starting with xn--, the last one 2 to 63 letters only,
# only the listed characters after it with two-hex-digit escapes, and no . or ..
# path segment. ASCII classes and no IGNORECASE, which would let U+212A KELVIN
# SIGN match [A-Za-z].
HTTPS_PREFIX = "https://"
HOST_MAX = 253
AUTHORITY_END_RE = re.compile(r"[/?#]")                                  # search
LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")  # fullmatch
IDN_RE = re.compile(r"[xX][nN]--")                                       # match
TLD_RE = re.compile(r"[A-Za-z]{2,63}")                                   # fullmatch
REST_RE = re.compile(r"[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]*")              # fullmatch
BAD_ESCAPE_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")                       # search
PATH_END_RE = re.compile(r"[?#]")                                        # search
DOT_ESCAPE_RE = re.compile(r"%2[eE]")                                    # sub

_MISSING = object()


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def unsafe_chars(s: str, paragraph: bool = False) -> bool:
    """Text safety [chars]. A body paragraph may hold a single \\n, never a blank line."""
    for ch in s:
        o = ord(ch)
        if o <= 0x1F:
            if not (paragraph and o == 0x0A):
                return True
        elif 0x7F <= o <= 0x9F or o in (0x2014, 0x2028, 0x2029):
            return True
        elif 0x202A <= o <= 0x202E or 0x2066 <= o <= 0x2069:
            return True
        elif 0xD800 <= o <= 0xDFFF:
            # json.loads joins an escaped surrogate pair into one code point,
            # so any surrogate left in a str is a lone one.
            return True
    return paragraph and "\n" in s and any(js_trim(line) == "" for line in s.split("\n"))


def day_number(iso: str):
    """Day count for a string that already matches DATE_RE, or None when it
    names no real calendar day. Integer arithmetic, mirrored in js/schema.js."""
    y, m, d = int(iso[0:4]), int(iso[5:7]), int(iso[8:10])
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    dim = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if y < 1 or m < 1 or m > 12 or d < 1 or d > dim[m - 1]:
        return None
    yy = y - 1 if m <= 2 else y
    era = yy // 400
    yoe = yy - era * 400
    doy = (153 * (m - 3 if m > 2 else m + 9) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def is_host(host: str) -> bool:
    labels = host.split(".")
    return (len(host) <= HOST_MAX and len(labels) >= 2
            and all(LABEL_RE.fullmatch(label) and not IDN_RE.match(label) for label in labels)
            and TLD_RE.fullmatch(labels[-1]) is not None)


def is_dot_segment(segment: str) -> bool:
    """A path segment that is . or .., %2e and %2E read as dots."""
    return DOT_ESCAPE_RE.sub(".", segment) in (".", "..")


def judge_url(url: str):
    """("scheme" | "format", False) for a url the grammar refuses, else (None, allowed)."""
    if not url.startswith(HTTPS_PREFIX):
        return "scheme", False
    after_scheme = url[len(HTTPS_PREFIX):]
    end = AUTHORITY_END_RE.search(after_scheme)
    host = after_scheme[:end.start()] if end else after_scheme
    rest = after_scheme[end.start():] if end else ""
    if not is_host(host) or not REST_RE.fullmatch(rest) or BAD_ESCAPE_RE.search(rest):
        return "format", False
    path_end = PATH_END_RE.search(rest)
    path = rest[:path_end.start()] if path_end else rest
    if any(is_dot_segment(segment) for segment in path.split("/")):
        return "format", False
    lower = host.lower()
    allowed = any((lower == h["host"] or (h["subdomains"] and lower.endswith("." + h["host"])))
                  and path.startswith(h["pathPrefix"]) for h in HOSTS)
    return None, allowed


def _finish(post, problems, external):
    problems.sort(key=lambda p: (p["field"], p["code"]))
    ok = not problems
    return {"ok": ok, "post": post if ok else None, "problems": problems, "external": external}


def _read_post(raw):
    """Read mode: today's lenient js/data.js normalizePost, exactly."""
    problems = []

    def add(field, code):
        problems.append({"field": field, "code": code})

    if not isinstance(raw, dict):
        add("post", "format")
        return _finish(None, problems, False)

    def trimmed(key):
        v = raw.get(key)
        return js_trim(v) if isinstance(v, str) else ""

    pid, title, date = trimmed("id"), trimmed("title"), trimmed("date")
    kind = raw.get("kind") if isinstance(raw.get("kind"), str) else ""
    if pid == "":
        add("id", "required")
    elif not ID_RE.fullmatch(pid):
        add("id", "format")
    if title == "":
        add("title", "required")
    if date == "":
        add("date", "required")
    elif not DATE_RE.fullmatch(date):
        add("date", "format")
    if kind == "":
        add("kind", "required")
    elif kind not in KINDS:
        add("kind", "format")

    rb, rl, rt = raw.get("body"), raw.get("links"), raw.get("tags")
    body = [js_trim(p) for p in rb if isinstance(p, str) and js_trim(p)] if isinstance(rb, list) else []
    links = [{"label": lk["label"], "url": lk["url"]} for lk in rl
             if isinstance(lk, dict) and isinstance(lk.get("label"), str)
             and isinstance(lk.get("url"), str) and LEGACY_LINK_RE.match(lk["url"])] if isinstance(rl, list) else []
    tags = [js_trim(t) for t in rt if isinstance(t, str) and js_trim(t)] if isinstance(rt, list) else []
    site = raw.get("site")
    external = any(judge_url(lk["url"]) == (None, False) for lk in links)
    return _finish({
        "id": pid,
        "date": date,
        "kind": kind,
        "site": js_trim(site) if isinstance(site, str) and js_trim(site) else None,
        "title": title,
        "summary": js_trim(raw["summary"]) if isinstance(raw.get("summary"), str) else "",
        "body": body,
        "links": links,
        "tags": tags,
    }, problems, external)


def _strict_post(raw, mode, today_days):
    """archive, desk and submit modes."""
    problems = []

    def add(field, code):
        problems.append({"field": field, "code": code})

    if not isinstance(raw, dict):
        add("post", "format")
        return _finish(None, problems, False)

    def safe(field, s, paragraph=False):
        if unsafe_chars(s, paragraph):
            add(field, "chars")
        if TOKEN_RE.search(s):
            add(field, "token")

    def text(field, value, cap):
        t = js_trim(value) if isinstance(value, str) else ""
        if t == "":
            add(field, "required")
            return t
        if len(t) > cap:
            add(field, "too-long")
        safe(field, t)
        return t

    def listed(field, value, cap):
        if value is _MISSING:
            return []
        if not isinstance(value, list):
            add(field, "format")
            return []
        if len(value) > cap:
            add(field, "too-many")
        return value[:cap]

    pid = raw.get("id")
    if not isinstance(pid, str) or pid == "":
        add("id", "required")
    else:
        if not ID_RE.fullmatch(pid):
            add("id", "format")
        if len(pid) > CAPS["id"]:
            add("id", "too-long")
        safe("id", pid)

    date = raw.get("date")
    date_shaped = False
    if not isinstance(date, str) or date == "":
        add("date", "required")
    else:
        if not DATE_RE.fullmatch(date):
            add("date", "format")
        else:
            date_shaped = True
            days = day_number(date)
            if days is None:
                add("date", "calendar")
            elif mode == "submit" and not (today_days - CAPS["windowPastDays"] <= days
                                           <= today_days + CAPS["windowFutureDays"]):
                add("date", "window")
        safe("date", date)

    if (mode in ("desk", "submit") and isinstance(pid, str) and pid != "" and date_shaped
            and not (pid.startswith(date + "-") and len(pid) > len(date) + 1)):
        add("id", "id-date")

    kind = raw.get("kind")
    if not isinstance(kind, str) or kind == "":
        add("kind", "required")
    else:
        if kind not in KINDS:
            add("kind", "format")
        safe("kind", kind)

    site = raw.get("site", _MISSING)
    if site is _MISSING or site is None or site == "":
        site = None
    elif not isinstance(site, str):
        add("site", "format")
    else:
        if not SITE_RE.fullmatch(site):
            add("site", "format")
        safe("site", site)

    title = text("title", raw.get("title"), CAPS["title"])
    summary = text("summary", raw.get("summary"), CAPS["summary"])

    body = []
    for i, p in enumerate(listed("body", raw.get("body", _MISSING), CAPS["body"])):
        field = f"body[{i}]"
        if not isinstance(p, str):
            add(field, "format")
            continue
        t = js_trim(p)
        if t == "":
            add(field, "required")
            continue
        if len(t) > CAPS["paragraph"]:
            add(field, "too-long")
        safe(field, t, paragraph=True)
        body.append(t)

    external = False
    links = []
    for i, lk in enumerate(listed("links", raw.get("links", _MISSING), CAPS["links"])):
        field = f"links[{i}]"
        if not isinstance(lk, dict):
            add(field, "format")
            continue
        label = text(field + ".label", lk.get("label"), CAPS["label"])
        url = lk.get("url")
        url_field = field + ".url"
        if not isinstance(url, str):
            add(url_field, "format")
        else:
            if len(url) > CAPS["url"]:
                add(url_field, "too-long")
            safe(url_field, url)
            code, allowed = judge_url(url)
            if code:
                add(url_field, code)
            elif not allowed:
                external = True
                if mode == "submit":
                    add(url_field, "host")
        links.append({"label": label, "url": url})

    tags = []
    seen = set()
    for i, t in enumerate(listed("tags", raw.get("tags", _MISSING), CAPS["tags"])):
        field = f"tags[{i}]"
        if not isinstance(t, str):
            add(field, "format")
            continue
        if not TAG_RE.fullmatch(t):
            add(field, "format")
        safe(field, t)
        if t in seen:
            add(field, "duplicate")
        seen.add(t)
        tags.append(t)

    return _finish({"id": pid, "date": date, "kind": kind, "site": site, "title": title,
                    "summary": summary, "body": body, "links": links, "tags": tags}, problems, external)


def validate_post(raw, mode, today=None):
    """Judge one raw post in read, archive, desk or submit mode. Returns
    {"ok", "post", "problems", "external"}, as js/schema.js validatePost."""
    if mode not in MODES:
        raise ValueError("validate_post: mode must be one of " + ", ".join(MODES))
    if mode == "read":
        return _read_post(raw)
    today_days = None
    if mode == "submit":
        today_days = day_number(today) if isinstance(today, str) and DATE_RE.fullmatch(today) else None
        if today_days is None:
            raise ValueError("validate_post: submit mode needs today as a real YYYY-MM-DD date")
    return _strict_post(raw, mode, today_days)


def _canonical_guard(value) -> None:
    """Refuse what js/schema.js canonicalJson refuses, so both fail alike:
    non-integer or unsafe numbers, lone surrogates, non-JSON types."""
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > 2 ** 53 - 1:
            raise TypeError("canonical_json: numbers must be safe integers")
        return
    if isinstance(value, str):
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
            raise ValueError("canonical_json: a lone surrogate has no UTF-8 form")
        return
    if isinstance(value, list):
        for item in value:
            _canonical_guard(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("canonical_json: keys must be strings")
            _canonical_guard(key)
            _canonical_guard(item)
        return
    raise TypeError("canonical_json: cannot serialize " + type(value).__name__)


def canonical_json(value) -> str:
    _canonical_guard(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_hash(post) -> str:
    """Lowercase hex SHA-256 of the UTF-8 bytes of canonical_json(post)."""
    return hashlib.sha256(canonical_json(post).encode("utf-8")).hexdigest()


def printable_id(raw, result):
    """A story's id when it is safe to print: a string with no id problem
    other than id-date. Anything else prints as null."""
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        return None
    if any(p["field"] == "id" and p["code"] != "id-date" for p in result["problems"]):
        return None
    return raw["id"]


def order_key(p):
    if not isinstance(p, dict):
        return ("", "")
    return (str(p.get("date", "")), str(p.get("id", "")))


def validate(doc: dict) -> list:
    if STRAY_POSTS.exists():
        fail("posts.json exists at the project root; the archive is data/posts.json alone, "
             "so delete the root copy")
    if not isinstance(doc, dict) or not isinstance(doc.get("posts"), list):
        fail("posts.json must be an object with a posts[] array")
    posts = doc["posts"]
    errors = []
    seen = set()
    for i, p in enumerate(posts):
        result = validate_post(p, "archive")
        pid = printable_id(p, result)
        where = f"posts[{i}]" + (f" ({pid})" if pid else "")
        errors.extend(f"{where} {prob['field']} {prob['code']}" for prob in result["problems"])
        if isinstance(p, dict) and isinstance(p.get("id"), str):
            if p["id"] in seen:
                errors.append(f"{where} repeats an earlier id")
            seen.add(p["id"])
    for i in range(1, len(posts)):
        if order_key(posts[i - 1]) < order_key(posts[i]):
            errors.append(f"posts[{i}] is out of order: posts sort by (date, id), newest first")
    for line in errors:
        print(f"build-feed: {line}", file=sys.stderr)
    if errors:
        fail(f"data/posts.json has {len(errors)} problem(s)")
    return posts


# ── Publish-time stamp of the default feed view into index.html ─────────────
# Python mirrors of the default-state renderers in js/render.js (renderCard,
# renderChips, editionLine) and js/utils.js (escHtml, fmtDate). The stamped
# markup is what JS rebuilds on load (open=false, isNew=false, filter=all),
# so the stories paint with the page and the first JS render replaces
# identical markup. The mirrors and js/render.js must change together.

SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
KIND_LABELS = {"launch": "Launch", "feature": "Feature", "fix": "Fix", "note": "Note"}


def esc_html(s) -> str:
    """Mirror of js/utils.js escHtml: exactly & < > \" in that order."""
    if s is None:
        return ""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def fmt_date(iso) -> str:
    """Mirror of js/utils.js fmtDate, including its answer for a month outside
    1..12 (SHORT_MONTHS[m - 1] is undefined there), so no date can crash it."""
    if not isinstance(iso, str) or not DATE_RE.fullmatch(iso):
        return iso if isinstance(iso, str) else ""
    mo = int(iso[5:7])
    month = SHORT_MONTHS[mo - 1] if 1 <= mo <= 12 else "undefined"
    return f"{month} {int(iso[8:10])}, {iso[:4]}"


def site_chip(p: dict) -> str:
    site = p.get("site")
    if not site:
        return '<span class="post__site post__site--fleet">fleet-wide</span>'
    return '<span class="post__site">' + esc_html(re.sub(r"-site$", "", site)) + "</span>"


def render_card(p: dict, hero: bool = False) -> str:
    """Mirror of js/render.js renderCard with open=false, isNew=false."""
    cls = "post card" + (" post--hero" if hero else "")
    body = "".join("<p>" + esc_html(par) + "</p>" for par in p.get("body", []))
    links = p.get("links", [])
    if links:
        body += ('<div class="post__links">' + "".join(
            '<a class="btn btn--ghost btn--sm" href="' + esc_html(l["url"])
            + '" target="_blank" rel="noopener noreferrer">' + esc_html(l["label"]) + " ↗</a>"
            for l in links) + "</div>")
    return ('<article class="' + cls + '" data-id="' + esc_html(p["id"])
            + '" id="post-' + esc_html(p["id"]) + '">'
            + '<div class="post__meta">'
            + '<time datetime="' + esc_html(p["date"]) + '">' + fmt_date(p["date"]) + "</time>"
            + '<span class="badge badge--' + p["kind"] + '">' + KIND_LABELS[p["kind"]] + "</span>"
            + site_chip(p)
            + "</div>"
            + '<h3 class="post__title"><button type="button" class="post__toggle" data-id="'
            + esc_html(p["id"]) + '" aria-expanded="false">' + esc_html(p["title"]) + "</button></h3>"
            + '<p class="post__summary">' + esc_html(p["summary"]) + "</p>"
            + '<div class="post__body" hidden>' + body + "</div>"
            + "</article>")


def render_chips(posts: list) -> str:
    """Mirror of js/render.js renderChips with the default filter (all)."""
    counts = {"all": len(posts), "launch": 0, "feature": 0, "fix": 0, "note": 0}
    for p in posts:
        counts[p["kind"]] += 1
    labels = {"all": "All", "launch": "Launches", "feature": "Features", "fix": "Fixes", "note": "Notes"}
    return "".join(
        '<button type="button" class="chip' + (" chip--active" if k == "all" else "")
        + '" data-filter="' + k + '" aria-pressed="' + ("true" if k == "all" else "false") + '">'
        + labels[k] + ' <span class="chip__count">' + str(counts[k]) + "</span></button>"
        for k in labels)


def edition_line(doc: dict, posts: list) -> str:
    """Mirror of js/render.js editionLine, dated by posts.json's updated field
    (JS re-stamps the visitor's own date after load, a text-only swap)."""
    date = str(doc.get("updated", ""))[:10]
    if DATE_RE.fullmatch(date) and day_number(date) is not None:
        today = f"{FULL_MONTHS[int(date[5:7]) - 1]} {int(date[8:10])}, {date[:4]}"
    else:
        today = "today"
    n = len(posts)
    return f"Edition of {today} · {n} " + ("story" if n == 1 else "stories")


def stamp_block(html: str, name: str, inner: str) -> str:
    start, end = f"<!-- gen:{name} -->", f"<!-- /gen:{name} -->"
    i, j = html.find(start), html.find(end)
    if i < 0 or j < 0:
        fail(f"index.html is missing the {name} stamp markers")
    return html[: i + len(start)] + inner + html[j:]


def stamped_index(doc: dict, posts: list) -> tuple:
    """Return (current index.html, index.html with the feed stamped in). Each
    post is stamped as the page renders it, through read mode (js/data.js
    normalizePost) rather than archive mode, so a padded label keeps its
    padding and a link keeps only its label and url, exactly as on the page."""
    current = INDEX.read_text(encoding="utf-8")
    shown = [r["post"] for r in (validate_post(p, "read") for p in posts) if r["ok"]]
    cards = "".join(render_card(p, hero=(i == 0)) for i, p in enumerate(shown))
    out = stamp_block(current, "edition", edition_line(doc, shown))
    out = stamp_block(out, "chips", render_chips(shown))
    out = stamp_block(out, "feed", cards)
    return current, out


def rfc822(date) -> str:
    """Noon UTC on a YYYY-MM-DD date in RFC 822 form, or "" for anything that
    is not a real calendar date, so an impossible date cannot crash the build."""
    if not isinstance(date, str) or not DATE_RE.fullmatch(date) or day_number(date) is None:
        return ""
    return format_datetime(datetime(int(date[:4]), int(date[5:7]), int(date[8:10]), 12, 0,
                                    tzinfo=timezone.utc))


# Everything XML 1.0's Char production excludes: most C0 controls, lone
# surrogates, U+FFFE and U+FFFF. escape() handles markup, not these.
XML_INVALID_RE = re.compile("[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


def item_xml(p: dict) -> str:
    for field in ("id", "date", "kind", "title", "summary"):
        if XML_INVALID_RE.search(str(p.get(field, ""))):
            pid = p.get("id") if isinstance(p.get("id"), str) and ID_RE.fullmatch(p["id"]) else None
            fail(f"post {pid or '(unnamed)'} {field} holds a character XML 1.0 cannot carry; "
                 "refusing to write feed.xml")
    link = f"{SITE_URL}#p={p['id']}"
    pub = rfc822(p["date"])
    return (
        "    <item>\n"
        f"      <title>{escape(p['title'])}</title>\n"
        f"      <link>{escape(link)}</link>\n"
        f"      <guid isPermaLink=\"false\">{escape(p['id'])}</guid>\n"
        + (f"      <pubDate>{pub}</pubDate>\n" if pub else "")
        + f"      <category>{escape(p['kind'])}</category>\n"
        f"      <description>{escape(p['summary'])}</description>\n"
        "    </item>"
    )


# ── Story commands: --validate-story, --merge, --selftest ────────────────────

def today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def read_input(path: str):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        unreadable(f"cannot read {path} as JSON")


def validate_story_command(path: str, mode: str, today: str) -> int:
    data = read_input(path)
    stories = data["stories"] if isinstance(data, dict) and "stories" in data else [data]
    if not isinstance(stories, list):
        unreadable(f"{path}: stories must be an array")
    results = []
    for story in stories:
        result = validate_post(story, mode, today)
        results.append({"id": printable_id(story, result), "ok": result["ok"],
                        "problems": result["problems"]})
    print(json.dumps({"results": results}))
    return 0 if all(r["ok"] for r in results) else 1


def write_atomic(path: Path, text: str) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".posts-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def merge_command(path: str, today: str) -> int:
    data = read_input(path)
    if not isinstance(data, dict) or not isinstance(data.get("stories"), list):
        unreadable(f'{path} must hold {{"stories": [...]}}')
    try:
        doc = json.loads(POSTS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        unreadable("cannot read data/posts.json")
    if not isinstance(doc, dict) or not isinstance(doc.get("posts"), list):
        unreadable("data/posts.json must be an object with a posts[] array")

    known = {}
    for p in doc["posts"]:
        if isinstance(p, dict) and isinstance(p.get("id"), str) and p["id"] not in known:
            archived = validate_post(p, "archive")
            known[p["id"]] = content_hash(archived["post"]) if archived["ok"] else None

    out = {"added": [], "identical": [], "conflict": [], "invalid": []}
    fresh = []
    for story in data["stories"]:
        result = validate_post(story, "desk")
        if not result["ok"]:
            out["invalid"].append(printable_id(story, result))
            continue
        post = result["post"]
        digest = content_hash(post)
        if post["id"] in known:
            out["identical" if known[post["id"]] == digest else "conflict"].append(post["id"])
        else:
            known[post["id"]] = digest
            fresh.append(post)
            out["added"].append(post["id"])

    if fresh:
        doc["posts"] = sorted(doc["posts"] + fresh, key=order_key, reverse=True)
        doc["updated"] = today
        write_atomic(POSTS, json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(out))
    return 0


def _same_result(got: dict, want: dict) -> bool:
    return (got["ok"] is want["ok"] and got["problems"] == want["problems"]
            and got["external"] is want["external"]
            and json.dumps(got["post"]) == json.dumps(want["post"]))


def selftest() -> int:
    try:
        post_vectors = json.loads(POST_VECTORS.read_text(encoding="utf-8"))
        hash_vectors = json.loads(HASH_VECTORS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail("selftest cannot read tests/post-vectors.json and tests/hash-vectors.json")
    rules = post_vectors["rules"]
    mismatches = []
    if list(KINDS) != rules["kinds"] or json.dumps(CAPS) != json.dumps(rules["caps"]) \
            or json.dumps(list(HOSTS)) != json.dumps(rules["hosts"]) or JS_WHITESPACE != rules["trim"]:
        mismatches.append("rules: KINDS, CAPS, HOSTS or JS_WHITESPACE differ from the vectors' rules")
    runs = 0
    for vector in post_vectors["vectors"]:
        for mode, want in vector["expect"].items():
            runs += 1
            try:
                got = validate_post(vector["raw"], mode, vector["today"])
            except (TypeError, ValueError) as err:
                mismatches.append(f"post vector {vector['name']!r} in {mode} mode raised {type(err).__name__}")
                continue
            if not _same_result(got, want):
                mismatches.append(f"post vector {vector['name']!r} in {mode} mode")
    for vector in hash_vectors["vectors"]:
        # A refusal is an answer too: None stands for "raised", and is compared,
        # so a vector refused when it should serialize is reported, not a crash.
        try:
            answer = (canonical_json(vector["value"]), content_hash(vector["value"]))
        except (TypeError, ValueError):
            answer = None
        if vector.get("error"):
            if answer is not None:
                mismatches.append(f"hash vector {vector['name']!r} should be refused")
        elif answer != (vector["canonical"], vector["sha256"]):
            mismatches.append(f"hash vector {vector['name']!r}" + (" was refused" if answer is None else ""))
    for line in mismatches:
        print(f"build-feed: selftest mismatch: {line}", file=sys.stderr)
    if mismatches:
        fail(f"selftest failed: {len(mismatches)} mismatch(es)")
    print(f"build-feed: selftest ok, {len(post_vectors['vectors'])} post vectors in {runs} mode runs, "
          f"{len(hash_vectors['vectors'])} hash vectors")
    return 0


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="build-feed.py", description=__doc__.split("\n\n")[0])
    action = ap.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="validate and fail on a stale index.html stamp")
    action.add_argument("--selftest", action="store_true", help="answer the post and hash vectors")
    action.add_argument("--validate-story", metavar="FILE", help="validate one post or {stories: [...]}")
    action.add_argument("--merge", metavar="FILE", help="merge {stories: [...]} into data/posts.json")
    ap.add_argument("--mode", choices=("desk", "submit"), help="with --validate-story (default desk)")
    ap.add_argument("--today", metavar="YYYY-MM-DD", help="with --validate-story or --merge (default: today in UTC)")
    args = ap.parse_args(argv)
    if args.mode and not args.validate_story:
        ap.error("--mode goes with --validate-story")
    if args.today is not None:
        if not (args.validate_story or args.merge):
            ap.error("--today goes with --validate-story or --merge")
        if not DATE_RE.fullmatch(args.today) or day_number(args.today) is None:
            ap.error("--today must be a real YYYY-MM-DD date")
    return args


def main() -> None:
    args = parse_args(sys.argv[1:])
    if args.selftest:
        sys.exit(selftest())
    if args.validate_story:
        sys.exit(validate_story_command(args.validate_story, args.mode or "desk", args.today or today_utc()))
    if args.merge:
        sys.exit(merge_command(args.merge, args.today or today_utc()))
    doc = json.loads(POSTS.read_text(encoding="utf-8"))
    posts = validate(doc)
    if args.check:
        current, want = stamped_index(doc, posts)
        if current != want:
            fail("index.html's stamped feed is stale against posts.json; run make feed")
        print(f"build-feed: {len(posts)} posts valid, stamped feed current")
        return
    items = "\n".join(item_xml(p) for p in posts[:FEED_ITEMS])
    now = format_datetime(datetime.now(timezone.utc))
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Antenne: Neorgon fleet news</title>
    <link>{SITE_URL}</link>
    <atom:link href="{SITE_URL}feed.xml" rel="self" type="application/rss+xml"/>
    <description>Launches, features, and fixes across the Neorgon fleet, approved at the desk before publishing</description>
    <language>en</language>
    <lastBuildDate>{now}</lastBuildDate>
{items}
  </channel>
</rss>
"""
    FEED.write_text(feed, encoding="utf-8")
    print(f"build-feed: wrote feed.xml with {min(len(posts), FEED_ITEMS)} of {len(posts)} posts")
    current, want = stamped_index(doc, posts)
    if current == want:
        print("build-feed: stamped feed already current in index.html")
    else:
        INDEX.write_text(want, encoding="utf-8")
        print(f"build-feed: stamped {len(posts)} stories into index.html")


if __name__ == "__main__":
    main()
