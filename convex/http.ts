import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Result } from "./lib/result.ts";
import { ROUTES, machineRequest } from "./lib/routes.ts";
import type { MachineArgs, RouteFn } from "./lib/routes.ts";

// The machine routes, at https://<deployment>.convex.site (.site, not .cloud):
// docs/plans/2026-09-15-antenne-desk.md section 5. Every decision is in
// convex/lib/routes.ts; this registers one POST route per row of its table,
// hands it the request, and runs the internal function it names.
//
// Nothing here reads the Authorization header or calls getUserIdentity. In an
// HTTP action getUserIdentity throws when an Authorization header fails Convex
// auth, and a machine request is authenticated by its signature alone.

const http = httpRouter();

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

/** The internal function behind each RouteFn. A RouteFn with no case here fails the typecheck at deploy. */
async function call(ctx: ActionCtx, fn: RouteFn, args: MachineArgs): Promise<Result> {
  switch (fn) {
    case "submit:ingest":
      return await ctx.runMutation(internal.submit.ingest, args);
    case "submit:status":
      return await ctx.runQuery(internal.submit.status, args);
    case "submit:meter":
      return await ctx.runMutation(internal.submit.meter, args);
    case "publish:claim":
      return await ctx.runMutation(internal.publish.claim, args);
    case "publish:conflict":
      return await ctx.runMutation(internal.publish.conflict, args);
    case "publish:pushed":
      return await ctx.runMutation(internal.publish.pushed, args);
    case "publish:built":
      return await ctx.runMutation(internal.publish.built, args);
    case "publish:release":
      return await ctx.runMutation(internal.publish.release, args);
    default: {
      const unknown: never = fn;
      throw new Error(`http: no internal function for ${String(unknown)}`);
    }
  }
}

for (const route of ROUTES) {
  http.route({
    path: route.path,
    method: route.method,
    handler: httpAction(async (ctx, request) => {
      const answer = await machineRequest(
        request.method,
        new URL(request.url).pathname,
        request.headers,
        // Read once, as text: the signature covers these exact bytes.
        () => request.text(),
        { MACHINE_KEYS: process.env.MACHINE_KEYS, DESK_FROZEN: process.env.DESK_FROZEN },
        Date.now(),
        (fn, args) => call(ctx, fn, args),
      );
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: JSON_HEADERS });
    }),
  });
}

export default http;
