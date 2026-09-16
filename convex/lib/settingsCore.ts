import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { authorize, checkAssignee, guardWrite, isMember } from "./access.ts";
import type { Caller, DeskEnv, Human } from "./access.ts";
import { PUBLISH_DELAY_DEFAULT_MS, PUBLISH_DELAY_MAX_MS } from "./limits.ts";
import { done, fail } from "./result.ts";
import type { Result } from "./result.ts";

// settings:get and settings:update (docs/plans/2026-09-15-antenne-desk.md
// section 4.3), plus the reads the drafts and members cores share. One row,
// key "desk"; until an owner saves one, the defaults below are the settings.
//
// Cores take (db, caller, args, now, env) as vitrina's do: the caller is what
// resolveCaller made of the token, and env is what the wrapper copied from
// process.env. Nothing here reads either directly.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

export const SETTINGS_KEY = "desk";

export type DeskSettings = { defaultAssignee: string | null; publishDelayMs: number };

export async function settingsRow(db: Reader): Promise<any> {
  return await db.query("settings").withIndex("by_key", (q: any) => q.eq("key", SETTINGS_KEY)).first();
}

/** The stored settings, or the defaults when no row exists yet. */
export async function readSettings(db: Reader): Promise<DeskSettings> {
  const row = await settingsRow(db);
  return {
    defaultAssignee: row ? row.defaultAssignee : null,
    publishDelayMs: row ? row.publishDelayMs : PUBLISH_DELAY_DEFAULT_MS,
  };
}

/**
 * The default assignee while that person still holds reviewer, editor or
 * owner, else null. `except` is never returned: a revoked person does not
 * inherit their own drafts, and nobody is assigned a story they submitted.
 */
export async function eligibleDefaultAssignee(db: Reader, env: DeskEnv, except: string | null = null): Promise<string | null> {
  const { defaultAssignee } = await readSettings(db);
  if (!defaultAssignee || defaultAssignee === except) return null;
  return (await checkAssignee(db, defaultAssignee, env)) === null ? defaultAssignee : null;
}

export async function getSettingsCore(db: Reader, caller: Caller, _args: unknown, _now: number, env: DeskEnv): Promise<Result> {
  // A caller with no role gets empty data, never a refusal that says settings exist.
  if (!isMember(caller)) return done({ defaultAssignee: null, publishDelayMs: null });
  const refused = authorize(caller, "settings.read", env);
  if (refused) return refused;
  const settings = await readSettings(db);
  return done({ defaultAssignee: settings.defaultAssignee, publishDelayMs: settings.publishDelayMs });
}

/** Each field is optional; one left out keeps its value. defaultAssignee may be null (nobody). */
export async function updateSettingsCore(
  db: Db,
  caller: Caller,
  args: { defaultAssignee?: unknown; publishDelayMs?: unknown },
  now: number,
  env: DeskEnv,
): Promise<Result> {
  const refused = guardWrite(caller, "settings.manage", env);
  if (refused) return refused;
  const owner = caller as Human;
  const fields: Record<string, unknown> = {};
  if (args.defaultAssignee !== undefined) {
    if (args.defaultAssignee !== null) {
      const problem = await checkAssignee(db, args.defaultAssignee, env);
      if (problem) return problem;
    }
    fields.defaultAssignee = args.defaultAssignee;
  }
  if (args.publishDelayMs !== undefined) {
    const ms = args.publishDelayMs;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > PUBLISH_DELAY_MAX_MS) {
      return fail("invalid", `The publish delay is a whole number of milliseconds from 0 to ${PUBLISH_DELAY_MAX_MS}.`, {
        problems: [{ field: "publishDelayMs", code: "format" }],
      });
    }
    fields.publishDelayMs = ms;
  }
  const row = await settingsRow(db);
  if (row) {
    await db.patch("settings", row._id, { ...fields, updatedBy: owner.subject, updatedAt: now });
  } else {
    await db.insert("settings", {
      key: SETTINGS_KEY,
      defaultAssignee: null,
      publishDelayMs: PUBLISH_DELAY_DEFAULT_MS,
      ...fields,
      updatedBy: owner.subject,
      updatedAt: now,
    });
  }
  return done();
}
