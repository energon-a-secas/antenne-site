import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { isFrozen } from "./access.ts";
import { recordEvent } from "./draftsCore.ts";
import { QUEUE_PER_STATUS_MAX, RUN_MAX_ATTEMPTS } from "./limits.ts";
import {
  GH_RUN_ID_RE, RUN_URL_RE, SHA_RE, SYSTEM_ACTOR, allCommitted, claimedDrafts, finishRun, invalid, retryOrFail, runById,
} from "./publishCore.ts";
import type { PublishIntent, WithPublishIntents } from "./publishCore.ts";
import { PUBLISHED_SYNC_MAX } from "./publishFetch.ts";
import type { ArchiveStory, LinkCheck } from "./publishFetch.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";
import type { MachineEnv } from "./submitCore.ts";

// What the publish and links actions record once their fetch has answered
// (docs/plans/2026-09-15-antenne-desk.md section 6.1): the dispatch, a
// verified commit, the live archive, a link check. Actions cannot write, so
// each hands its answer to an internal mutation over one of these cores. Every
// one refuses while DESK_FROZEN is 1, as every mutation does, and ignores an
// answer that arrives after its run or draft moved on.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

const HASH_RE = /^[0-9a-f]{64}$/;
const STORY_ID_RE = /^[a-z0-9-]{1,80}$/;
const WORD_RE = /^[a-z0-9 -]{1,40}$/;
const LINK_WORDS: readonly string[] = Object.freeze(["timeout", "dns", "network"]);
const FROZEN = "The desk is frozen: reading works, changes are paused.";

async function draftById(db: Reader, raw: unknown): Promise<any> {
  if (typeof raw !== "string" || raw === "" || raw.length > 64) return null;
  const id = db.normalizeId("drafts", raw);
  return id === null ? null : await db.get("drafts", id);
}

// ── publish:dispatch ──────────────────────────────────────────────────────────

/**
 * Before the request: a queued run becomes dispatched, so a second dispatch
 * of the same run (the scheduler and reconcile both asking) finds it taken and
 * sends nothing. Frozen, missing or not queued: go is false and nothing is
 * written. A run out of attempts is failed instead.
 */
export async function beginDispatchCore(db: Db, args: { runId?: unknown }, now: number, env: MachineEnv): Promise<{ go: boolean; code: string; dispatchedAt: number | null; intents: PublishIntent[] }> {
  const no = (code: string, intents: PublishIntent[] = []) => ({ go: false, code, dispatchedAt: null, intents });
  if (isFrozen(env)) return no("frozen");
  const run = await runById(db, args.runId);
  if (run === null) return no("not-found");
  if (run.state !== "queued") return no("status");
  if (run.attempts >= RUN_MAX_ATTEMPTS) return no("failed", await finishRun(db, run, "failed", { error: run.error ?? "attempts" }, now));
  await db.patch("publishRuns", run._id, { state: "dispatched", dispatchedAt: now, updatedAt: now });
  return { go: true, code: "ok", dispatchedAt: now, intents: [] };
}

/** The stored error for a dispatch that did not land: "dispatch 401", "dispatch timeout" and so on. Never more. */
export function dispatchError(outcome: any): string {
  if (outcome && outcome.kind === "status" && Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599) return `dispatch ${outcome.status}`;
  if (outcome && outcome.kind === "error" && ["timeout", "network", "no-token"].includes(outcome.error)) return `dispatch ${outcome.error}`;
  return "dispatch unknown";
}

/**
 * After the request. 200 or 204: the run stays dispatched, with the GitHub
 * run id and page when a 200 named them. Anything else spends an attempt: a
 * timeout leaves the run dispatched (GitHub may have taken it, and a stale
 * dispatch is sent again after DISPATCH_STALE_MS); any other failure requeues
 * it for reconcile, or fails it at RUN_MAX_ATTEMPTS.
 */
export async function dispatchResultCore(db: Db, args: { runId?: unknown; dispatchedAt?: unknown; outcome?: any }, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  if (isFrozen(env)) return { result: fail("frozen", FROZEN), intents: [] };
  const run = await runById(db, args.runId);
  if (run === null || run.state !== "dispatched" || run.dispatchedAt !== args.dispatchedAt) return { result: done({ ignored: true }), intents: [] };
  const o = args.outcome;
  if (o && o.kind === "ok" && (o.status === 200 || o.status === 204)) {
    const ghRunId = typeof o.ghRunId === "string" && GH_RUN_ID_RE.test(o.ghRunId) ? o.ghRunId : run.ghRunId;
    const runUrl = typeof o.runUrl === "string" && RUN_URL_RE.test(o.runUrl) ? o.runUrl : run.runUrl;
    await db.patch("publishRuns", run._id, { ghRunId, runUrl, error: null, updatedAt: now });
    return { result: done(), intents: [] };
  }
  const error = dispatchError(o);
  if (o && o.kind === "error" && o.error === "timeout") {
    const attempts = run.attempts + 1;
    if (attempts >= RUN_MAX_ATTEMPTS) return { result: done(), intents: await finishRun(db, run, "failed", { attempts, error }, now) };
    await db.patch("publishRuns", run._id, { attempts, error, updatedAt: now });
    return { result: done(), intents: [] };
  }
  return { result: done(), intents: (await retryOrFail(db, run, error, now)).intents };
}

// ── publish:verifyCommit and publish:checkLive ────────────────────────────────

function archiveStories(raw: unknown): ArchiveStory[] | null {
  if (!Array.isArray(raw) || raw.length > PUBLISHED_SYNC_MAX) return null;
  const out: ArchiveStory[] = [];
  for (const s of raw) {
    if (!s || typeof s.storyId !== "string" || !STORY_ID_RE.test(s.storyId) || typeof s.contentHash !== "string" || !HASH_RE.test(s.contentHash)) return null;
    out.push({ storyId: s.storyId, contentHash: s.contentHash });
  }
  return out;
}

/**
 * publishedIds made to match the archive at sha: missing ids added, changed
 * hashes updated, and, only when the read was complete, ids the archive no
 * longer holds removed.
 */
async function syncPublished(db: Db, stories: ArchiveStory[], complete: boolean, sha: string, now: number): Promise<{ added: number; changed: number; removed: number }> {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const s of stories) {
    const row = await db.query("publishedIds").withIndex("by_storyId", (q: any) => q.eq("storyId", s.storyId)).first();
    if (row === null) {
      await db.insert("publishedIds", { storyId: s.storyId, contentHash: s.contentHash, commitSha: sha, at: now });
      counts.added += 1;
    } else if (row.contentHash !== s.contentHash) {
      await db.patch("publishedIds", row._id, { contentHash: s.contentHash, commitSha: sha, at: now });
      counts.changed += 1;
    }
  }
  if (!complete || stories.length === 0) return counts;
  const ids = new Set(stories.map((s) => s.storyId));
  const rows = await db.query("publishedIds").withIndex("by_storyId").take(PUBLISHED_SYNC_MAX + 1);
  if (rows.length > PUBLISHED_SYNC_MAX) return counts;
  for (const row of rows) {
    if (ids.has(row.storyId)) continue;
    await db.delete("publishedIds", row._id);
    counts.removed += 1;
  }
  return counts;
}

/**
 * verifyCommit's answer for the run's sha: each draft the run holds whose
 * story is in the archive with contentHash equal to approvedHash becomes
 * committed at that sha; publishedIds is resynced from the archive; a built
 * run whose drafts are all committed is done. A read that failed is stored as
 * the run's error ("verify 404"), and reconcile asks again.
 */
export async function recordCommitCore(db: Db, args: { runId?: unknown; sha?: unknown; stories?: unknown; complete?: unknown; error?: unknown }, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  if (isFrozen(env)) return { result: fail("frozen", FROZEN), intents: [] };
  if (typeof args.sha !== "string" || !SHA_RE.test(args.sha)) return { result: invalid([{ field: "sha", code: "format" }]), intents: [] };
  const sha = args.sha;
  const run = await runById(db, args.runId);
  if (run === null || run.commitSha !== sha || (run.state !== "pushed" && run.state !== "built")) return { result: done({ ignored: true }), intents: [] };
  if (args.error !== undefined) {
    if (typeof args.error !== "string" || !WORD_RE.test(args.error)) return { result: invalid([{ field: "error", code: "format" }]), intents: [] };
    await db.patch("publishRuns", run._id, { error: `verify ${args.error}` });
    return { result: done({ committed: 0 }), intents: [] };
  }
  const stories = archiveStories(args.stories);
  if (stories === null) return { result: invalid([{ field: "stories", code: "format" }]), intents: [] };
  const hashes = new Map(stories.map((s) => [s.storyId, s.contentHash]));
  let committed = 0;
  for (const d of await claimedDrafts(db, run._id)) {
    if (d.status !== "publishing" || hashes.get(d.storyId) !== d.approvedHash) continue;
    const rev = d.rev + 1;
    await db.patch("drafts", d._id, { status: "committed", commitSha: sha, committedAt: now, rev, updatedAt: now });
    await recordEvent(db, d, SYSTEM_ACTOR, "commit", { rev, runId: run._id, commitSha: sha, from: "publishing", to: "committed" }, now);
    committed += 1;
  }
  const synced = await syncPublished(db, stories, args.complete === true, sha, now);
  const intents = run.state === "built" && (await allCommitted(db, run._id)) ? await finishRun(db, run, "done", { error: null }, now) : [];
  return { result: done({ committed, ...synced }), intents };
}

/** The note a draft goes live with when its story is live under another hash than the one approved. */
export const EDITED_NOTE = "edited";

/**
 * checkLive's answer. A committed draft whose story is live with contentHash
 * equal to approvedHash becomes live. One whose story is live under another
 * hash (edited on main after its commit, before a live read saw it) becomes
 * live too, with note "edited", so it cannot stay committed for good (the
 * review decision of 2026-09-22). A draft whose story is not in the live
 * archive stays committed.
 */
export async function recordLiveCore(db: Db, args: { stories?: unknown }, now: number, env: MachineEnv): Promise<Result> {
  if (isFrozen(env)) return fail("frozen", FROZEN);
  const stories = archiveStories(args.stories);
  if (stories === null) return invalid([{ field: "stories", code: "format" }]);
  const hashes = new Map(stories.map((s) => [s.storyId, s.contentHash]));
  let live = 0;
  for (const d of await db.query("drafts").withIndex("by_status", (q: any) => q.eq("status", "committed")).take(QUEUE_PER_STATUS_MAX)) {
    const hash = hashes.get(d.storyId);
    if (hash === undefined) continue;
    const rev = d.rev + 1;
    const detail = { rev, commitSha: d.commitSha, from: "committed", to: "live" };
    if (hash === d.approvedHash) {
      await db.patch("drafts", d._id, { status: "live", rev, updatedAt: now });
      await recordEvent(db, d, SYSTEM_ACTOR, "live", detail, now);
    } else {
      await db.patch("drafts", d._id, { status: "live", note: EDITED_NOTE, rev, updatedAt: now });
      await recordEvent(db, d, SYSTEM_ACTOR, "live", { ...detail, edited: true, contentHash: hash }, now);
    }
    live += 1;
  }
  return done({ live });
}

/** True while any draft is committed and not yet seen live, so checkLive only reads the site when it could learn something. */
export async function liveWantedCore(db: Reader): Promise<boolean> {
  return (await db.query("drafts").withIndex("by_status", (q: any) => q.eq("status", "committed")).first()) !== null;
}

// ── links:check ───────────────────────────────────────────────────────────────

function linkUrls(post: any): string[] {
  const links = post && Array.isArray(post.links) ? post.links : [];
  return [...new Set<string>(links.map((l: any) => (l && typeof l.url === "string" ? l.url : "")).filter(Boolean))];
}

/** The urls a check should visit: a pending or approved draft's links. null when there is nothing to check, or while frozen. */
export async function linkTargetCore(db: Reader, args: { draftId?: unknown }, env: MachineEnv): Promise<{ urls: string[] } | null> {
  if (isFrozen(env)) return null;
  const draft = await draftById(db, args.draftId);
  if (draft === null || (draft.status !== "pending" && draft.status !== "approved")) return null;
  return { urls: linkUrls(draft.post) };
}

function validChecks(raw: unknown): LinkCheck[] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: LinkCheck[] = [];
  for (const c of raw) {
    const statusOk = c && ((Number.isInteger(c.status) && c.status >= 100 && c.status <= 599) || LINK_WORDS.includes(c.status));
    if (!c || typeof c.url !== "string" || c.url.length > 300 || !statusOk || typeof c.blocking !== "boolean") return null;
    out.push({ url: c.url, status: c.status, blocking: c.blocking });
  }
  return out;
}

/**
 * links:record: linkChecks becomes [{ url, status, blocking }] for the urls
 * the draft still links, in its link order. It changes no rev: approve reads
 * linkChecks when it runs, so a card loaded before the check stays current.
 */
export async function recordLinksCore(db: Db, args: { draftId?: unknown; checks?: unknown }, now: number, env: MachineEnv): Promise<Result> {
  if (isFrozen(env)) return fail("frozen", FROZEN);
  const checks = validChecks(args.checks);
  if (checks === null) return invalid([{ field: "checks", code: "format" }]);
  const draft = await draftById(db, args.draftId);
  if (draft === null || (draft.status !== "pending" && draft.status !== "approved")) return done({ recorded: 0 });
  const byUrl = new Map(checks.map((c) => [c.url, c]));
  const kept = linkUrls(draft.post).filter((url) => byUrl.has(url)).map((url) => byUrl.get(url) as LinkCheck);
  await db.patch("drafts", draft._id, { linkChecks: kept });
  await recordEvent(db, draft, "antenne:links", "links-checked", { checked: kept.length, blocking: kept.filter((c) => c.blocking).length }, now);
  return done({ recorded: kept.length });
}
