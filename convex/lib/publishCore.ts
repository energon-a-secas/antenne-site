import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { authorize, guardWrite, isFrozen, isMember } from "./access.ts";
import type { Caller, Human } from "./access.ts";
import { recordEvent } from "./draftsCore.ts";
import {
  CLAIM_STALE_MS, DISPATCH_STALE_MS, LIVE_SHOWN_MS, QUEUE_PER_STATUS_MAX, RATE_SWEEP_AGE_MS, REQUEST_SWEEP_AGE_MS,
  RUN_MAX_ATTEMPTS, RUN_SWEEP_AGE_MS, SPIKED_SWEEP_AGE_MS, TOKEN_WARNING_MS,
} from "./limits.ts";
import { recordRate, refuseIfLimited } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure, Result } from "./result.ts";
import { DRYRUN_TRIGGER, lastRunOf, newestRealRun, tokenExpiresOf } from "./submitCore.ts";
import type { MachineEnv, REAL_TRIGGERS } from "./submitCore.ts";

// The publish run state machine of docs/plans/2026-09-15-antenne-desk.md
// sections 4.1 and 6.1, and the three public publish functions of 4.3.
//
//   queued -> dispatched -> claimed -> pushed -> built -> done, or failed
//
// At most one run is active (any state before done and failed). A trigger
// during an active run sets followUp on it, and finishing a run with followUp
// queues the next. Every function here takes the db and the clock; none reads
// process.env, none calls fetch (convex/lib/publishFetch.ts does, with fetch
// passed in), and none schedules: each returns intents that the wrappers in
// convex/publish.ts and convex/drafts.ts turn into ctx.scheduler calls after
// the writes. convex/lib/publishMachine.ts holds the /publish/* route cores and
// convex/lib/publishRecord.ts what the actions record.
//
// Recovery is bounded. A run is tried at most RUN_MAX_ATTEMPTS times (a failed
// dispatch, a stale dispatch or claim, a release, a verification that never
// matches), then failed. Nothing queues a run by itself after a failed one:
// an owner or editor presses Retry (publish:retry), so a failure that repeats
// on every attempt cannot loop forever.
//
// A dry run's claim creates a run with trigger dryrun (DRYRUN_TRIGGER). Such a
// run is never queued again, so never dispatched as a real publish, and "the
// last run" everywhere here means the newest run that is not a dry run's
// (newestRealRun), so a dry run neither ends the pause after a failed run nor
// hides that failure (the review decision of 2026-09-22).

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

/** The trigger of a run that can publish; a dry run's is DRYRUN_TRIGGER, and queueRun never creates one. */
export type Trigger = (typeof REAL_TRIGGERS)[number];
export const RUN_STATES: readonly string[] = Object.freeze(["queued", "dispatched", "claimed", "pushed", "built", "done", "failed"]);
export const ACTIVE_STATES: readonly string[] = Object.freeze(["queued", "dispatched", "claimed", "pushed", "built"]);
/** What a wrapper schedules: publish:dispatch at runAt, or publish:verifyCommit now. */
export type PublishIntent = { kind: "dispatch"; runId: string; runAt: number } | { kind: "verify"; runId: string; sha: string };
export type WithPublishIntents = { result: Result; intents: PublishIntent[] };

/** A git commit as the publish workflow reports it: 40 lowercase hex. */
export const SHA_RE = /^[0-9a-f]{40}$/;
/** A workflow run's page, as /status and the desk link it. */
export const RUN_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]{1,20}(?:\/attempts\/[0-9]{1,6})?$/;
export const GH_RUN_ID_RE = /^[0-9]{1,20}$/;
/** convex/crons.ts runs reconcile this often; a pushed or built run idle this long spends an attempt. */
export const RECONCILE_EVERY_MS = 10 * 60 * 1000;
/** Rows of each kind one sweep deletes before it schedules itself again. */
export const SWEEP_BATCH = 100;
/** The draftEvents actor for changes the backend makes on its own. */
export const SYSTEM_ACTOR = "antenne:publish";

/** The fields that clear an approval, as a desk edit clears them. */
export const UNAPPROVED = Object.freeze({ status: "pending", approvedHash: null, approvedBy: null, approvedAt: null, publishAfter: null });
const COUNTED: readonly string[] = Object.freeze(["approved", "publishing", "committed", "live"]);
const WRITES = "desk changes this hour";

export function invalid(problems: { field: string; code: string }[]): Failure {
  return fail("invalid", "The request does not fit this function.", { problems });
}

/** The run a caller named, or null. Ids arrive as text (a route body, a scheduled argument), so they are normalized first. */
export async function runById(db: Reader, raw: unknown): Promise<any> {
  if (typeof raw !== "string" || raw === "" || raw.length > 64) return null;
  const id = db.normalizeId("publishRuns", raw);
  return id === null ? null : await db.get("publishRuns", id);
}

/** The one active run, or null. */
export async function activeRun(db: Reader): Promise<any> {
  for (const state of ACTIVE_STATES) {
    const run = await db.query("publishRuns").withIndex("by_state", (q: any) => q.eq("state", state)).first();
    if (run !== null) return run;
  }
  return null;
}

/** Every field of a new publishRuns row. */
export function runRow(trigger: Trigger | typeof DRYRUN_TRIGGER, runAt: number, now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "queued", trigger, attempts: 0, followUp: false, runAt, dispatchedAt: null, claimedAt: null, ghRunId: null,
    runUrl: null, commitSha: null, storyIds: [], error: null, createdAt: now, updatedAt: now, ...extra,
  };
}

/** Approved drafts no run holds, oldest approval first (by_status orders by updatedAt), at most QUEUE_PER_STATUS_MAX read. */
export async function approvedUnclaimed(db: Reader): Promise<any[]> {
  const rows = await db.query("drafts").withIndex("by_status", (q: any) => q.eq("status", "approved")).take(QUEUE_PER_STATUS_MAX);
  return rows.filter((d: any) => d.claimRun === null);
}

/** When the next run should dispatch: the earliest approval still waiting, and never before now. */
async function nextRunAt(db: Reader, now: number): Promise<number> {
  const due = (await approvedUnclaimed(db)).map((d: any) => d.publishAfter).filter((n: unknown): n is number => typeof n === "number");
  return due.length ? Math.max(now, Math.min(...due)) : now;
}

/**
 * A trigger. With no active run, a queued run is created and dispatched at
 * runAt. During an active run, that run gets followUp; a queued one also moves
 * to the earlier runAt, so Publish now does not wait for a later approval.
 */
export async function queueRun(db: Db, trigger: Trigger, runAt: number, now: number): Promise<{ runId: string; intent: PublishIntent | null }> {
  const active = await activeRun(db);
  if (active === null) {
    const runId = await db.insert("publishRuns", runRow(trigger, runAt, now));
    return { runId, intent: { kind: "dispatch", runId, runAt } };
  }
  const earlier = active.state === "queued" && runAt < active.runAt;
  // followUp alone leaves updatedAt: reconcile reads it to tell an idle run from a busy one.
  await db.patch("publishRuns", active._id, earlier ? { followUp: true, runAt, updatedAt: now } : { followUp: true });
  return { runId: active._id, intent: earlier ? { kind: "dispatch", runId: active._id, runAt } : null };
}

/** The drafts a run holds: publishing ones, and the committed and live ones it published. */
export async function claimedDrafts(db: Reader, runId: string): Promise<any[]> {
  return await db.query("drafts").withIndex("by_claimRun", (q: any) => q.eq("claimRun", runId)).take(QUEUE_PER_STATUS_MAX);
}

export async function allCommitted(db: Reader, runId: string): Promise<boolean> {
  return (await claimedDrafts(db, runId)).every((d: any) => d.status === "committed" || d.status === "live");
}

/** Ends a run as done or failed. A run owed a follow-up queues the next, due at the earliest approval still waiting. */
export async function finishRun(db: Db, run: any, state: "done" | "failed", patch: Record<string, unknown>, now: number): Promise<PublishIntent[]> {
  await db.patch("publishRuns", run._id, { ...patch, state, followUp: false, updatedAt: now });
  if (!run.followUp) return [];
  const next = await queueRun(db, "reconcile", await nextRunAt(db, now), now);
  return next.intent ? [next.intent] : [];
}

/** Returns a run's publishing drafts to approved and unclaimed. A committed or live draft is never touched. */
export async function releaseDrafts(db: Db, runId: string, actor: string, reason: string, now: number): Promise<number> {
  let released = 0;
  for (const d of await claimedDrafts(db, runId)) {
    if (d.status !== "publishing") continue;
    const rev = d.rev + 1;
    await db.patch("drafts", d._id, { status: "approved", claimRun: null, claimedAt: null, rev, updatedAt: now });
    await recordEvent(db, d, actor, "release", { rev, runId, reason, from: "publishing", to: "approved" }, now);
    released += 1;
  }
  return released;
}

/**
 * One attempt spent: back to queued for reconcile to dispatch again, or failed
 * at RUN_MAX_ATTEMPTS. A dry run's run is failed at once: queued, it would be
 * dispatched with no dry_run input, which is a real publish.
 */
export async function retryOrFail(db: Db, run: any, error: string, now: number): Promise<{ requeued: boolean; intents: PublishIntent[] }> {
  const attempts = run.attempts + 1;
  if (attempts >= RUN_MAX_ATTEMPTS || run.trigger === DRYRUN_TRIGGER) {
    return { requeued: false, intents: await finishRun(db, run, "failed", { attempts, error }, now) };
  }
  await db.patch("publishRuns", run._id, { state: "queued", attempts, error, runAt: now, claimedAt: null, updatedAt: now });
  return { requeued: true, intents: [] };
}

/** True when GITHUB_DISPATCH_TOKEN_EXPIRES (the start of that UTC day) is TOKEN_WARNING_MS away or less, or past. */
export function tokenWarningOf(expires: string | null, now: number): boolean {
  if (expires === null) return false;
  const at = Date.parse(`${expires}T00:00:00Z`);
  return Number.isFinite(at) && at - now <= TOKEN_WARNING_MS;
}

// ── publish:status, publish:now, publish:retry ────────────────────────────────

/**
 * publish:status. counts are per-status takes of QUEUE_PER_STATUS_MAX through
 * by_status, live within desk:queue's window, as /status counts them. A caller
 * with no role gets empty data; a submitter is refused, as publish.read says.
 */
export async function publishStatusCore(db: Reader, caller: Caller, _args: unknown, now: number, env: MachineEnv): Promise<Result> {
  if (!isMember(caller)) return done({ lastRun: null, counts: null, tokenExpires: null, tokenWarning: false });
  const refused = authorize(caller, "publish.read", env);
  if (refused) return refused;
  const counts: Record<string, number> = {};
  for (const status of COUNTED) {
    const since = status === "live" ? now - LIVE_SHOWN_MS : null;
    const rows = await db
      .query("drafts")
      .withIndex("by_status", (q: any) => (since === null ? q.eq("status", status) : q.eq("status", status).gte("updatedAt", since)))
      .take(QUEUE_PER_STATUS_MAX);
    counts[status] = rows.length;
  }
  const tokenExpires = tokenExpiresOf(env);
  return done({ lastRun: await lastRunOf(db, now), counts, tokenExpires, tokenWarning: tokenWarningOf(tokenExpires, now) });
}

/** publish:now: a run dispatched now, or followUp on the active one. Owner and editor. */
export async function publishNowCore(db: Db, caller: Caller, _args: unknown, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const refused = guardWrite(caller, "publish.trigger", env);
  if (refused) return { result: refused, intents: [] };
  const human = caller as Human;
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return { result: limited, intents: [] };
  const queued = await queueRun(db, "now", now, now);
  await recordRate(db, human.subject, "draft.write", now);
  return { result: done({ runId: queued.runId }), intents: queued.intent ? [queued.intent] : [] };
}

/** publish:retry: after a failed run, a new run dispatched now. Refused with status unless the last run that is not a dry run's failed. */
export async function publishRetryCore(db: Db, caller: Caller, _args: unknown, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const refused = guardWrite(caller, "publish.trigger", env);
  if (refused) return { result: refused, intents: [] };
  const human = caller as Human;
  const last = await newestRealRun(db);
  if (last === null || last.state !== "failed") {
    return { result: fail("status", "Only a failed run can be retried.", { state: last === null ? null : last.state }), intents: [] };
  }
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return { result: limited, intents: [] };
  const queued = await queueRun(db, "retry", now, now);
  await recordRate(db, human.subject, "draft.write", now);
  return { result: done({ runId: queued.runId }), intents: queued.intent ? [queued.intent] : [] };
}

// ── publish:reconcile ─────────────────────────────────────────────────────────

async function reconcileRun(db: Db, run: any, now: number, intents: PublishIntent[]): Promise<string> {
  if (run.attempts >= RUN_MAX_ATTEMPTS) {
    if (run.state === "claimed") await releaseDrafts(db, run._id, SYSTEM_ACTOR, "attempts", now);
    intents.push(...(await finishRun(db, run, "failed", { error: run.error ?? "attempts" }, now)));
    return "failed";
  }
  if (run.state === "queued") {
    if (run.runAt > now) return "waiting";
    intents.push({ kind: "dispatch", runId: run._id, runAt: now });
    return "dispatch";
  }
  if (run.state === "dispatched" || run.state === "claimed") {
    const dispatched = run.state === "dispatched";
    const since = dispatched ? run.dispatchedAt : run.claimedAt;
    if (typeof since === "number" && now - since <= (dispatched ? DISPATCH_STALE_MS : CLAIM_STALE_MS)) return "waiting";
    if (!dispatched) await releaseDrafts(db, run._id, SYSTEM_ACTOR, "claim-stale", now);
    const next = await retryOrFail(db, run, dispatched ? "dispatch stale" : "claim stale", now);
    intents.push(...next.intents);
    if (!next.requeued) return "failed";
    intents.push({ kind: "dispatch", runId: run._id, runAt: now });
    return dispatched ? "redispatch" : "requeued";
  }
  // pushed or built: the commit is on main, so nothing is released; verification is asked for again.
  if (run.state === "built" && (await allCommitted(db, run._id))) {
    intents.push(...(await finishRun(db, run, "done", { error: null }, now)));
    return "done";
  }
  if (now - run.updatedAt >= RECONCILE_EVERY_MS) {
    const attempts = run.attempts + 1;
    if (attempts >= RUN_MAX_ATTEMPTS) {
      // Every story verified but no built report (Pages errored or timed out, or the job died after its push): built stale.
      const error = run.state === "pushed" && (await allCommitted(db, run._id)) ? "built stale" : "verify stale";
      intents.push(...(await finishRun(db, run, "failed", { attempts, error }, now)));
      return "failed";
    }
    await db.patch("publishRuns", run._id, { attempts, updatedAt: now });
  }
  if (typeof run.commitSha === "string") intents.push({ kind: "verify", runId: run._id, sha: run.commitSha });
  return "verify";
}

/**
 * publish:reconcile, every 10 minutes: dispatch queued runs past runAt;
 * re-dispatch runs dispatched longer than DISPATCH_STALE_MS; release runs
 * claimed longer than CLAIM_STALE_MS without a push, then requeue; ask again
 * for verifyCommit on pushed and built runs; fail runs at RUN_MAX_ATTEMPTS;
 * queue the follow-up a finished run is owed; and with no active run, queue
 * one when approved drafts are due, unless the last run that is not a dry
 * run's failed. Frozen, it does nothing.
 */
export async function reconcileCore(db: Db, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  if (isFrozen(env)) return { result: fail("frozen", "The desk is frozen: reading works, changes are paused."), intents: [] };
  const intents: PublishIntent[] = [];
  const acted: string[] = [];
  for (const state of ACTIVE_STATES) {
    // At most one run is active; the take bounds the read if that were ever broken.
    for (const run of await db.query("publishRuns").withIndex("by_state", (q: any) => q.eq("state", state)).take(10)) {
      acted.push(`${run.state} ${await reconcileRun(db, run, now, intents)}`);
    }
  }
  if ((await activeRun(db)) === null) {
    const last = await db.query("publishRuns").order("desc").first();
    if (last !== null && last.followUp && (last.state === "done" || last.state === "failed")) {
      await db.patch("publishRuns", last._id, { followUp: false });
      const next = await queueRun(db, "reconcile", await nextRunAt(db, now), now);
      if (next.intent) intents.push(next.intent);
      acted.push("follow-up");
    } else {
      // The pause: after a failed run nothing is queued by itself, and a dry run since then does not end it.
      const real = last === null || last.trigger !== DRYRUN_TRIGGER ? last : await newestRealRun(db);
      const due = (await approvedUnclaimed(db)).some((d: any) => typeof d.publishAfter === "number" && d.publishAfter <= now);
      if (real?.state !== "failed" && due) {
        const next = await queueRun(db, "reconcile", now, now);
        if (next.intent) intents.push(next.intent);
        acted.push("queued");
      }
    }
  }
  return { result: done({ acted }), intents };
}

// ── publish:sweep ─────────────────────────────────────────────────────────────

/**
 * publish:sweep, daily: rateEvents older than RATE_SWEEP_AGE_MS, access
 * requests older than REQUEST_SWEEP_AGE_MS, spiked drafts not touched for
 * SPIKED_SWEEP_AGE_MS, and done or failed runs not touched for
 * RUN_SWEEP_AGE_MS. draftEvents are kept. At most SWEEP_BATCH of each kind per
 * call; more says to schedule another. Frozen, it deletes nothing.
 */
export async function sweepCore(db: Db, now: number, env: MachineEnv): Promise<{ result: Result; more: boolean }> {
  if (isFrozen(env)) return { result: fail("frozen", "The desk is frozen: reading works, changes are paused."), more: false };
  const deleted: Record<string, number> = { rateEvents: 0, accessRequests: 0, drafts: 0, publishRuns: 0 };
  let more = false;
  const purge = async (table: string, rows: any[]) => {
    for (const row of rows) await db.delete(table, row._id);
    deleted[table] += rows.length;
    if (rows.length >= SWEEP_BATCH) more = true;
  };
  await purge("rateEvents", await db.query("rateEvents").withIndex("by_at", (q: any) => q.lt("at", now - RATE_SWEEP_AGE_MS)).take(SWEEP_BATCH));
  await purge("accessRequests", await db.query("accessRequests").withIndex("by_requestedAt", (q: any) => q.lt("requestedAt", now - REQUEST_SWEEP_AGE_MS)).take(SWEEP_BATCH));
  await purge("drafts", await db.query("drafts").withIndex("by_status", (q: any) => q.eq("status", "spiked").lt("updatedAt", now - SPIKED_SWEEP_AGE_MS)).take(SWEEP_BATCH));
  for (const state of ["done", "failed"]) {
    await purge("publishRuns", await db.query("publishRuns").withIndex("by_state", (q: any) => q.eq("state", state).lt("updatedAt", now - RUN_SWEEP_AGE_MS)).take(SWEEP_BATCH));
  }
  return { result: done({ deleted, more }), more };
}

