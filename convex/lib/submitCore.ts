import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { authorize, guardWrite, principalOf } from "./access.ts";
import type { Caller, DeskEnv, Machine, MachineAction, Scope } from "./access.ts";
import { canonicalJson, contentHash } from "./canonical.ts";
import { STATUSES, newDraft, recordEvent } from "./draftsCore.ts";
import type { Intent } from "./draftsCore.ts";
import { LIVE_SHOWN_MS, MACHINE_PENDING_MAX, QUEUE_PER_STATUS_MAX, SPIKED_SHOWN_MS, SUBMIT_BATCH_MAX } from "./limits.ts";
import { validatePost } from "./post.ts";
import type { Post, Problem } from "./post.ts";
import { recordRate, refuseIfLimited } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";
import { eligibleDefaultAssignee } from "./settingsCore.ts";
import { machineKeyIds, scopeForPath } from "./signature.ts";

// POST /submit and POST /status (docs/plans/2026-09-15-antenne-desk.md
// section 5), plus the per-key meter a query route needs. The caller is always
// a Machine that convex/lib/routes.ts built from a verified key; a human, or a
// key without the scope, is refused by the same authorize every desk core uses.
//
// ingestCore runs its checks (frozen and scope, the batch, the key's rate)
// before its first write. After that each story gets a value outcome, never a
// refusal, so nothing it writes is left half done by a failure. Outcomes and
// events carry ids, revs, hashes and field names, never story text, and
// /status answers ids, states, counts and ages only.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

/**
 * The env a machine core is handed; convex/submit.ts copies it from
 * process.env. MACHINE_KEYS is read for its key ids only (ingestCore).
 */
export type MachineEnv = DeskEnv & { GITHUB_DISPATCH_TOKEN_EXPIRES?: string | null; MACHINE_KEYS?: string | null };

export type Outcome = "created" | "updated" | "unchanged" | "kept-human-edits" | "already-decided" | "published" | "invalid" | "queue-full";
export const OUTCOMES: readonly Outcome[] = Object.freeze([
  "created", "updated", "unchanged", "kept-human-edits", "already-decided", "published", "invalid", "queue-full",
] as Outcome[]);
export type StoryOutcome = { id: string | null; outcome: Outcome; problems: Problem[] };

/** ingestCore's answer: the result, and one links intent per created or updated draft. publish-bridge schedules them. */
export type WithIntents = { result: Result; intents: Intent[] };

/** The statuses /status lists story by story, in the order they take the QUEUE_PER_STATUS_MAX places. */
export const STATUS_QUEUE: readonly string[] = Object.freeze(["approved", "publishing", "committed", "pending"]);

/** Each machine scope's rate limit, which is also its one machine action. */
export const SCOPE_LIMITS: Readonly<Record<Scope, MachineAction>> = Object.freeze({
  submit: "machine.submit",
  status: "machine.status",
  publish: "machine.publish",
});

const POST_FIELDS: readonly string[] = Object.freeze(["id", "date", "kind", "site", "title", "summary", "body", "links", "tags"]);
const TOKEN_EXPIRES_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The server's UTC date, the only today submit mode is judged against. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A story's id when it is safe to send back: a string with no id problem but id-date (build-feed.py printable_id). */
export function printableId(raw: unknown, problems: readonly Problem[]): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "string") return null;
  return problems.some((p) => p.field === "id" && p.code !== "id-date") ? null : id;
}

function same(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
}

type Judged = { raw: unknown; post: Post | null; hash: string; external: boolean; problems: Problem[] };

/**
 * An untouched pending machine draft takes the new post: rev and machineRev
 * go up, so an approve holding the old rev is stale. Link checks survive for
 * the urls still present, and an owner's override only while the urls are
 * the same set: draftsCore.ts revise() is the same rule for a desk edit, and
 * tests/convex-submit.test.mjs holds the two copies to the same answer. note
 * (such as "conflict") is left as a desk edit leaves it.
 */
async function update(db: Db, draft: any, story: Judged & { post: Post }, principal: string, now: number): Promise<void> {
  const post = story.post;
  const urls = new Set(post.links.map((l) => l.url));
  const oldUrls = new Set(Array.isArray(draft.post?.links) ? draft.post.links.map((l: any) => l && l.url) : []);
  const sameUrls = urls.size === oldUrls.size && [...urls].every((u) => oldUrls.has(u));
  const linkChecks = sameUrls || !Array.isArray(draft.linkChecks) ? draft.linkChecks : draft.linkChecks.filter((c: any) => c && urls.has(c.url));
  const fields = POST_FIELDS.filter((key) => !same((post as any)[key], draft.post ? draft.post[key] : undefined));
  const rev = draft.rev + 1;
  const machineRev = draft.machineRev + 1;
  await db.patch("drafts", draft._id, {
    post, contentHash: story.hash, external: story.external, linkChecks, linkOverride: sameUrls ? draft.linkOverride : null,
    rev, machineRev, updatedAt: now,
  });
  await recordEvent(db, draft, principal, "machine-update", { rev, machineRev, fields, contentHash: story.hash }, now);
}

/**
 * The pending drafts the machine keys hold between them, for
 * MACHINE_PENDING_MAX: each key id MACHINE_KEYS configures, and the caller's
 * own, read through by_submittedBy [key:<id>, pending] in a take bounded by
 * the room still left, then summed. Desk drafts are never read, so however
 * many people hold pending stories the drafter keeps its room (the review
 * decision of 2026-09-22, which replaced the by_status take).
 */
async function machinePending(db: Reader, machine: Machine, env: MachineEnv): Promise<number> {
  let held = 0;
  for (const keyId of new Set([...machineKeyIds(env.MACHINE_KEYS), machine.keyId])) {
    if (held >= MACHINE_PENDING_MAX) break;
    const principal = principalOf({ kind: "machine", keyId, scopes: [] });
    const rows = await db
      .query("drafts")
      .withIndex("by_submittedBy", (q: any) => q.eq("submittedBy", principal).eq("status", "pending"))
      .take(MACHINE_PENDING_MAX - held);
    held += rows.length;
  }
  return held;
}

/**
 * POST /submit. args.stories holds at most SUBMIT_BATCH_MAX raw posts, each
 * judged in submit mode against the server's UTC date and answered with one
 * outcome, in order. A later story with the same id sees what an earlier one
 * wrote.
 */
export async function ingestCore(db: Db, caller: Caller, args: { stories?: unknown }, now: number, env: MachineEnv): Promise<WithIntents> {
  const refused = guardWrite(caller, "machine.submit", env);
  if (refused) return { result: refused, intents: [] };
  const machine = caller as Machine;
  const stories = args.stories;
  if (!Array.isArray(stories)) return { result: fail("malformed", "The body needs stories, an array of posts."), intents: [] };
  if (stories.length > SUBMIT_BATCH_MAX) {
    return { result: fail("too-many", `At most ${SUBMIT_BATCH_MAX} stories per request.`, { max: SUBMIT_BATCH_MAX }), intents: [] };
  }
  const principal = principalOf(machine);
  const limited = await refuseIfLimited(db, principal, SCOPE_LIMITS.submit, now, "submissions from this key this hour");
  if (limited) return { result: limited, intents: [] };

  const today = utcDay(now);
  const judged: Judged[] = [];
  for (const raw of stories) {
    const verdict = validatePost(raw, { mode: "submit", today });
    const post = verdict.ok ? verdict.post : null;
    judged.push({ raw, post, hash: post ? await contentHash(post) : "", external: verdict.external, problems: verdict.problems });
  }
  const assignee = await eligibleDefaultAssignee(db, env);
  let room = Math.max(0, MACHINE_PENDING_MAX - (await machinePending(db, machine, env)));

  const outcomes: StoryOutcome[] = [];
  const touched: string[] = [];
  const answer = (id: string | null, outcome: Outcome, problems: Problem[] = []) => outcomes.push({ id, outcome, problems });
  for (const story of judged) {
    if (story.post === null) {
      answer(printableId(story.raw, story.problems), "invalid", story.problems);
      continue;
    }
    const post = story.post;
    if ((await db.query("publishedIds").withIndex("by_storyId", (q: any) => q.eq("storyId", post.id)).first()) !== null) {
      answer(post.id, "published");
      continue;
    }
    const draft = await db.query("drafts").withIndex("by_storyId", (q: any) => q.eq("storyId", post.id)).first();
    if (draft !== null) {
      // A desk draft is humanTouched from birth, so only a machine draft nobody edited is ever replaced.
      if (draft.status !== "pending") answer(post.id, "already-decided");
      else if (draft.humanTouched || draft.source !== "machine") answer(post.id, "kept-human-edits");
      else if (draft.contentHash === story.hash) answer(post.id, "unchanged");
      else {
        await update(db, draft, { ...story, post }, principal, now);
        if (!touched.includes(draft._id)) touched.push(draft._id);
        answer(post.id, "updated");
      }
      continue;
    }
    if (room <= 0) {
      answer(post.id, "queue-full");
      continue;
    }
    const draftId = await db.insert("drafts", newDraft({ post, hash: story.hash, external: story.external, source: "machine", submittedBy: principal, assignee, now }));
    await recordEvent(db, { _id: draftId, storyId: post.id }, principal, "submit", { rev: 1, machineRev: 1, contentHash: story.hash, assignee }, now);
    touched.push(draftId);
    room -= 1;
    answer(post.id, "created");
  }
  await recordRate(db, principal, SCOPE_LIMITS.submit, now);
  return { result: done({ outcomes }), intents: touched.map((draftId): Intent => ({ kind: "links", draftId })) };
}

/** The triggers of a run that can publish (section 4.1). */
export const REAL_TRIGGERS = Object.freeze(["approve", "now", "retry", "push", "reconcile"] as const);
/**
 * The trigger of a run a dry-run claim created (convex/lib/publishMachine.ts).
 * It publishes nothing and is never dispatched, so the pause after a failed
 * run, publish:retry, reconcile and lastRun all look past it (the review
 * decision of 2026-09-22).
 */
export const DRYRUN_TRIGGER = "dryrun";

/**
 * The newest run that is not a dry run's, or null: the newest of each real
 * trigger through by_trigger, and of those the one created last. Exact however
 * many dry runs came after it.
 */
export async function newestRealRun(db: Reader): Promise<any> {
  let newest: any = null;
  for (const trigger of REAL_TRIGGERS) {
    const run = await db.query("publishRuns").withIndex("by_trigger", (q: any) => q.eq("trigger", trigger)).order("desc").first();
    if (run !== null && (newest === null || run._creationTime > newest._creationTime)) newest = run;
  }
  return newest;
}

/**
 * The newest publish run as /status, publish:status and the watchdog see it:
 * the newest that is not a dry run's, or null when there is none. Ids, states
 * and counts only.
 */
export async function lastRunOf(db: Reader, now: number): Promise<Record<string, unknown> | null> {
  const run = await newestRealRun(db);
  if (run === null) return null;
  return {
    runId: run._id, state: run.state, trigger: run.trigger, attempts: run.attempts, followUp: run.followUp,
    createdAt: run.createdAt, updatedAt: run.updatedAt, ageMs: now - run.createdAt, runUrl: run.runUrl,
    commitSha: run.commitSha, error: run.error, stories: Array.isArray(run.storyIds) ? run.storyIds.length : 0,
  };
}

/** GITHUB_DISPATCH_TOKEN_EXPIRES as YYYY-MM-DD, or null when unset or not a date. */
export function tokenExpiresOf(env: MachineEnv): string | null {
  const value = typeof env.GITHUB_DISPATCH_TOKEN_EXPIRES === "string" ? env.GITHUB_DISPATCH_TOKEN_EXPIRES.trim() : "";
  return TOKEN_EXPIRES_RE.test(value) ? value : null;
}

const ageOf = (now: number, at: unknown): number | null => (typeof at === "number" ? now - at : null);

/**
 * POST /status. Each status is read through by_status, oldest update first,
 * at most QUEUE_PER_STATUS_MAX rows, live and spiked within the windows
 * desk:queue shows, so every count stops at 200. The queue lists approved,
 * publishing, committed and then pending stories, at most QUEUE_PER_STATUS_MAX
 * in all, by id, state and age: never a title, summary, body, link or tag.
 */
export async function statusCore(db: Reader, caller: Caller, _args: unknown, now: number, env: MachineEnv): Promise<Result> {
  // A read: DESK_FROZEN does not refuse it.
  const refused = authorize(caller, "machine.status", env);
  if (refused) return refused;
  const counts: Record<string, number> = {};
  const rows: Record<string, any[]> = {};
  for (const status of STATUSES) {
    const since = status === "live" ? now - LIVE_SHOWN_MS : status === "spiked" ? now - SPIKED_SHOWN_MS : null;
    rows[status] = await db
      .query("drafts")
      .withIndex("by_status", (q: any) => (since === null ? q.eq("status", status) : q.eq("status", status).gte("updatedAt", since)))
      .take(QUEUE_PER_STATUS_MAX);
    counts[status] = rows[status].length;
  }
  const queue: Record<string, unknown>[] = [];
  for (const status of STATUS_QUEUE) {
    for (const d of rows[status]) {
      if (queue.length >= QUEUE_PER_STATUS_MAX) break;
      queue.push({
        storyId: d.storyId, status: d.status, source: d.source, assigned: d.assignee !== null, ageMs: now - d.submittedAt,
        approvedAgeMs: ageOf(now, d.approvedAt), claimedAgeMs: ageOf(now, d.claimedAt), committedAgeMs: ageOf(now, d.committedAt),
      });
    }
  }
  return done({ counts, queue, lastRun: await lastRunOf(db, now), tokenExpires: tokenExpiresOf(env) });
}

/**
 * The per-key rate of a route whose function is a query and cannot record
 * one (convex/lib/routes.ts meter). args.path names the route; its scope names
 * the limit. Not refused by DESK_FROZEN: the routes it meters are reads.
 */
export async function meterCore(db: Db, caller: Caller, args: { path?: unknown }, now: number, env: MachineEnv): Promise<Result> {
  const scope = typeof args.path === "string" ? scopeForPath(args.path) : null;
  if (scope === null) return fail("not-found", "No machine route here.");
  const limit = SCOPE_LIMITS[scope];
  const refused = authorize(caller, limit, env);
  if (refused) return refused;
  const principal = principalOf(caller as Machine);
  const limited = await refuseIfLimited(db, principal, limit, now, "requests from this key this hour");
  if (limited) return limited;
  await recordRate(db, principal, limit, now);
  return done();
}
