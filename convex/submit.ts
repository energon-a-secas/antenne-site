import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { machineCaller } from "./lib/access.ts";
import { fail } from "./lib/result.ts";
import { parseJsonObject } from "./lib/routes.ts";
import { ingestCore, meterCore, statusCore } from "./lib/submitCore.ts";
import type { MachineEnv } from "./lib/submitCore.ts";

// The internal functions behind POST /submit and POST /status
// (docs/plans/2026-09-15-antenne-desk.md section 5), thin wrappers over
// convex/lib/submitCore.ts. Only convex/http.ts calls them, after
// convex/lib/routes.ts has verified the request's signature, key and scope.
//
// The caller is the machine principal built from that verified key id and its
// scopes. Nothing here reads a token: getUserIdentity has no part in a
// machine request. The body arrives as the exact text that was signed and is
// parsed here, so a client's JSON never has to pass as a Convex value.

/** Every machine internal function takes these: routes.ts MachineArgs. */
const machineArgs = { keyId: v.string(), scopes: v.array(v.string()), path: v.string(), body: v.string() };

function machineEnv(): MachineEnv {
  return {
    DESK_OWNERS: process.env.DESK_OWNERS,
    DESK_DENY: process.env.DESK_DENY,
    DESK_FROZEN: process.env.DESK_FROZEN,
    GITHUB_DISPATCH_TOKEN_EXPIRES: process.env.GITHUB_DISPATCH_TOKEN_EXPIRES,
    // Read for its key ids alone: /submit counts each configured key's pending drafts.
    MACHINE_KEYS: process.env.MACHINE_KEYS,
  };
}

/** POST /submit: one outcome per story. */
export const ingest = internalMutation({
  args: machineArgs,
  handler: async (ctx, args) => {
    const body = parseJsonObject(args.body);
    if (body === null) return fail("malformed", "The body is not the JSON object this route takes.");
    const caller = machineCaller(args.keyId, args.scopes);
    // ingestCore also answers a links intent for each created or updated draft.
    const { result, intents } = await ingestCore(ctx.db, caller, body, Date.now(), machineEnv());
    for (const intent of intents) if (intent.kind === "links") await ctx.scheduler.runAfter(0, internal.links.check, { draftId: intent.draftId });
    return result;
  },
});

/** POST /status: counts, the queue by id and age, the last run, the token's expiry. */
export const status = internalQuery({
  args: machineArgs,
  handler: async (ctx, args) => {
    return await statusCore(ctx.db, machineCaller(args.keyId, args.scopes), {}, Date.now(), machineEnv());
  },
});

/** The per-key rate of a route whose function is a query (routes.ts meter). */
export const meter = internalMutation({
  args: machineArgs,
  handler: async (ctx, args) => {
    return await meterCore(ctx.db, machineCaller(args.keyId, args.scopes), { path: args.path }, Date.now(), machineEnv());
  },
});
