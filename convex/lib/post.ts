// ── Post rules: the server's enforcer ────────────────────────
// js/schema.js spelled again in TypeScript, step for step and name for name
// (docs/plans/2026-09-15-antenne-desk.md section 3). Convex bundles convex/ on
// its own, so the server keeps its own copy, and tests/post-mirror.test.mjs
// holds it to the same tests/post-vectors.json and tests/hash-vectors.json as
// js/schema.js and scripts/build-feed.py. Change a rule in the vectors first,
// then in all three. Pure: no clock (submit mode is handed today), no env.
//
// checkText at the end is this file's one addition: the title rules, for the
// other strings the desk stores (a member label, a note).

import { canonicalJson, contentHash, loneSurrogate } from "./canonical.ts";

export { canonicalJson, contentHash };

export type Mode = "read" | "archive" | "desk" | "submit";
export type Problem = { field: string; code: string };
export type Link = { label: string; url: string };
export type Post = {
  id: string;
  date: string;
  kind: string;
  site: string | null;
  title: string;
  summary: string;
  body: string[];
  links: Link[];
  tags: string[];
};
export type Verdict = { ok: boolean; post: Post | null; problems: Problem[]; external: boolean };

export const KINDS: readonly string[] = Object.freeze(["launch", "feature", "fix", "note"]);

// Caps sit above the 30-post archive measured on 2026-09-15 (id 55, title 54,
// summary 222, 3 paragraphs of 477, 4 links, label 22, url 37, 4 tags).
export const CAPS = Object.freeze({
  id: 80,
  site: 40,
  title: 100,
  summary: 320,
  body: 5,
  paragraph: 900,
  links: 6,
  label: 40,
  url: 300,
  tags: 8,
  tag: 32,
  windowPastDays: 60,
  windowFutureDays: 1,
});

// A link to any other host sets `external`; in submit mode it is a problem.
export const HOSTS = Object.freeze([
  Object.freeze({ host: "neorgon.com", subdomains: true, pathPrefix: "" }),
  Object.freeze({ host: "github.com", subdomains: false, pathPrefix: "/energon-a-secas/" }),
]);

const MODES: readonly string[] = ["read", "archive", "desk", "submit"];

// Ids go unencoded into #p= links, element ids and RSS guids, so they are
// valid by construction rather than escaped at every use site.
const ID_RE = /^[a-z0-9-]+$/;
// [0-9], not \d: the Python mirror would read \d as any Unicode digit.
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SITE_RE = new RegExp("^[a-z0-9-]{1," + CAPS.site + "}$");
const TAG_RE = new RegExp("^[a-z0-9-]{1," + CAPS.tag + "}$");
const TOKEN_RE = /sk-ant-|ghp_|gho_|ghs_|github_pat_|sk_live_|sk_test_|xox[abprs]-|AKIA[0-9A-Z]{16}|-----BEGIN/;
const LEGACY_LINK_RE = /^https?:\/\//;

// A link url is judged by the pinned grammar of section 3.2, never by new URL()
// or a platform parser, which repair input differently. The steps:
// - exactly https:// in lowercase, else [scheme];
// - the authority, up to the first / ? or #, is a bare host: dot-separated
//   labels of 1 to 63 ASCII letters, digits or hyphens, no hyphen at either
//   end, none starting with xn--, at least two labels, the last one 2 to 63
//   letters only, 253 characters at most. So @ : % (credentials, port,
//   escapes), IPv4, a numeric or 0x hex top-level label, an IDN host and a
//   trailing dot are all [format];
// - the rest holds only the listed characters, each % starts an escape of two
//   hex digits, and no path segment is . or .. however it is spelled [format].
// ASCII classes throughout and no i flag, so no letter outside A-Z matches.
const HTTPS_PREFIX = "https://";
const HOST_MAX = 253;
const AUTHORITY_END_RE = /[\/?#]/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// A browser refuses an xn-- label that is not valid Punycode, which no pattern
// can check, so every xn-- label is refused. A last label of letters only is
// never a number to the URL Standard, which reads a.1 and a.0x1 as IPv4.
const IDN_RE = /^[xX][nN]--/;
const TLD_RE = /^[A-Za-z]{2,63}$/;
const REST_RE = /^[A-Za-z0-9\-._~:\/?#@!$&'()*+,;=%]*$/;
const BAD_ESCAPE_RE = /%(?![0-9A-Fa-f]{2})/;
const PATH_END_RE = /[?#]/;
const DOT_ESCAPE_RE = /%2[eE]/g;

/** Length in code points (a lone surrogate counts as one), as Python's len. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/** Text safety [chars]. A body paragraph may hold a single \n, never a blank line. */
function unsafeChars(s: string, paragraph: boolean): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f) {
      if (!(paragraph && c === 0x0a)) return true;
    } else if (c >= 0x7f && c <= 0x9f) return true;
    else if (c === 0x2014 || c === 0x2028 || c === 0x2029) return true;
    else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  if (loneSurrogate(s)) return true;
  return paragraph && s.includes("\n") && s.split("\n").some((line) => line.trim() === "");
}

/** Day count for a YYYY-MM-DD string that already matches DATE_RE, or null
    when it names no real calendar day. Integer arithmetic, no Date. */
function dayNumber(iso: string): number | null {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > dim[m - 1]) return null;
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isHost(host: string): boolean {
  const labels = host.split(".");
  return host.length <= HOST_MAX && labels.length >= 2
    && labels.every((label) => LABEL_RE.test(label) && !IDN_RE.test(label))
    && TLD_RE.test(labels[labels.length - 1]);
}

/** A path segment that is . or .., %2e and %2E read as dots. */
function isDotSegment(segment: string): boolean {
  const plain = segment.replace(DOT_ESCAPE_RE, ".");
  return plain === "." || plain === "..";
}

/** { code: 'scheme' | 'format' } for a url the grammar refuses, else { code: null, allowed }. */
function judgeUrl(url: string): { code: string | null; allowed: boolean } {
  if (!url.startsWith(HTTPS_PREFIX)) return { code: "scheme", allowed: false };
  const afterScheme = url.slice(HTTPS_PREFIX.length);
  const end = afterScheme.search(AUTHORITY_END_RE);
  const host = end < 0 ? afterScheme : afterScheme.slice(0, end);
  const rest = end < 0 ? "" : afterScheme.slice(end);
  if (!isHost(host) || !REST_RE.test(rest) || BAD_ESCAPE_RE.test(rest)) return { code: "format", allowed: false };
  const pathEnd = rest.search(PATH_END_RE);
  const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
  if (path.split("/").some(isDotSegment)) return { code: "format", allowed: false };
  const lower = host.toLowerCase();
  const allowed = HOSTS.some((h) => (lower === h.host || (h.subdomains && lower.endsWith("." + h.host)))
    && path.startsWith(h.pathPrefix));
  return { code: null, allowed };
}

function isObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sortProblems(problems: Problem[]): Problem[] {
  return problems.sort((a, b) => {
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
}

function finish(post: any, problems: Problem[], external: boolean): Verdict {
  sortProblems(problems);
  const ok = problems.length === 0;
  return { ok, post: ok ? post : null, problems, external };
}

// ── read: today's lenient js/data.js normalizePost, exactly ──
// Drops a post without a usable id, title, date and kind; filters bad links
// and empty strings; no clock, no caps. Links come back as { label, url }.
function readPost(raw: unknown): Verdict {
  const problems: Problem[] = [];
  const add = (field: string, code: string) => problems.push({ field, code });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    add("post", "format");
    return finish(null, problems, false);
  }
  const r = raw as Record<string, any>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const date = typeof r.date === "string" ? r.date.trim() : "";
  const kind = typeof r.kind === "string" ? r.kind : "";
  if (id === "") add("id", "required");
  else if (!ID_RE.test(id)) add("id", "format");
  if (title === "") add("title", "required");
  if (date === "") add("date", "required");
  else if (!DATE_RE.test(date)) add("date", "format");
  if (kind === "") add("kind", "required");
  else if (!KINDS.includes(kind)) add("kind", "format");

  const body = Array.isArray(r.body)
    ? r.body.filter((p: any) => typeof p === "string" && p.trim()).map((p: string) => p.trim())
    : [];
  const links: Link[] = Array.isArray(r.links)
    ? r.links.filter((l: any) => l && typeof l.label === "string" && typeof l.url === "string"
        && LEGACY_LINK_RE.test(l.url)).map((l: any) => ({ label: l.label, url: l.url }))
    : [];
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t: any) => typeof t === "string" && t.trim()).map((t: string) => t.trim())
    : [];
  const external = links.some((l) => {
    const u = judgeUrl(l.url);
    return u.code === null && !u.allowed;
  });
  return finish({
    id,
    date,
    kind,
    site: typeof r.site === "string" && r.site.trim() ? r.site.trim() : null,
    title,
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    body,
    links,
    tags,
  }, problems, external);
}

// ── archive, desk, submit ────────────────────────────────────
function strictPost(raw: unknown, mode: string, todayDays: number | null): Verdict {
  const problems: Problem[] = [];
  const add = (field: string, code: string) => problems.push({ field, code });
  if (!isObject(raw)) {
    add("post", "format");
    return finish(null, problems, false);
  }
  const safe = (field: string, s: string, paragraph: boolean) => {
    if (unsafeChars(s, paragraph)) add(field, "chars");
    if (TOKEN_RE.test(s)) add(field, "token");
  };
  const text = (field: string, value: unknown, cap: number): string => {
    const t = typeof value === "string" ? value.trim() : "";
    if (t === "") {
      add(field, "required");
      return t;
    }
    if (codePoints(t) > cap) add(field, "too-long");
    safe(field, t, false);
    return t;
  };
  const list = (field: string, value: unknown, cap: number): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      add(field, "format");
      return [];
    }
    if (value.length > cap) add(field, "too-many");
    return value.slice(0, cap);
  };

  const id = raw.id;
  if (typeof id !== "string" || id === "") add("id", "required");
  else {
    if (!ID_RE.test(id)) add("id", "format");
    if (codePoints(id) > CAPS.id) add("id", "too-long");
    safe("id", id, false);
  }

  const date = raw.date;
  let dateShaped = false;
  if (typeof date !== "string" || date === "") add("date", "required");
  else {
    if (!DATE_RE.test(date)) add("date", "format");
    else {
      dateShaped = true;
      const days = dayNumber(date);
      if (days === null) add("date", "calendar");
      else if (mode === "submit" && todayDays !== null
        && (days < todayDays - CAPS.windowPastDays || days > todayDays + CAPS.windowFutureDays)) {
        add("date", "window");
      }
    }
    safe("date", date, false);
  }

  if ((mode === "desk" || mode === "submit") && typeof id === "string" && id !== "" && dateShaped
    && !(id.startsWith(date + "-") && id.length > date.length + 1)) {
    add("id", "id-date");
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || kind === "") add("kind", "required");
  else {
    if (!KINDS.includes(kind)) add("kind", "format");
    safe("kind", kind, false);
  }

  let site = raw.site;
  if (site === undefined || site === null || site === "") site = null;
  else if (typeof site !== "string") add("site", "format");
  else {
    if (!SITE_RE.test(site)) add("site", "format");
    safe("site", site, false);
  }

  const title = text("title", raw.title, CAPS.title);
  const summary = text("summary", raw.summary, CAPS.summary);

  const body: string[] = [];
  list("body", raw.body, CAPS.body).forEach((p, i) => {
    const field = "body[" + i + "]";
    if (typeof p !== "string") {
      add(field, "format");
      return;
    }
    const t = p.trim();
    if (t === "") {
      add(field, "required");
      return;
    }
    if (codePoints(t) > CAPS.paragraph) add(field, "too-long");
    safe(field, t, true);
    body.push(t);
  });

  let external = false;
  const links: { label: string; url: unknown }[] = [];
  list("links", raw.links, CAPS.links).forEach((l, i) => {
    const field = "links[" + i + "]";
    if (!isObject(l)) {
      add(field, "format");
      return;
    }
    const label = text(field + ".label", l.label, CAPS.label);
    const url = l.url;
    const urlField = field + ".url";
    if (typeof url !== "string") add(urlField, "format");
    else {
      if (codePoints(url) > CAPS.url) add(urlField, "too-long");
      safe(urlField, url, false);
      const judged = judgeUrl(url);
      if (judged.code) add(urlField, judged.code);
      else if (!judged.allowed) {
        external = true;
        if (mode === "submit") add(urlField, "host");
      }
    }
    links.push({ label, url });
  });

  const tags: string[] = [];
  const seen = new Set<string>();
  list("tags", raw.tags, CAPS.tags).forEach((t, i) => {
    const field = "tags[" + i + "]";
    if (typeof t !== "string") {
      add(field, "format");
      return;
    }
    if (!TAG_RE.test(t)) add(field, "format");
    safe(field, t, false);
    if (seen.has(t)) add(field, "duplicate");
    seen.add(t);
    tags.push(t);
  });

  return finish({ id, date, kind, site, title, summary, body, links, tags }, problems, external);
}

/**
 * Judge one raw post. `mode` is read, archive, desk or submit; `today`
 * (YYYY-MM-DD) is read only by submit. Returns { ok, post, problems, external }:
 * `post` is the normalized post when ok, else null; `problems` is
 * [{ field, code }] sorted by field then code.
 */
export function validatePost(raw: unknown, { mode, today }: { mode?: unknown; today?: unknown } = {}): Verdict {
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    throw new TypeError("validatePost: mode must be one of " + MODES.join(", "));
  }
  if (mode === "read") return readPost(raw);
  let todayDays: number | null = null;
  if (mode === "submit") {
    todayDays = typeof today === "string" && DATE_RE.test(today) ? dayNumber(today) : null;
    if (todayDays === null) throw new TypeError("validatePost: submit mode needs today as a real YYYY-MM-DD date");
  }
  return strictPost(raw, mode, todayDays);
}

/**
 * The title rules for another stored string: trimmed, 1 to cap code points
 * [required, too-long], text safety [chars] and no token-like text [token].
 * Returns the trimmed text and its problems, sorted like validatePost's.
 */
export function checkText(field: string, value: unknown, cap: number): { text: string; problems: Problem[] } {
  const problems: Problem[] = [];
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") problems.push({ field, code: "required" });
  else {
    if (codePoints(text) > cap) problems.push({ field, code: "too-long" });
    if (unsafeChars(text, false)) problems.push({ field, code: "chars" });
    if (TOKEN_RE.test(text)) problems.push({ field, code: "token" });
  }
  return { text, problems: sortProblems(problems) };
}
