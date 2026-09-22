// Adapted from projects/vitrina-site/convex/lib/limits.ts: the same shape, with this site's names and numbers.
//
// Every number the desk backend enforces, in one place. Section 4.4 of
// docs/plans/2026-09-15-antenne-desk.md lists most of them; sections 4.3 and
// 6.1 fix the rest. A number that lives in two files drifts in one of them, so
// the cores and the tests import these, and tests/convex-contract.test.mjs
// states each one again literally.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type LimitName = "draft.submit" | "draft.write" | "access.request" | "machine.submit" | "machine.status" | "machine.publish";

/**
 * Sliding windows over rateEvents. A human bucket is "<clerk subject>|<name>"
 * and a machine bucket "key:<keyId>|<name>", never anything the caller sent.
 * draft.write counts one per call, whatever the call carries.
 */
export const LIMITS: Readonly<Record<LimitName, Readonly<{ max: number; windowMs: number }>>> = Object.freeze({
  "draft.submit": Object.freeze({ max: 30, windowMs: HOUR }),
  "draft.write": Object.freeze({ max: 600, windowMs: HOUR }),
  "access.request": Object.freeze({ max: 3, windowMs: DAY }),
  "machine.submit": Object.freeze({ max: 60, windowMs: HOUR }),
  "machine.status": Object.freeze({ max: 120, windowMs: HOUR }),
  "machine.publish": Object.freeze({ max: 120, windowMs: HOUR }),
});

export const LIMIT_NAMES: readonly LimitName[] = Object.freeze(Object.keys(LIMITS) as LimitName[]);

// ── Caps (section 4.4) ────────────────────────────────────────────────────────

/** Stories in one POST /submit. */
export const SUBMIT_BATCH_MAX = 12;
/**
 * Pending drafts the machine keys hold between them, each configured key
 * counted through by_submittedBy; past this /submit answers queue-full. Desk
 * drafts never count toward it.
 */
export const MACHINE_PENDING_MAX = 40;
/**
 * Pending drafts one person may hold, counted through by_submittedBy; past
 * this drafts:submit answers queue-full (the review decision of 2026-09-22).
 */
export const DESK_PENDING_MAX = 20;
/** Pending access requests; past this a new request answers queue-full. */
export const REQUESTS_MAX = 50;
/** Items in one drafts:approveMany. */
export const APPROVE_MANY_MAX = 25;
/** Drafts one /publish/claim takes. */
export const CLAIM_MAX = 25;
/** The largest request body a machine route reads. */
export const BODY_MAX_BYTES = 64000;
/** How far a signed timestamp may sit from the server's clock, either way. */
export const SIGNATURE_WINDOW_MS = 5 * MINUTE;
/** publishAfter = approval time + settings.publishDelayMs, this when no settings row exists. */
export const PUBLISH_DELAY_DEFAULT_MS = 5 * MINUTE;
/** settings:update refuses a publishDelayMs above this (and below 0). */
export const PUBLISH_DELAY_MAX_MS = 30 * MINUTE;
/** A run is failed once it has been attempted this many times. */
export const RUN_MAX_ATTEMPTS = 5;
/** A run dispatched this long ago with no claim is dispatched again. */
export const DISPATCH_STALE_MS = 20 * MINUTE;
/** A claim this old with no push is released; /publish/claim takes such drafts back. */
export const CLAIM_STALE_MS = 30 * MINUTE;

// ── Reads and batches (section 4.3) ───────────────────────────────────────────

/** desk:queue reads at most this many drafts per status through by_status. */
export const QUEUE_PER_STATUS_MAX = 200;
/** desk:queue leaves out live drafts last updated longer ago than this. */
export const LIVE_SHOWN_MS = 7 * DAY;
/** desk:queue leaves out spiked drafts last updated longer ago than this. */
export const SPIKED_SHOWN_MS = 30 * DAY;
/** members:revoke moves at most this many assigned pending drafts per call. */
export const REVOKE_MOVE_MAX = 100;
/** members:requestAccess note, and a drafts:spike note, in code points after trimming. */
export const NOTE_MAX = 200;
/** publish:status warns when GITHUB_DISPATCH_TOKEN_EXPIRES is this close. */
export const TOKEN_WARNING_MS = 30 * DAY;

// Not stated by the contract, chosen here so no stored string is unbounded:
/** A member label typed at grant, and the name an access request copies from the token. */
export const LABEL_MAX = 80;
/** The email an access request copies from the token; 254 is the longest address SMTP carries. */
export const EMAIL_MAX = 254;

// ── Rate rows and the daily sweep (section 6.1) ───────────────────────────────

/** Aged-out rate rows one recordRate deletes, so a long idle bucket cannot make one call expensive. */
export const RATE_PRUNE_MAX = 100;
/** publish:sweep deletes rateEvents older than this: one day past the longest window. */
export const RATE_SWEEP_AGE_MS = 31 * DAY;
/** publish:sweep deletes access requests older than this. */
export const REQUEST_SWEEP_AGE_MS = 30 * DAY;
/** publish:sweep deletes spiked drafts older than this. */
export const SPIKED_SWEEP_AGE_MS = 90 * DAY;
/** publish:sweep deletes publish runs older than this. */
export const RUN_SWEEP_AGE_MS = 30 * DAY;
