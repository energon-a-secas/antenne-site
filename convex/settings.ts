import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveCaller } from "./lib/access.ts";
import type { DeskEnv } from "./lib/access.ts";
import { getSettingsCore, updateSettingsCore } from "./lib/settingsCore.ts";

// settings:get and settings:update (docs/plans/2026-09-15-antenne-desk.md
// section 4.3), thin wrappers over convex/lib/settingsCore.ts.

function deskEnv(): DeskEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
}

export const get = query({
  args: {},
  handler: async (ctx) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await getSettingsCore(ctx.db, caller, {}, Date.now(), env);
  },
});

export const update = mutation({
  // Either field may be left out. defaultAssignee null means nobody; the core
  // answers bad-subject, bad-role or invalid rather than throwing.
  args: { defaultAssignee: v.optional(v.union(v.string(), v.null())), publishDelayMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await updateSettingsCore(ctx.db, caller, args, Date.now(), env);
  },
});
