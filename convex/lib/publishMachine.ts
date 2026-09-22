import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { guardWrite, principalOf } from "./access.ts";
import type { Caller, Machine } from "./access.ts";
import { recordEvent } from "./draftsCore.ts";
import { CLAIM_MAX, CLAIM_STALE_MS, QUEUE_PER_STATUS_MAX } from "./limits.ts";
import {
  GH_RUN_ID_RE, RUN_URL_RE, SHA_RE, UNAPPROVED, activeRun, allCommitted, approvedUnclaimed, finishRun, invalid, releaseDrafts,
  retryOrFail, runById, runRow,
} from "./publishCore.ts";
import type { PublishIntent, WithPublishIntents } from "./publishCore.ts";
import { recordRate, refuseIfLimited } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure } from "./result.ts";
import { DRYRUN_TRIGGER } from "./submitCore.ts";
import type { MachineEnv } from "./submitCore.ts";

// The cores behind POST /publish/claim, conflict, pushed, built and release
// (docs/plans/2026-09-15-antenne-desk.md section 5), which only the publish
// workflow calls, through scripts/publish-approved.py and the gh key. The
// caller is the Machine convex/lib/routes.ts built from a verified key; one
// without the publish scope is refused by authorize like any other.
//
// Each core runs every check before its first write, in this order: frozen and
// the scope; the arguments; the run and its state; the key's machine.publish
// rate; for pushed and built, the run's commit. Draft changes bump rev, so a
// desk card loaded before one is stale, and write a draftEvents row with ids
// and hashes, never story text. Only claim answers story text, and only to the
// publish key.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;
type Args = Record<string, unknown>;
type Problem = { field: string; code: string };

const REASON_RE = /^[a-z][a-z0-9-]{0,39}$/;
const STORY_ID_RE = /^[a-z0-9-]{1,80}$/;
/** The release reason of a dry run: the run is done, and nothing is retried. */
export const DRY_RUN = "dry-run";
/** The note /publish/conflict leaves on a draft it sends back; the desk shows it as "Sent back by publishing". */
export const CONFLICT_NOTE = "conflict";
const RATE_WHAT = "publish calls from this key this hour";

const refuse = (result: Failure): WithPublishIntents => ({ result, intents: [] });
const format = (field: string): Problem => ({ field, code: "format" });
const optional = (value: unknown, re: RegExp): boolean => value === undefined || value === null || (typeof value === "string" && re.test(value));

/** The checks every route but claim shares, before any write. */
async function openRun(db: Reader, caller: Caller, runId: unknown, problems: Problem[], states: readonly string[], now: number, env: MachineEnv): Promise<{ failure: Failure } | { principal: string; run: any }> {
  const refused = guardWrite(caller, "machine.publish", env);
  if (refused) return { failure: refused };
  if (typeof runId !== "string") problems.unshift(format("runId"));
  if (problems.length) return { failure: invalid(problems) };
  const run = await runById(db, runId);
  if (run === null) return { failure: fail("not-found", "No such publish run.") };
  if (!states.includes(run.state)) return { failure: fail("status", `This run is ${run.state}.`, { state: run.state }) };
  const principal = principalOf(caller as Machine);
  const limited = await refuseIfLimited(db, principal, "machine.publish", now, RATE_WHAT);
  if (limited) return { failure: limited };
  return { principal, run };
}

/**
 * What one claim takes, at most CLAIM_MAX: publishing drafts whose claim is
 * older than CLAIM_STALE_MS (a run that died holding them), then approved
 * drafts no run holds whose publishAfter has come, oldest approval first.
 */
async function claimable(db: Reader, now: number): Promise<any[]> {
  const stale = (await db.query("drafts").withIndex("by_status", (q: any) => q.eq("status", "publishing")).take(QUEUE_PER_STATUS_MAX))
    .filter((d: any) => typeof d.claimedAt !== "number" || now - d.claimedAt > CLAIM_STALE_MS);
  const due = (await approvedUnclaimed(db)).filter((d: any) => typeof d.publishAfter === "number" && d.publishAfter <= now);
  return [...stale, ...due].slice(0, CLAIM_MAX);
}

/**
 * POST /publish/claim { runId (string or null), ghRunId, runUrl, dryRun
 * (boolean, default false) }. A named run must be queued or dispatched. With
 * runId null (a push to main, or a run from the Actions tab) a run with
 * trigger push is created, but only when there is something to claim and no
 * run is active; during an active run the claim is a trigger, so it sets
 * followUp and takes nothing. A named run that finds nothing to claim is done.
 *
 * A dry run (dryRun true, the review decision of 2026-09-22) is not a
 * trigger: with runId null its run gets trigger dryrun, which the pause after
 * a failed run, Retry, reconcile and lastRun look past and nothing ever
 * dispatches, and during an active run it sets no followUp.
 */
export async function claimCore(db: Db, caller: Caller, args: Args, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const refused = guardWrite(caller, "machine.publish", env);
  if (refused) return refuse(refused);
  const problems: Problem[] = [];
  if (args.runId !== null && (typeof args.runId !== "string" || args.runId === "")) problems.push(format("runId"));
  if (!optional(args.ghRunId, GH_RUN_ID_RE)) problems.push(format("ghRunId"));
  if (!optional(args.runUrl, RUN_URL_RE)) problems.push(format("runUrl"));
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") problems.push(format("dryRun"));
  if (problems.length) return refuse(invalid(problems));
  const dry = args.dryRun === true;
  const ghRunId = (args.ghRunId ?? null) as string | null;
  const runUrl = (args.runUrl ?? null) as string | null;
  let run: any = null;
  if (args.runId !== null) {
    run = await runById(db, args.runId);
    if (run === null) return refuse(fail("not-found", "No such publish run."));
    if (run.state !== "queued" && run.state !== "dispatched") return refuse(fail("status", `This run is ${run.state}.`, { state: run.state }));
  }
  const principal = principalOf(caller as Machine);
  const limited = await refuseIfLimited(db, principal, "machine.publish", now, RATE_WHAT);
  if (limited) return refuse(limited);

  const taken = await claimable(db, now);
  const storyIds = taken.map((d: any) => d.storyId);
  let intents: PublishIntent[] = [];
  let runId: string | null;
  if (run === null) {
    const active = await activeRun(db);
    if (active !== null && !dry) await db.patch("publishRuns", active._id, { followUp: true });
    const trigger = dry ? DRYRUN_TRIGGER : "push";
    runId = active === null && taken.length ? await db.insert("publishRuns", runRow(trigger, now, now, { state: "claimed", claimedAt: now, ghRunId, runUrl, storyIds })) : null;
  } else {
    runId = run._id;
    if (taken.length === 0) intents = await finishRun(db, run, "done", { claimedAt: now, ghRunId, runUrl, storyIds, error: null }, now);
    else await db.patch("publishRuns", run._id, { state: "claimed", claimedAt: now, ghRunId, runUrl, storyIds, error: null, updatedAt: now });
  }
  const stories: Record<string, unknown>[] = [];
  if (runId !== null) {
    for (const d of taken) {
      const rev = d.rev + 1;
      // A claim means the story was approved again after any conflict, so the send-back note goes; any other note stays.
      const cleared = d.note === CONFLICT_NOTE ? { note: null } : {};
      await db.patch("drafts", d._id, { status: "publishing", claimRun: runId, claimedAt: now, rev, updatedAt: now, ...cleared });
      await recordEvent(db, d, principal, "claim", { rev, runId, from: d.status, to: "publishing", approvedHash: d.approvedHash }, now);
      stories.push({ storyId: d.storyId, post: d.post, approvedHash: d.approvedHash });
    }
  }
  await recordRate(db, principal, "machine.publish", now);
  return { result: done({ runId, stories }), intents };
}

/**
 * POST /publish/conflict { runId, storyIds }: stories the merge could not add
 * as approved (a different story under the same id, a hash that no longer
 * matches, a story the archive refuses) go back to pending with note
 * "conflict" and their approval cleared. Only drafts this claimed run holds.
 */
export async function conflictCore(db: Db, caller: Caller, args: Args, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const problems: Problem[] = [];
  const ids = args.storyIds;
  if (!Array.isArray(ids)) problems.push(format("storyIds"));
  else if (ids.length > CLAIM_MAX) problems.push({ field: "storyIds", code: "too-many" });
  else ids.forEach((id, i) => { if (typeof id !== "string" || !STORY_ID_RE.test(id)) problems.push(format(`storyIds[${i}]`)); });
  const opened = await openRun(db, caller, args.runId, problems, ["claimed"], now, env);
  if ("failure" in opened) return refuse(opened.failure);
  const { principal, run } = opened;
  const left = new Set<string>(Array.isArray(run.storyIds) ? run.storyIds : []);
  for (const storyId of new Set(ids as string[])) {
    const d = await db.query("drafts").withIndex("by_storyId", (q: any) => q.eq("storyId", storyId)).first();
    if (d === null || d.claimRun !== run._id || d.status !== "publishing") continue;
    const rev = d.rev + 1;
    await db.patch("drafts", d._id, { ...UNAPPROVED, note: CONFLICT_NOTE, claimRun: null, claimedAt: null, rev, updatedAt: now });
    await recordEvent(db, d, principal, "conflict", { rev, runId: run._id, from: "publishing", to: "pending" }, now);
    left.delete(storyId);
  }
  await db.patch("publishRuns", run._id, { storyIds: [...left], updatedAt: now });
  await recordRate(db, principal, "machine.publish", now);
  return { result: done(), intents: [] };
}

/** POST /publish/pushed { runId, sha, noChange }: the commit on main (HEAD when nothing was added); verifyCommit is scheduled. */
export async function pushedCore(db: Db, caller: Caller, args: Args, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const problems: Problem[] = [];
  if (typeof args.sha !== "string" || !SHA_RE.test(args.sha)) problems.push(format("sha"));
  if (typeof args.noChange !== "boolean") problems.push(format("noChange"));
  const opened = await openRun(db, caller, args.runId, problems, ["claimed", "pushed"], now, env);
  if ("failure" in opened) return refuse(opened.failure);
  const { principal, run } = opened;
  const sha = args.sha as string;
  // The same report twice (a retried request) is answered again; another sha for a pushed run is not.
  if (run.state === "pushed" && run.commitSha !== sha) return refuse(fail("status", "This run already reported another commit.", { state: run.state }));
  if (run.state === "claimed") await db.patch("publishRuns", run._id, { state: "pushed", commitSha: sha, updatedAt: now });
  await recordRate(db, principal, "machine.publish", now);
  return { result: done(), intents: [{ kind: "verify", runId: run._id, sha }] };
}

/**
 * POST /publish/built { runId, sha, pagesStatus }: Pages built the commit or a
 * descendant. sha is the commit the run reported as pushed, and no other. done
 * once every claimed story is committed.
 */
export async function builtCore(db: Db, caller: Caller, args: Args, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const problems: Problem[] = [];
  if (typeof args.sha !== "string" || !SHA_RE.test(args.sha)) problems.push(format("sha"));
  if (args.pagesStatus !== "built") problems.push(format("pagesStatus"));
  const opened = await openRun(db, caller, args.runId, problems, ["pushed", "built"], now, env);
  if ("failure" in opened) return refuse(opened.failure);
  const { principal, run } = opened;
  if (run.commitSha !== args.sha) return refuse(fail("status", "This run pushed another commit.", { state: run.state }));
  let intents: PublishIntent[];
  if (await allCommitted(db, run._id)) intents = await finishRun(db, run, "done", { error: null }, now);
  else {
    if (run.state === "pushed") await db.patch("publishRuns", run._id, { state: "built", updatedAt: now });
    intents = [{ kind: "verify", runId: run._id, sha: run.commitSha }];
  }
  await recordRate(db, principal, "machine.publish", now);
  return { result: done(), intents };
}

/**
 * POST /publish/release { runId, reason }: before a push only. The run's
 * publishing drafts go back to approved; a committed or live one is never
 * touched. A dry run's release finishes the run as done; any other reason
 * spends an attempt, and reconcile dispatches the requeued run again, except
 * a run with trigger dryrun, which retryOrFail fails rather than requeue.
 */
export async function releaseCore(db: Db, caller: Caller, args: Args, now: number, env: MachineEnv): Promise<WithPublishIntents> {
  const problems: Problem[] = [];
  if (typeof args.reason !== "string" || !REASON_RE.test(args.reason)) problems.push(format("reason"));
  const opened = await openRun(db, caller, args.runId, problems, ["queued", "dispatched", "claimed"], now, env);
  if ("failure" in opened) return refuse(opened.failure);
  const { principal, run } = opened;
  const reason = args.reason as string;
  const released = await releaseDrafts(db, run._id, principal, reason, now);
  const intents = reason === DRY_RUN
    ? await finishRun(db, run, "done", { storyIds: [], error: null }, now)
    : (await retryOrFail(db, run, `released ${reason}`, now)).intents;
  await recordRate(db, principal, "machine.publish", now);
  return { result: done({ released }), intents };
}
