import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { machineCaller, resolveCaller } from "./lib/access.ts";
import type { Caller } from "./lib/access.ts";
import { fail } from "./lib/result.ts";
import type { Result } from "./lib/result.ts";
import { parseJsonObject } from "./lib/routes.ts";
import { SHA_RE, publishNowCore, publishRetryCore, publishStatusCore, reconcileCore, sweepCore } from "./lib/publishCore.ts";
import type { PublishIntent, WithPublishIntents } from "./lib/publishCore.ts";
import { builtCore, claimCore, conflictCore, pushedCore, releaseCore } from "./lib/publishMachine.ts";
import { LIVE_URL, dispatchRequest, rawArchiveUrl, readArchive } from "./lib/publishFetch.ts";
import { beginDispatchCore, dispatchResultCore, liveWantedCore, recordCommitCore, recordLiveCore } from "./lib/publishRecord.ts";
import type { MachineEnv } from "./lib/submitCore.ts";

// Publishing (docs/plans/2026-09-15-antenne-desk.md sections 4.3, 5 and 6.1):
// thin wrappers over convex/lib/publish*.ts. The rules live there, where
// tests/convex-publish.test.mjs runs them over the fake database with a fake
// fetch; a wrapper reads identity and process.env, calls a core, and turns the
// intents the core returns into ctx.scheduler calls after the core's writes.
//
// Public: publish:status (query), publish:now and publish:retry (mutations).
// Internal: the actions dispatch, verifyCommit and checkLive; reconcile and
// sweep for convex/crons.ts; the five /publish/* route mutations
// convex/http.ts calls with a verified machine key; and the mutations and the
// query the actions record through.
//
// GITHUB_DISPATCH_TOKEN is read in dispatch and handed straight to the request
// in convex/lib/publishFetch.ts. It is never logged, thrown or stored: a
// failed dispatch is stored as "dispatch <status>" and nothing else.

function deskEnv(): MachineEnv {
  return {
    DESK_OWNERS: process.env.DESK_OWNERS,
    DESK_DENY: process.env.DESK_DENY,
    DESK_FROZEN: process.env.DESK_FROZEN,
    GITHUB_DISPATCH_TOKEN_EXPIRES: process.env.GITHUB_DISPATCH_TOKEN_EXPIRES,
  };
}

/** Schedules what a core asked for: a run's dispatch at its runAt, a commit's verification now. */
async function follow(ctx: MutationCtx, intents: PublishIntent[]): Promise<void> {
  for (const intent of intents) {
    if (intent.kind === "dispatch") await ctx.scheduler.runAt(intent.runAt, internal.publish.dispatch, { runId: intent.runId });
    else await ctx.scheduler.runAfter(0, internal.publish.verifyCommit, { runId: intent.runId, sha: intent.sha });
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

export const status = query({
  args: {},
  handler: async (ctx): Promise<Result> => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await publishStatusCore(ctx.db, caller, {}, Date.now(), env);
  },
});

export const now = mutation({
  args: {},
  handler: async (ctx): Promise<Result> => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result, intents } = await publishNowCore(ctx.db, caller, {}, Date.now(), env);
    await follow(ctx, intents);
    return result;
  },
});

export const retry = mutation({
  args: {},
  handler: async (ctx): Promise<Result> => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result, intents } = await publishRetryCore(ctx.db, caller, {}, Date.now(), env);
    await follow(ctx, intents);
    return result;
  },
});

// ── The /publish/* routes (convex/http.ts, after routes.ts verified the key) ──

/** convex/lib/routes.ts MachineArgs: the verified key, the route's path, and the body text as signed. */
const machineArgs = { keyId: v.string(), scopes: v.array(v.string()), path: v.string(), body: v.string() };
type MachineCore = (db: MutationCtx["db"], caller: Caller, args: Record<string, unknown>, now: number, env: MachineEnv) => Promise<WithPublishIntents>;

function route(core: MachineCore) {
  return internalMutation({
    args: machineArgs,
    handler: async (ctx, args): Promise<Result> => {
      const body = parseJsonObject(args.body);
      if (body === null) return fail("malformed", "The body is not the JSON object this route takes.");
      const { result, intents } = await core(ctx.db, machineCaller(args.keyId, args.scopes), body, Date.now(), deskEnv());
      await follow(ctx, intents);
      return result;
    },
  });
}

export const claim = route(claimCore);
export const conflict = route(conflictCore);
export const pushed = route(pushedCore);
export const built = route(builtCore);
export const release = route(releaseCore);

// ── Dispatch ──────────────────────────────────────────────────────────────────

/** Scheduled at a run's runAt, and by reconcile. Refused while frozen, before any request. */
export const dispatch = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, { runId }): Promise<string> => {
    const begun: { go: boolean; code: string; dispatchedAt: number | null } = await ctx.runMutation(internal.publish.beginDispatch, { runId });
    if (!begun.go || begun.dispatchedAt === null) return begun.code;
    const outcome = await dispatchRequest(fetch, process.env.GITHUB_DISPATCH_TOKEN, runId);
    await ctx.runMutation(internal.publish.dispatchResult, { runId, dispatchedAt: begun.dispatchedAt, outcome });
    return outcome.kind === "ok" ? "dispatched" : "failed";
  },
});

export const beginDispatch = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args): Promise<{ go: boolean; code: string; dispatchedAt: number | null }> => {
    const { go, code, dispatchedAt, intents } = await beginDispatchCore(ctx.db, args, Date.now(), deskEnv());
    await follow(ctx, intents);
    return { go, code, dispatchedAt };
  },
});

export const dispatchResult = internalMutation({
  args: { runId: v.string(), dispatchedAt: v.number(), outcome: v.any() },
  handler: async (ctx, args): Promise<Result> => {
    const { result, intents } = await dispatchResultCore(ctx.db, args, Date.now(), deskEnv());
    await follow(ctx, intents);
    return result;
  },
});

// ── Verification ──────────────────────────────────────────────────────────────

/** Scheduled by /publish/pushed and reconcile: reads data/posts.json at the pushed sha. */
export const verifyCommit = internalAction({
  args: { runId: v.string(), sha: v.string() },
  handler: async (ctx, { runId, sha }): Promise<string> => {
    if (!SHA_RE.test(sha)) return "bad-sha";
    const archive = await readArchive(fetch, rawArchiveUrl(sha));
    if (!archive.ok) {
      await ctx.runMutation(internal.publish.recordCommit, { runId, sha, error: archive.error });
      return archive.error;
    }
    await ctx.runMutation(internal.publish.recordCommit, { runId, sha, stories: archive.stories, complete: archive.complete });
    return "read";
  },
});

export const recordCommit = internalMutation({
  args: { runId: v.string(), sha: v.string(), stories: v.optional(v.any()), complete: v.optional(v.boolean()), error: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Result> => {
    const { result, intents } = await recordCommitCore(ctx.db, args, Date.now(), deskEnv());
    await follow(ctx, intents);
    return result;
  },
});

/** Cron, every 10 minutes: committed drafts seen on the live site become live. Informational: Pages sends max-age=600. */
export const checkLive = internalAction({
  args: {},
  handler: async (ctx): Promise<string> => {
    const wanted: boolean = await ctx.runQuery(internal.publish.liveWanted, {});
    if (!wanted) return "nothing committed";
    const archive = await readArchive(fetch, LIVE_URL);
    if (!archive.ok) return archive.error;
    await ctx.runMutation(internal.publish.recordLive, { stories: archive.stories });
    return "read";
  },
});

export const liveWanted = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => await liveWantedCore(ctx.db),
});

export const recordLive = internalMutation({
  args: { stories: v.any() },
  handler: async (ctx, args): Promise<Result> => await recordLiveCore(ctx.db, args, Date.now(), deskEnv()),
});

// ── Crons ─────────────────────────────────────────────────────────────────────

export const reconcile = internalMutation({
  args: {},
  handler: async (ctx): Promise<Result> => {
    const { result, intents } = await reconcileCore(ctx.db, Date.now(), deskEnv());
    await follow(ctx, intents);
    return result;
  },
});

export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<Result> => {
    const { result, more } = await sweepCore(ctx.db, Date.now(), deskEnv());
    if (more) await ctx.scheduler.runAfter(0, internal.publish.sweep, {});
    return result;
  },
});
