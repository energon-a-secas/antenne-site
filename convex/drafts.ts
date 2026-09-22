import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { resolveCaller } from "./lib/access.ts";
import type { DeskEnv } from "./lib/access.ts";
import {
  approveCore, approveManyCore, assignCore, editCore, overrideLinksCore, recheckLinksCore, reopenCore, spikeCore, submitCore,
  takeCore, withdrawCore,
} from "./lib/draftsCore.ts";
import type { Intent } from "./lib/draftsCore.ts";
import { queueRun } from "./lib/publishCore.ts";

// The drafts:* mutations (docs/plans/2026-09-15-antenne-desk.md section 4.3),
// thin wrappers over convex/lib/draftsCore.ts in vitrina's pattern. Each reads
// the token's subject and the desk variables, resolves the caller, calls the
// core and returns its Result.
//
// approveCore, approveManyCore, editCore and recheckLinksCore also return an
// intent: a publish intent { kind: "publish", runAt } or a links intent
// { kind: "links", draftId }. editCore asks for a link check only when an edit
// changes the set of link urls. A successful submit gets a links intent from
// its wrapper, since submitCore asks for none. follow() turns an intent into a
// schedule in the same mutation, so it commits with the change or not at all:
// a publish intent creates or reuses the queued publish run (followUp when a
// run is active, convex/lib/publishCore.ts queueRun) and schedules
// ctx.scheduler.runAt(runAt, internal.publish.dispatch, { runId }); a links
// intent schedules links:check.

function deskEnv(): DeskEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
}

/** Schedules what a core asked for, after its writes. A refused call returns no intent. */
async function follow(ctx: MutationCtx, intent: Intent | null): Promise<void> {
  if (intent === null) return;
  if (intent.kind === "links") {
    await ctx.scheduler.runAfter(0, internal.links.check, { draftId: intent.draftId });
    return;
  }
  const queued = await queueRun(ctx.db, "approve", intent.runAt, Date.now());
  if (queued.intent !== null && queued.intent.kind === "dispatch") {
    await ctx.scheduler.runAt(queued.intent.runAt, internal.publish.dispatch, { runId: queued.intent.runId });
  }
}

export const submit = mutation({
  // v.any(): the core's desk-mode validator is the check, and it answers
  // invalid with every problem, where a validator error would reach the
  // browser as an opaque throw.
  args: { post: v.any() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const result = await submitCore(ctx.db, caller, args, Date.now(), env);
    // submitCore asks for no link check; a desk draft is checked as a /submit one is, or a blocking link could never block it.
    if (result.ok && typeof result.draftId === "string") await follow(ctx, { kind: "links", draftId: result.draftId });
    return result;
  },
});

export const edit = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), patch: v.any() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    // A links intent only when the edit changed the set of link urls: text edits send no requests.
    const { result, intent } = await editCore(ctx.db, caller, args, Date.now(), env);
    await follow(ctx, intent);
    return result;
  },
});

export const approve = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), patch: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result, intent } = await approveCore(ctx.db, caller, args, Date.now(), env);
    await follow(ctx, intent);
    return result;
  },
});

export const approveMany = mutation({
  // At most APPROVE_MANY_MAX items; the core answers too-many past that.
  args: { items: v.array(v.object({ draftId: v.id("drafts"), expectedRev: v.number() })) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result, intent } = await approveManyCore(ctx.db, caller, args, Date.now(), env);
    await follow(ctx, intent);
    return result;
  },
});

export const withdraw = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await withdrawCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const reopen = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await reopenCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const take = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await takeCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const overrideLinks = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await overrideLinksCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const spike = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await spikeCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const assign = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), assignee: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await assignCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const recheckLinks = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result, intent } = await recheckLinksCore(ctx.db, caller, args, Date.now(), env);
    await follow(ctx, intent);
    return result;
  },
});
