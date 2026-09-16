// Adapted from projects/vitrina-site/convex/lib/rate.ts: the same window and messages; the prune moves out of the check, and the retry time gains a millisecond.
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { LIMITS, RATE_PRUNE_MAX } from "./limits.ts";
import type { LimitName } from "./limits.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";

// A sliding window over rateEvents rows, checked inside the caller's own
// transaction and answered as a failure value rather than a throw, so the desk
// can say what was refused.
//
// Two changes from vitrina. There, checkRate pruned aged-out rows while it read.
// Here every core checks everything before its first write, and a refused call
// must write nothing (docs/plans/2026-09-15-antenne-desk.md section 4.2), so
// checkRate only reads, and the prune happens in recordRate, which a core calls
// once the call has passed every check. And a row at `at` still counts at
// exactly at + windowMs (the window reads at >= now - windowMs), so the wait a
// refusal names ends one millisecond after that, when a retry does fit.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

export type Verdict = { allowed: boolean; used: number; max: number; retryAfterMs: number };

/** principal is a Clerk subject, or "key:<keyId>" for a machine key. */
export function bucketFor(principal: string, name: LimitName): string {
  return `${principal}|${name}`;
}

/** Reads the window. Writes nothing. */
export async function checkRate(db: Reader, principal: string, name: LimitName, now: number): Promise<Verdict> {
  const { max, windowMs } = LIMITS[name];
  // Ascending by at, so the first row is the one that has to age out next.
  const recent = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucketFor(principal, name)).gte("at", now - windowMs))
    .take(max);
  if (recent.length >= max) {
    return { allowed: false, used: recent.length, max, retryAfterMs: Math.max(1, recent[0].at + windowMs + 1 - now) };
  }
  return { allowed: true, used: recent.length, max, retryAfterMs: 0 };
}

/** Records one use, after pruning at most RATE_PRUNE_MAX rows of this bucket that have aged out. */
export async function recordRate(db: Db, principal: string, name: LimitName, now: number): Promise<void> {
  const bucket = bucketFor(principal, name);
  const stale = await db
    .query("rateEvents")
    .withIndex("by_bucket_at", (q: any) => q.eq("bucket", bucket).lt("at", now - LIMITS[name].windowMs))
    .take(RATE_PRUNE_MAX);
  for (const row of stale) await db.delete("rateEvents", row._id);
  await db.insert("rateEvents", { bucket, at: now });
}

function unit(n: number, name: string): string {
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** Rounded up, in the largest unit that does not under-state the wait. */
export function retryAfterText(ms: number): string {
  const safe = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const minutes = Math.max(1, Math.ceil(safe / 60000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.ceil(hours / 24), "day");
}

export function rateLimited(verdict: Verdict, what: string): Failure {
  return fail("rate-limited", `Too many ${what}. Try again in ${retryAfterText(verdict.retryAfterMs)}.`, {
    retryAfterMs: verdict.retryAfterMs,
  });
}

/** The check half, for the list of checks before a core's first write: a failure when the window is full, else null. */
export async function refuseIfLimited(db: Reader, principal: string, name: LimitName, now: number, what: string): Promise<Failure | null> {
  const verdict = await checkRate(db, principal, name, now);
  return verdict.allowed ? null : rateLimited(verdict, what);
}
