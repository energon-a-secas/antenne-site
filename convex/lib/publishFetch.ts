import { contentHash } from "./canonical.ts";
import { validatePost } from "./post.ts";
import { GH_RUN_ID_RE, RUN_URL_RE } from "./publishCore.ts";

// Everything the publish bridge asks of the network
// (docs/plans/2026-09-15-antenne-desk.md section 6.1): the workflow dispatch,
// an archive read (a commit's data/posts.json, or the live one), and a link
// check. fetch is an argument, so tests run each one against a fake; the
// actions in convex/publish.ts and convex/links.ts pass the runtime's own.
//
// Nothing here throws for anything the network does. A failure comes back as
// a short ASCII word, because it is stored (publishRuns.error, linkChecks) and
// /status passes publishRuns.error on to the watchdog: never an error's
// message, which can quote the request, and the dispatch request carries the
// token.

export type FetchLike = (url: string, init?: Record<string, any>) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const REPO = "energon-a-secas/antenne-site";
export const DISPATCH_URL = `https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/dispatches`;
export const LIVE_URL = "https://antenne.neorgon.com/data/posts.json";
export const DISPATCH_TIMEOUT_MS = 10000;
export const LINK_TIMEOUT_MS = 8000;
export const ARCHIVE_TIMEOUT_MS = 15000;
/**
 * Stories one archive read hashes and one verifyCommit resyncs into
 * publishedIds (the file is newest first). Each is one indexed read in the
 * recording mutation, well under Convex's per-transaction limits.
 */
export const PUBLISHED_SYNC_MAX = 1000;
const USER_AGENT = "antenne-desk";
const DNS_RE = /ENOTFOUND|dns error|failed to lookup address|name or service not known|nodename nor servname/i;

export type DispatchOutcome =
  | { kind: "ok"; status: number; ghRunId: string | null; runUrl: string | null }
  | { kind: "status"; status: number }
  | { kind: "error"; error: "timeout" | "network" | "no-token" };
export type ArchiveStory = { storyId: string; contentHash: string };
export type ArchiveRead = { ok: true; stories: ArchiveStory[]; complete: boolean } | { ok: false; error: string };
export type LinkCheck = { url: string; status: number | "timeout" | "dns" | "network"; blocking: boolean };

export function rawArchiveUrl(sha: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${sha}/data/posts.json`;
}

/** fetch with an AbortController that aborts after ms. */
async function timed(fetcher: FetchLike, url: string, init: Record<string, any>, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  const name = err !== null && typeof err === "object" ? (err as { name?: unknown }).name : null;
  return name === "AbortError" || name === "TimeoutError";
}

/** The codes and messages of an error and its cause, only to match DNS_RE against. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: any = err, depth = 0; e && typeof e === "object" && depth < 3; e = e.cause, depth++) {
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.message === "string") parts.push(e.message);
  }
  return parts.join(" ");
}

/** A name that does not resolve. A temporary resolver failure (EAI_AGAIN) is not one: it is only a warning. */
export function isDnsFailure(err: unknown): boolean {
  const text = errorText(err);
  return DNS_RE.test(text) && !/EAI_AGAIN/.test(text);
}

/** True for a link on neorgon.com or one of its subdomains, the only links a check can block. */
export function isNeorgonLink(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  const host = url.slice(8).split(/[/?#]/)[0].toLowerCase();
  return host === "neorgon.com" || host.endsWith(".neorgon.com");
}

async function jsonOrNull(res: { json(): Promise<unknown> }): Promise<any> {
  try {
    return await res.json();
  } catch {
    // A 200 without a JSON body still dispatched the run; it just names no run id.
    return null;
  }
}

/**
 * POST the publish.yml workflow_dispatch for runId. 204, or 200 with the run's
 * id and page, dispatched it; any other status, a timeout or no token did not.
 */
export async function dispatchRequest(fetcher: FetchLike, token: string | null | undefined, runId: string, timeoutMs = DISPATCH_TIMEOUT_MS): Promise<DispatchOutcome> {
  if (typeof token !== "string" || token.trim() === "") return { kind: "error", error: "no-token" };
  let res;
  try {
    res = await timed(fetcher, DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT, "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { run_id: runId } }),
    }, timeoutMs);
  } catch (err) {
    // Reduced to a word, never the error itself: see the note at the top.
    return { kind: "error", error: isAbort(err) ? "timeout" : "network" };
  }
  if (res.status === 204) return { kind: "ok", status: 204, ghRunId: null, runUrl: null };
  if (res.status !== 200) return { kind: "status", status: res.status };
  const body = await jsonOrNull(res);
  const id = body !== null && typeof body === "object" ? body.workflow_run_id : null;
  const url = body !== null && typeof body === "object" ? body.html_url : null;
  const ghRunId = Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === "string" && GH_RUN_ID_RE.test(id) ? id : null;
  return { kind: "ok", status: 200, ghRunId, runUrl: typeof url === "string" && RUN_URL_RE.test(url) ? url : null };
}

/**
 * A posts.json as ids and content hashes: each post normalized in archive
 * mode, as build-feed.py --merge compares them. complete is false when a post
 * was skipped (invalid, repeated) or the file holds more than
 * PUBLISHED_SYNC_MAX, so a resync never deletes on a partial view.
 */
export async function readArchive(fetcher: FetchLike, url: string, timeoutMs = ARCHIVE_TIMEOUT_MS): Promise<ArchiveRead> {
  let doc: any;
  try {
    const res = await timed(fetcher, url, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }, timeoutMs);
    if (res.status !== 200) return { ok: false, error: String(res.status) };
    doc = JSON.parse(await res.text());
  } catch (err) {
    return { ok: false, error: isAbort(err) ? "timeout" : err instanceof SyntaxError ? "format" : "network" };
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.posts)) return { ok: false, error: "format" };
  const stories: ArchiveStory[] = [];
  const seen = new Set<string>();
  let complete = true;
  for (const raw of doc.posts) {
    if (stories.length >= PUBLISHED_SYNC_MAX) return { ok: true, stories, complete: false };
    const verdict = validatePost(raw, { mode: "archive" });
    if (!verdict.ok || verdict.post === null || seen.has(verdict.post.id)) {
      complete = false;
      continue;
    }
    seen.add(verdict.post.id);
    stories.push({ storyId: verdict.post.id, contentHash: await contentHash(verdict.post) });
  }
  return { ok: true, stories, complete };
}

/**
 * One link: HEAD, then GET when HEAD answers 405, each with its own timeout,
 * redirects followed. Blocking only for a neorgon.com link answering 404 or
 * 410 or whose name does not resolve; a timeout, a 5xx or anything off
 * neorgon.com is a warning.
 */
export async function checkLink(fetcher: FetchLike, url: string, timeoutMs = LINK_TIMEOUT_MS): Promise<LinkCheck> {
  const ours = isNeorgonLink(url);
  const init = { redirect: "follow", headers: { "User-Agent": USER_AGENT } };
  try {
    let res = await timed(fetcher, url, { ...init, method: "HEAD" }, timeoutMs);
    if (res.status === 405) res = await timed(fetcher, url, { ...init, method: "GET" }, timeoutMs);
    return { url, status: res.status, blocking: ours && (res.status === 404 || res.status === 410) };
  } catch (err) {
    const status = isAbort(err) ? "timeout" : isDnsFailure(err) ? "dns" : "network";
    return { url, status, blocking: ours && status === "dns" };
  }
}

export async function checkLinks(fetcher: FetchLike, urls: readonly string[], timeoutMs = LINK_TIMEOUT_MS): Promise<LinkCheck[]> {
  return await Promise.all(urls.map((url) => checkLink(fetcher, url, timeoutMs)));
}
