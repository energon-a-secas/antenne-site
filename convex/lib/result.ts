// Copied verbatim from projects/vitrina-site/convex/lib/result.ts.
// The one result shape every Vitrina function returns (plan section 3.3).
//
// Expected failures come back as values, never as thrown errors. The client
// writes a sentence per code that names the book it was saving, and it can only
// do that when the code arrives intact; a thrown error reaches the browser as an
// opaque "Server Error" with the code stripped.

export type Failure = { ok: false; code: string; message: string; [k: string]: unknown };
export type Success = { ok: true; [k: string]: unknown };
export type Result = Failure | Success;

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): Failure {
  return { ok: false, code, message, ...extra };
}

export function done(extra: Record<string, unknown> = {}): Success {
  return { ok: true, ...extra };
}
