import { isFrozen } from "./access.ts";
import type { DeskEnv, Scope } from "./access.ts";
import { BODY_MAX_BYTES, SUBMIT_BATCH_MAX } from "./limits.ts";
import type { Result } from "./result.ts";
import { parseMachineKeys, scopeForPath, verifyRequest } from "./signature.ts";
import type { HeaderSource } from "./signature.ts";

// The machine routes of docs/plans/2026-09-15-antenne-desk.md section 5, minus
// the HTTP plumbing (the vitrina clerkWebhookCore pattern). convex/http.ts
// registers one POST route per row of ROUTES and hands each request to
// machineRequest with the internal call injected, so tests/convex-submit.test.mjs
// runs every refusal here with no deployment and no convex/_generated.
//
// The pipeline, in order: the route; MACHINE_KEYS (503 not-configured); the
// declared and the read body size (413 too-large; the body is read once); the
// signature, key and timestamp (401 unauthorized, one answer for every way it
// fails); the key's scope (403 scope); DESK_FROZEN on a write route (503
// frozen); the JSON and its shape (400); the rate meter when the row asks for
// it; the internal function. A refusal from the function comes back as a
// status by its code: rate-limited 429, frozen 503, forbidden 403 scope, and
// 400 for the rest. Every body is { ok, ... }. convex/http.ts registers POST
// only, so on a deployment Convex's own router answers another method or an
// unknown path; the 404 and 405 here answer a direct caller of machineRequest.
//
// Routes never read Authorization and never call getUserIdentity (section 5):
// the caller is the verified key, handed on as keyId and scopes.

/** An internal function a route calls, by its Convex name. publish-bridge adds its own. */
export type RouteFn =
  | "submit:ingest" | "submit:status" | "submit:meter"
  | "publish:claim" | "publish:conflict" | "publish:pushed" | "publish:built" | "publish:release";

/** What every machine internal function takes: the verified key, the route's path, and the body text as signed. */
export type MachineArgs = { keyId: string; scopes: string[]; path: string; body: string };

export type RouteEnv = Pick<DeskEnv, "DESK_FROZEN"> & { MACHINE_KEYS?: string | null };

export type Answer = { status: number; body: { ok: boolean; [k: string]: unknown } };

export type Route = {
  method: "POST";
  path: string;
  /** The scope the key must hold; it must be the scope convex/lib/signature.ts SCOPE_PATHS gives this path. */
  scope: Scope;
  /** The internal function that answers. */
  fn: RouteFn;
  /** Refused with 503 frozen while DESK_FROZEN is 1, before fn runs. Reads keep working. */
  write: boolean;
  /**
   * Record the key's rate through submit:meter before fn runs. For a query,
   * which cannot write a rate row; a mutation checks and records its own rate
   * in its own transaction, as ingestCore does.
   */
  meter: boolean;
  /** Null when the parsed body fits the route, else the 400 answer's code. */
  shape: (body: Record<string, unknown>) => string | null;
};

export const METER_FN: RouteFn = "submit:meter";

const ROWS: Route[] = [
  {
    method: "POST", path: "/submit", scope: "submit", fn: "submit:ingest", write: true, meter: false,
    shape: (body) => (!Array.isArray(body.stories) ? "malformed" : body.stories.length > SUBMIT_BATCH_MAX ? "too-many" : null),
  },
  { method: "POST", path: "/status", scope: "status", fn: "submit:status", write: false, meter: true, shape: () => null },
  // publish-bridge's rows: the publish workflow's calls (scripts/publish-approved.py). Each is a
  // mutation that checks and records the key's machine.publish rate itself, so none is metered.
  // The shapes check types only; convex/lib/publishMachine.ts answers invalid for bad values.
  {
    method: "POST", path: "/publish/claim", scope: "publish", fn: "publish:claim", write: true, meter: false,
    // dryRun is optional and false when absent; anything but a boolean is malformed.
    shape: (body) => {
      const runId = body.runId === null || typeof body.runId === "string";
      const dryRun = body.dryRun === undefined || typeof body.dryRun === "boolean";
      return runId && dryRun ? null : "malformed";
    },
  },
  {
    method: "POST", path: "/publish/conflict", scope: "publish", fn: "publish:conflict", write: true, meter: false,
    shape: (body) => (typeof body.runId === "string" && Array.isArray(body.storyIds) ? null : "malformed"),
  },
  {
    method: "POST", path: "/publish/pushed", scope: "publish", fn: "publish:pushed", write: true, meter: false,
    shape: (body) => (typeof body.runId === "string" && typeof body.sha === "string" && typeof body.noChange === "boolean" ? null : "malformed"),
  },
  {
    method: "POST", path: "/publish/built", scope: "publish", fn: "publish:built", write: true, meter: false,
    shape: (body) => (typeof body.runId === "string" && typeof body.sha === "string" && typeof body.pagesStatus === "string" ? null : "malformed"),
  },
  {
    method: "POST", path: "/publish/release", scope: "publish", fn: "publish:release", write: true, meter: false,
    shape: (body) => (typeof body.runId === "string" && typeof body.reason === "string" ? null : "malformed"),
  },
];

/** Section 5's routes. To add one: a row in ROWS, its function in RouteFn, and its case in convex/http.ts call(). */
export const ROUTES: readonly Route[] = Object.freeze(ROWS);

/** Throws unless every row is a POST on a path its scope signs for, and no path appears twice. Runs at load. */
export function assertRoutes(routes: readonly Route[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.method !== "POST") throw new Error(`routes: ${route.path} is not a POST route`);
    if (scopeForPath(route.path) !== route.scope) throw new Error(`routes: ${route.path} is not signed for by the ${route.scope} scope`);
    if (seen.has(route.path)) throw new Error(`routes: ${route.path} appears twice`);
    seen.add(route.path);
  }
}

assertRoutes(ROUTES);

const MESSAGES: Record<string, string> = {
  "not-found": "No machine route here.",
  method: "Machine routes take POST.",
  "not-configured": "No machine keys are configured.",
  "too-large": `The body is over ${BODY_MAX_BYTES} bytes.`,
  unauthorized: "The request is not signed by a known key, or its timestamp is out of range.",
  scope: "This key's scopes do not cover this route.",
  frozen: "The desk is frozen: reading works, changes are paused.",
  malformed: "The body is not the JSON object this route takes.",
  "too-many": `At most ${SUBMIT_BATCH_MAX} stories per request.`,
  internal: "The request could not be completed.",
};

const STATUS_BY_CODE: Record<string, number> = {
  "not-found": 404, method: 405, "not-configured": 503, frozen: 503, "too-large": 413, unauthorized: 401,
  scope: 403, forbidden: 403, "rate-limited": 429, internal: 500,
};

function refusal(code: string): Answer {
  return { status: STATUS_BY_CODE[code] ?? 400, body: { ok: false, code, message: MESSAGES[code] ?? code } };
}

/** A function's Result as an answer. forbidden, the core's word for a key outside its scope, is sent as scope. */
function answerOf(result: Result): Answer {
  if (result.ok) return { status: 200, body: result };
  if (result.code === "forbidden") return refusal("scope");
  return { status: STATUS_BY_CODE[result.code] ?? 400, body: result };
}

/** Bytes of text in UTF-8, as TextEncoder would write them: a lone surrogate becomes U+FFFD, three bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The body as a JSON object, or null when it is not JSON or not an object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON is an answer (400 malformed), not an error to raise.
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function invoke(run: (fn: RouteFn, args: MachineArgs) => Promise<Result>, fn: RouteFn, args: MachineArgs): Promise<Result | null> {
  try {
    return await run(fn, args);
  } catch (err) {
    // Answered 500 with no detail, and logged by name only: an error's message
    // can quote the arguments, and the body argument is story text. The
    // function's own failure is also in the deployment's logs under its name.
    console.error(`antenne: ${fn} threw ${err instanceof Error ? err.name : typeof err}`);
    return null;
  }
}

/**
 * One machine request. readText reads the body and is called at most once;
 * run calls an internal function by name. Never throws for anything a client
 * can send.
 */
export async function machineRequest(
  method: string,
  path: string,
  headers: HeaderSource,
  readText: () => Promise<string>,
  env: RouteEnv,
  now: number,
  run: (fn: RouteFn, args: MachineArgs) => Promise<Result>,
): Promise<Answer> {
  const route = ROUTES.find((r) => r.path === path);
  if (!route) return refusal("not-found");
  if (method !== route.method) return refusal("method");
  const keys = parseMachineKeys(env.MACHINE_KEYS);
  if (keys.size === 0) return refusal("not-configured");

  const declared = headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared.trim()) > BODY_MAX_BYTES) return refusal("too-large");
  const text = await readText();
  if (utf8Length(text) > BODY_MAX_BYTES) return refusal("too-large");

  const key = await verifyRequest(headers, path, text, keys, now);
  if (key === null) return refusal("unauthorized");
  if (!key.scopes.includes(route.scope)) return refusal("scope");
  if (route.write && isFrozen(env)) return refusal("frozen");

  const body = parseJsonObject(text);
  if (body === null) return refusal("malformed");
  const shapeCode = route.shape(body);
  if (shapeCode !== null) return refusal(shapeCode);

  const args: MachineArgs = { keyId: key.keyId, scopes: [...key.scopes], path, body: text };
  if (route.meter) {
    const metered = await invoke(run, METER_FN, args);
    if (metered === null) return refusal("internal");
    if (!metered.ok) return answerOf(metered);
  }
  const result = await invoke(run, route.fn, args);
  return result === null ? refusal("internal") : answerOf(result);
}
