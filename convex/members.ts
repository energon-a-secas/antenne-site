import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveCaller } from "./lib/access.ts";
import type { DeskEnv } from "./lib/access.ts";
import {
  assignableCore, dismissRequestCore, grantCore, listMembersCore, requestAccessCore, revokeCore,
} from "./lib/membersCore.ts";

// The members:* functions (docs/plans/2026-09-15-antenne-desk.md section 4.3),
// thin wrappers over convex/lib/membersCore.ts in vitrina's pattern. Owners are
// DESK_OWNERS, read here on every call and never stored.

function deskEnv(): DeskEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await listMembersCore(ctx.db, caller, {}, Date.now(), env);
  },
});

export const assignable = query({
  args: {},
  handler: async (ctx) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await assignableCore(ctx.db, caller, {}, Date.now(), env);
  },
});

export const grant = mutation({
  args: { subject: v.string(), role: v.string(), label: v.string() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await grantCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const revoke = mutation({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await revokeCore(ctx.db, caller, args, Date.now(), env);
  },
});

export const requestAccess = mutation({
  args: { note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    // The name and email come from the token; the browser sends only the note.
    const claims = { name: identity ? identity.name : null, email: identity ? identity.email : null };
    return await requestAccessCore(ctx.db, caller, { note: args.note, ...claims }, Date.now(), env);
  },
});

export const dismissRequest = mutation({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await dismissRequestCore(ctx.db, caller, args, Date.now(), env);
  },
});
