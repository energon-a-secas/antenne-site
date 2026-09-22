import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Result } from "./lib/result.ts";
import { checkLinks } from "./lib/publishFetch.ts";
import { linkTargetCore, recordLinksCore } from "./lib/publishRecord.ts";
import type { MachineEnv } from "./lib/submitCore.ts";

// links:check and links:record (docs/plans/2026-09-15-antenne-desk.md section
// 6.1). A link check is scheduled when a draft is submitted or updated by
// /submit and when someone asks drafts:recheckLinks. Each link gets HEAD, then
// GET on 405, 8 s each, redirects followed; only a neorgon.com or
// *.neorgon.com link answering 404 or 410, or whose name does not resolve,
// blocks approval. The rules are in convex/lib/publishFetch.ts checkLink and
// convex/lib/publishRecord.ts, with fetch passed in so tests can fake it.

function deskEnv(): MachineEnv {
  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };
}

export const check = internalAction({
  args: { draftId: v.string() },
  handler: async (ctx, { draftId }): Promise<string> => {
    const target: { urls: string[] } | null = await ctx.runQuery(internal.links.target, { draftId });
    if (target === null) return "skipped";
    const checks = await checkLinks(fetch, target.urls);
    await ctx.runMutation(internal.links.record, { draftId, checks });
    return "checked";
  },
});

export const target = internalQuery({
  args: { draftId: v.string() },
  handler: async (ctx, args): Promise<{ urls: string[] } | null> => await linkTargetCore(ctx.db, args, deskEnv()),
});

export const record = internalMutation({
  args: { draftId: v.string(), checks: v.array(v.object({ url: v.string(), status: v.union(v.number(), v.string()), blocking: v.boolean() })) },
  handler: async (ctx, args): Promise<Result> => await recordLinksCore(ctx.db, args, Date.now(), deskEnv()),
});
