import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { REPLAY_KEEP_MS, REPLAY_PRUNE_MAX } from "./limits.ts";
import { fail } from "./result.ts";
import type { Failure, Result } from "./result.ts";

// A signed write request is answered once (review F17, the amendment of
// 2026-11-03 to docs/plans/2026-09-15-antenne-desk.md section 10). A
// signature stays valid for SIGNATURE_WINDOW_MS either side of the clock, so
// before this a request captured on the wire could be sent again inside that
// span and was answered again: a replayed /submit put back older machine text
// and spent the key's hourly quota, a replayed claim that names no run took
// the approvals due since into a run no workflow held and answered their
// text, and a replayed release spent one of a run's RUN_MAX_ATTEMPTS.
//
// convex/lib/routes.ts hands every machine function the digest of the
// request it verified (convex/lib/signature.ts requestDigest). The wrapper of
// each write route (convex/submit.ts ingest, the five in convex/publish.ts)
// runs its core through once(): a digest answered within REPLAY_KEEP_MS is
// refused with replayed before the core runs, and a digest is recorded only
// when the core answered ok, in the same transaction as the core's writes. A
// refusal, the replay's included, writes nothing.
//
// Never refused: a client's own retry, since scripts/antenne_sign.py signs
// every call afresh and a new timestamp is a new digest. /status is not run
// through once(): it is a read, its body is {} for every caller, and the
// collectors can ask with the same key in the same second.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

/** convex/lib/signature.ts requestDigest: 64 lowercase hex. */
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/** The refusal for a request this deployment already answered, or for a digest that is not one; else null. Reads only. */
export async function refuseIfReplayed(db: Reader, digest: unknown, now: number): Promise<Failure | null> {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    return fail("invalid", "The request does not fit this function.", { problems: [{ field: "digest", code: "format" }] });
  }
  const seen = await db.query("seenRequests").withIndex("by_digest", (q: any) => q.eq("digest", digest).gte("at", now - REPLAY_KEEP_MS)).first();
  return seen === null ? null : fail("replayed", "This signed request was already answered. Sign it again to repeat it.");
}

/** Records an answered request, after deleting at most REPLAY_PRUNE_MAX rows that have aged out. */
export async function recordRequest(db: Db, digest: string, now: number): Promise<void> {
  const stale = await db.query("seenRequests").withIndex("by_at", (q: any) => q.lt("at", now - REPLAY_KEEP_MS)).take(REPLAY_PRUNE_MAX);
  for (const row of stale) await db.delete("seenRequests", row._id);
  await db.insert("seenRequests", { digest, at: now });
}

/** Runs core for a request not answered before, and remembers the request when core answers ok. */
export async function once<I>(db: Db, digest: unknown, now: number, core: () => Promise<{ result: Result; intents: I[] }>): Promise<{ result: Result; intents: I[] }> {
  const replayed = await refuseIfReplayed(db, digest, now);
  if (replayed) return { result: replayed, intents: [] };
  const out = await core();
  if (out.result.ok) await recordRequest(db, digest as string, now);
  return out;
}
