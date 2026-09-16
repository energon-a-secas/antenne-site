import { query } from "./_generated/server";
import { resolveCaller } from "./lib/access.ts";
import type { DeskEnv } from "./lib/access.ts";
import { queueCore } from "./lib/draftsCore.ts";
import { meCore } from "./lib/membersCore.ts";

// desk:me and desk:queue (docs/plans/2026-09-15-antenne-desk.md section 4.3).
//
// Thin wrappers, vitrina's pattern. A handler reads the token's subject and the
// three desk variables, resolves the caller, and returns the core's Result. The
// rules live in convex/lib, where make validate tests them with no deployment.
// The person is always the token's subject, never an argument.

function deskEnv(): DeskEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await meCore(ctx.db, caller, {}, Date.now(), env);
  },
});

export const queue = query({
  args: {},
  handler: async (ctx) => {
    const env = deskEnv();
    const identity = await ctx.auth.getUserIdentity();
    const caller = await resolveCaller(ctx.db, identity ? identity.subject : null, env);
    return await queueCore(ctx.db, caller, {}, Date.now(), env);
  },
});
