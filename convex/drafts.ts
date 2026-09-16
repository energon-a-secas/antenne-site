import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { resolveCaller } from "./lib/access.ts";
import type { DeskEnv } from "./lib/access.ts";
import {
  approveCore, approveManyCore, assignCore, editCore, overrideLinksCore, recheckLinksCore, reopenCore, spikeCore, submitCore,
  takeCore, withdrawCore,
} from "./lib/draftsCore.ts";

// The drafts:* mutations (docs/plans/2026-09-15-antenne-desk.md section 4.3),
// thin wrappers over convex/lib/draftsCore.ts in vitrina's pattern. Each reads
// the token's subject and the desk variables, resolves the caller, calls the
// core and returns its Result.
//
// approveCore, approveManyCore and recheckLinksCore also return an intent: a
// publish intent { kind: "publish", runAt } or a links intent { kind: "links",
// draftId }. Scheduling them (ctx.scheduler.runAt(runAt,
// internal.publish.dispatch, { runId }) and links:check) belongs to the
// publish-bridge stream; until it lands, these wrappers drop the intent and
// return only the result.

function deskEnv(): DeskEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
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
    return await submitCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const edit = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), patch: v.any() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await editCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const approve = mutation({
  args: { draftId: v.id("drafts"), expectedRev: v.number(), patch: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    const { result } = await approveCore(ctx.db, caller, args, Date.now(), env);
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
    const { result } = await approveManyCore(ctx.db, caller, args, Date.now(), env);
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
    const { result } = await recheckLinksCore(ctx.db, caller, args, Date.now(), env);
    return result;
  },
});
