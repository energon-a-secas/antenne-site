import type { GenericDatabaseReader } from "convex/server";
import { isListed } from "./owners.ts";
import { fail } from "./result.ts";
import type { Failure } from "./result.ts";

// Who may do what on the desk: docs/plans/2026-09-15-antenne-desk.md section 4.2.
//
// The permission table is data, so tests/convex-access.test.mjs holds it
// against the contract cell by cell. assertMachineSeparation runs when this
// module loads: a table in which a machine scope reaches a human action throws
// on import, so no function that imports it can run with that table.
//
// resolveCaller turns the token's subject into a role on every call, from env
// and the members table. Nothing about authority comes from the token's claims,
// from Clerk user metadata, or from anything the browser sends.

type Reader = GenericDatabaseReader<any>;

export type Role = "owner" | "editor" | "reviewer" | "submitter";
export type Scope = "submit" | "status" | "publish";
export type HumanAction =
  | "queue.read" | "draft.submit" | "draft.edit" | "draft.approve" | "draft.spike" | "draft.withdraw"
  | "draft.reopen" | "draft.assign" | "draft.take" | "draft.overrideLinks" | "members.manage"
  | "settings.read" | "settings.manage" | "publish.read" | "publish.trigger" | "access.request";
export type MachineAction = "machine.submit" | "machine.status" | "machine.publish";
export type Action = HumanAction | MachineAction;

export type Anon = { kind: "anon" };
export type Human = { kind: "human"; subject: string; role: Role | null; label: string | null };
export type Machine = { kind: "machine"; keyId: string; scopes: Scope[] };
export type Caller = Anon | Human | Machine;

/** The env a core is handed; the wrappers in convex/*.ts copy these from process.env. */
export type DeskEnv = { DESK_OWNERS?: string | null; DESK_DENY?: string | null; DESK_FROZEN?: string | null };

export const ROLES: readonly Role[] = Object.freeze(["owner", "editor", "reviewer", "submitter"]);
/** The roles a members row may hold. */
export const MEMBER_ROLES: readonly Role[] = Object.freeze(["editor", "reviewer", "submitter"]);
/** Who may hold a story: draft.assign's rule, and the default assignee's. */
export const ASSIGNABLE_ROLES: readonly Role[] = Object.freeze(["owner", "editor", "reviewer"]);
export const SCOPE_NAMES: readonly Scope[] = Object.freeze(["submit", "status", "publish"]);
export const MACHINE_ACTIONS: readonly MachineAction[] = Object.freeze(["machine.submit", "machine.status", "machine.publish"]);
/** A Clerk user id, as members:grant takes it. */
export const SUBJECT_RE = /^user_[A-Za-z0-9]+$/;

const ANY_MEMBER = Object.freeze(["owner", "editor", "reviewer", "submitter"] as Role[]);
const REVIEWERS_UP = Object.freeze(["owner", "editor", "reviewer"] as Role[]);
const EDITORS_UP = Object.freeze(["owner", "editor"] as Role[]);
const OWNER_ONLY = Object.freeze(["owner"] as Role[]);

/** Section 4.2's table. The extra rule in each row's last cell is checked in the core. */
export const PERMISSIONS: Readonly<Record<HumanAction, readonly Role[]>> = Object.freeze({
  "queue.read": ANY_MEMBER,
  "draft.submit": ANY_MEMBER,
  "draft.edit": ANY_MEMBER,
  "draft.approve": REVIEWERS_UP,
  "draft.spike": ANY_MEMBER,
  "draft.withdraw": REVIEWERS_UP,
  "draft.reopen": EDITORS_UP,
  "draft.assign": EDITORS_UP,
  "draft.take": REVIEWERS_UP,
  "draft.overrideLinks": OWNER_ONLY,
  "members.manage": OWNER_ONLY,
  "settings.read": EDITORS_UP,
  "settings.manage": OWNER_ONLY,
  "publish.read": REVIEWERS_UP,
  "publish.trigger": EDITORS_UP,
  // No role: a signed-in person whose role is null and who is not in
  // DESK_DENY. authorize checks that instead of a list.
  "access.request": Object.freeze([] as Role[]),
});

/** Each machine scope reaches exactly one machine action. */
export const SCOPES: Readonly<Record<Scope, readonly MachineAction[]>> = Object.freeze({
  submit: Object.freeze(["machine.submit"] as MachineAction[]),
  status: Object.freeze(["machine.status"] as MachineAction[]),
  publish: Object.freeze(["machine.publish"] as MachineAction[]),
});

export type AccessTable = { permissions: Record<string, readonly string[]>; scopes: Record<string, readonly string[]> };

function has(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Throws unless humans and machines are kept apart: every scope is a known
 * one and reaches exactly one machine action, no two scopes share it, no scope
 * reaches a human action, and the human table lists only human roles and no
 * machine action.
 */
export function assertMachineSeparation(table: AccessTable): void {
  const humanActions = Object.keys(table.permissions);
  const reached = new Set<string>();
  for (const scope of Object.keys(table.scopes)) {
    const actions = table.scopes[scope];
    for (const action of actions) {
      if (humanActions.includes(action)) throw new Error(`access: the ${scope} scope reaches the human action ${action}`);
      if (!(MACHINE_ACTIONS as readonly string[]).includes(action)) throw new Error(`access: the ${scope} scope reaches ${action}, which is not a machine action`);
      if (reached.has(action)) throw new Error(`access: more than one scope reaches ${action}`);
      reached.add(action);
    }
    if (!(SCOPE_NAMES as readonly string[]).includes(scope)) throw new Error(`access: ${scope} is not a machine scope`);
    if (actions.length !== 1) throw new Error(`access: the ${scope} scope must reach exactly one machine action`);
  }
  for (const action of humanActions) {
    if ((MACHINE_ACTIONS as readonly string[]).includes(action)) throw new Error(`access: the human table lists the machine action ${action}`);
    for (const role of table.permissions[action]) {
      if (!(ROLES as readonly string[]).includes(role)) throw new Error(`access: ${action} lists ${role}, which is not a human role`);
    }
  }
}

assertMachineSeparation({ permissions: PERMISSIONS, scopes: SCOPES });

export async function memberRow(db: Reader, subject: string): Promise<any> {
  return await db.query("members").withIndex("by_subject", (q: any) => q.eq("subject", subject)).first();
}

/**
 * The caller behind a token subject, resolved in the contract's order:
 * DESK_DENY gives role null, DESK_OWNERS gives owner, a members row gives its
 * role, anything else null. No subject is anon. Lists match exactly.
 * Machine principals never come from here: a machine route verifies its
 * signature and builds one with machineCaller.
 */
export async function resolveCaller(db: Reader, subject: string | null | undefined, env: DeskEnv): Promise<Caller> {
  if (typeof subject !== "string" || subject === "") return { kind: "anon" };
  if (isListed(subject, env.DESK_DENY)) return { kind: "human", subject, role: null, label: null };
  if (isListed(subject, env.DESK_OWNERS)) return { kind: "human", subject, role: "owner", label: null };
  const row = await memberRow(db, subject);
  if (row && (MEMBER_ROLES as readonly string[]).includes(row.role)) {
    return { kind: "human", subject, role: row.role as Role, label: row.label };
  }
  return { kind: "human", subject, role: null, label: null };
}

/** A verified machine key as a caller. Unknown scopes are dropped, so they reach nothing. */
export function machineCaller(keyId: string, scopes: readonly string[]): Machine {
  return { kind: "machine", keyId, scopes: scopes.filter((s): s is Scope => (SCOPE_NAMES as readonly string[]).includes(s)) };
}

/** The rate-limit and draftEvents actor: the subject, or key:<keyId>. */
export function principalOf(caller: Human | Machine): string {
  return caller.kind === "machine" ? `key:${caller.keyId}` : caller.subject;
}

export function isMember(caller: Caller): caller is Human & { role: Role } {
  return caller.kind === "human" && caller.role !== null;
}

export function isFrozen(env: DeskEnv): boolean {
  return typeof env.DESK_FROZEN === "string" && env.DESK_FROZEN.trim() === "1";
}

/** null when caller may take action; else the refusal, as a value. */
export function authorize(caller: Caller, action: Action, env: DeskEnv): Failure | null {
  const machineAction = (MACHINE_ACTIONS as readonly string[]).includes(action);
  if (caller.kind === "machine") {
    const reachable = machineAction && caller.scopes.some((scope) => has(SCOPES, scope) && SCOPES[scope].includes(action as MachineAction));
    return reachable ? null : fail("forbidden", "This key's scopes do not cover that.");
  }
  if (machineAction) return fail("forbidden", "Only a machine key can do that.");
  if (caller.kind !== "human") return fail("not-signed-in", "Sign in to use the desk.");
  if (action === "access.request") {
    if (caller.role !== null) return fail("forbidden", "This account already holds a desk role.");
    if (isListed(caller.subject, env.DESK_DENY)) return fail("forbidden", "This account cannot request desk access.");
    return null;
  }
  if (caller.role === null) return fail("not-member", "This account holds no desk role. Ask an owner for access.");
  if (!has(PERMISSIONS, action)) return fail("forbidden", "Your desk role cannot do that.");
  return PERMISSIONS[action as HumanAction].includes(caller.role) ? null : fail("forbidden", "Your desk role cannot do that.");
}

/** Every mutation core's first check: DESK_FROZEN, then authorize. */
export function guardWrite(caller: Caller, action: Action, env: DeskEnv): Failure | null {
  if (isFrozen(env)) return fail("frozen", "The desk is frozen: reading works, changes are paused.");
  return authorize(caller, action, env);
}

/** null when subject may hold a story; else bad-subject (not an account id, or no role) or bad-role (a submitter). */
export async function checkAssignee(db: Reader, subject: unknown, env: DeskEnv): Promise<Failure | null> {
  if (typeof subject !== "string" || !SUBJECT_RE.test(subject)) return fail("bad-subject", "Give a Clerk account id, such as user_2abc.");
  const who = await resolveCaller(db, subject, env);
  if (who.kind !== "human" || who.role === null) return fail("bad-subject", "That account holds no desk role.");
  if (!ASSIGNABLE_ROLES.includes(who.role)) return fail("bad-role", "Only a reviewer, an editor or an owner can hold a story.");
  return null;
}
