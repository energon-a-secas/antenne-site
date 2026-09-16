import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { MEMBER_ROLES, SUBJECT_RE, authorize, guardWrite, isFrozen, isMember, memberRow } from "./access.ts";
import type { Caller, DeskEnv, Human, Role } from "./access.ts";
import { recordEvent } from "./draftsCore.ts";
import { EMAIL_MAX, LABEL_MAX, NOTE_MAX, REQUESTS_MAX, REVOKE_MOVE_MAX } from "./limits.ts";
import { isListed, parseSubjects } from "./owners.ts";
import { checkText } from "./post.ts";
import { recordRate, refuseIfLimited } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure, Result } from "./result.ts";
import { eligibleDefaultAssignee } from "./settingsCore.ts";

// desk:me and the people functions of docs/plans/2026-09-15-antenne-desk.md
// section 4.3: members:list, assignable, grant, revoke, requestAccess and
// dismissRequest. Every mutation checks everything before its first write.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

function badSubject(): Failure {
  return fail("bad-subject", "Give a Clerk account id, such as user_2abc.");
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" && SUBJECT_RE.test(value);
}

/** An identity claim trimmed to at most max code points, or "" when the token carries none. */
function clip(value: unknown, max: number): string {
  return typeof value === "string" ? Array.from(value.trim()).slice(0, max).join("") : "";
}

export async function requestRow(db: Reader, subject: string): Promise<any> {
  return await db.query("accessRequests").withIndex("by_subject", (q: any) => q.eq("subject", subject)).first();
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Who the caller is to the desk. Every caller may ask, and learns only about themself. */
export async function meCore(db: Reader, caller: Caller, _args: unknown, _now: number, env: DeskEnv): Promise<Result> {
  const frozen = isFrozen(env);
  if (caller.kind !== "human") return done({ signedIn: false, subject: null, label: null, role: null, frozen, requested: false });
  const requested = (await requestRow(db, caller.subject)) !== null;
  return done({ signedIn: true, subject: caller.subject, label: caller.label, role: caller.role, frozen, requested });
}

export async function listMembersCore(db: Reader, caller: Caller, _args: unknown, _now: number, env: DeskEnv): Promise<Result> {
  if (!isMember(caller)) return done({ members: [], owners: [], requests: [] });
  const refused = authorize(caller, "members.manage", env);
  if (refused) return refused;
  // Only people an owner granted are rows, so the table is small and read whole.
  const rows = await db.query("members").withIndex("by_subject").collect();
  const requests = await db.query("accessRequests").withIndex("by_requestedAt").take(REQUESTS_MAX);
  return done({
    members: rows.map((r: any) => ({
      subject: r.subject, role: r.role, label: r.label, email: r.email, grantedBy: r.grantedBy, grantedAt: r.grantedAt,
      denied: isListed(r.subject, env.DESK_DENY),
    })),
    owners: [...new Set(parseSubjects(env.DESK_OWNERS))].map((subject) => ({ subject, denied: isListed(subject, env.DESK_DENY) })),
    requests: requests.map((r: any) => ({ subject: r.subject, label: r.label, email: r.email, note: r.note, requestedAt: r.requestedAt })),
  });
}

/** The people a story may be assigned to: owners, editors and reviewers, none of them denied. */
export async function assignableCore(db: Reader, caller: Caller, _args: unknown, _now: number, env: DeskEnv): Promise<Result> {
  if (!isMember(caller)) return done({ people: [] });
  const refused = authorize(caller, "draft.assign", env);
  if (refused) return refused;
  const people: { subject: string; label: string | null; role: Role }[] = [];
  const seen = new Set<string>();
  const add = (subject: string, label: string | null, role: Role) => {
    if (seen.has(subject) || isListed(subject, env.DESK_DENY)) return;
    seen.add(subject);
    people.push({ subject, label, role });
  };
  for (const subject of parseSubjects(env.DESK_OWNERS)) add(subject, null, "owner");
  for (const role of ["editor", "reviewer"] as Role[]) {
    const rows = await db.query("members").withIndex("by_role", (q: any) => q.eq("role", role)).collect();
    for (const row of rows) add(row.subject, row.label, role);
  }
  return done({ people });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Grants or changes a role. A pending request from that account is fulfilled, and its email kept. */
export async function grantCore(
  db: Db,
  caller: Caller,
  args: { subject?: unknown; role?: unknown; label?: unknown },
  now: number,
  env: DeskEnv,
): Promise<Result> {
  const refused = guardWrite(caller, "members.manage", env);
  if (refused) return refused;
  const owner = caller as Human;
  if (!validSubject(args.subject)) return badSubject();
  const subject = args.subject;
  // Owners are never rows (section 4.2), so a grant cannot shadow DESK_OWNERS.
  if (isListed(subject, env.DESK_OWNERS)) return fail("bad-subject", "That account is an owner through DESK_OWNERS; owners are never granted a role.");
  const role = args.role;
  if (typeof role !== "string" || !(MEMBER_ROLES as readonly string[]).includes(role)) return fail("bad-role", "Grant editor, reviewer or submitter.");
  const label = checkText("label", args.label, LABEL_MAX);
  if (label.problems.length) {
    return fail("invalid", `A label is 1 to ${LABEL_MAX} plain characters.`, { problems: label.problems });
  }
  const existing = await memberRow(db, subject);
  const request = await requestRow(db, subject);
  const fields = {
    subject,
    role,
    label: label.text,
    email: existing ? existing.email : request ? request.email : null,
    grantedBy: owner.subject,
    grantedAt: now,
  };
  if (existing) await db.patch("members", existing._id, fields);
  else await db.insert("members", fields);
  if (request) await db.delete("accessRequests", request._id);
  return done();
}

/**
 * Deletes the members row, then moves at most REVOKE_MOVE_MAX of that
 * person's assigned pending drafts to the default assignee (if still
 * eligible) or to nobody. `more` says to call again; a later call with no row
 * left still moves drafts, and answers not-found once there is nothing to do.
 */
export async function revokeCore(db: Db, caller: Caller, args: { subject?: unknown }, now: number, env: DeskEnv): Promise<Result> {
  const refused = guardWrite(caller, "members.manage", env);
  if (refused) return refused;
  const owner = caller as Human;
  if (!validSubject(args.subject)) return badSubject();
  const subject = args.subject;
  // An owner holds no row to delete (section 4.2); removing one is an edit to DESK_OWNERS, as for grant.
  if (isListed(subject, env.DESK_OWNERS)) return fail("bad-subject", "That account is an owner through DESK_OWNERS; remove it there.");
  const row = await memberRow(db, subject);
  const assigned = await db
    .query("drafts")
    .withIndex("by_assignee", (q: any) => q.eq("assignee", subject).eq("status", "pending"))
    .take(REVOKE_MOVE_MAX + 1);
  if (!row && assigned.length === 0) return fail("not-found", "No member has that account id.");
  const batch = assigned.slice(0, REVOKE_MOVE_MAX);
  const to = batch.length ? await eligibleDefaultAssignee(db, env, subject) : null;

  if (row) await db.delete("members", row._id);
  for (const draft of batch) {
    const rev = draft.rev + 1;
    await db.patch("drafts", draft._id, { assignee: to, rev, updatedAt: now });
    await recordEvent(db, draft, owner.subject, "assign", { rev, assignee: { from: subject, to }, reason: "revoke" }, now);
  }
  return done({ moved: batch.length, more: assigned.length > REVOKE_MOVE_MAX });
}

/**
 * A signed-in person with no role asks for one. name and email are the
 * token's claims, handed in by the wrapper; the browser sends only the note.
 * Asking again updates the open request rather than adding one.
 */
export async function requestAccessCore(
  db: Db,
  caller: Caller,
  args: { note?: unknown; name?: unknown; email?: unknown },
  now: number,
  env: DeskEnv,
): Promise<Result> {
  const refused = guardWrite(caller, "access.request", env);
  if (refused) return refused;
  const person = caller as Human;
  let note: string | null = null;
  if (args.note !== undefined && args.note !== null && !(typeof args.note === "string" && args.note.trim() === "")) {
    const checked = checkText("note", args.note, NOTE_MAX);
    if (checked.problems.length) return fail("invalid", `A note is at most ${NOTE_MAX} plain characters.`, { problems: checked.problems });
    note = checked.text;
  }
  const existing = await requestRow(db, person.subject);
  if (!existing) {
    const open = await db.query("accessRequests").withIndex("by_requestedAt").take(REQUESTS_MAX);
    if (open.length >= REQUESTS_MAX) return fail("queue-full", "The desk has too many open access requests. Try again later.");
  }
  const limited = await refuseIfLimited(db, person.subject, "access.request", now, "access requests in a day");
  if (limited) return limited;

  const label = clip(args.name, LABEL_MAX);
  const email = clip(args.email, EMAIL_MAX) || null;
  if (existing) await db.patch("accessRequests", existing._id, { label, email, note });
  else await db.insert("accessRequests", { subject: person.subject, label, email, note, requestedAt: now });
  await recordRate(db, person.subject, "access.request", now);
  return done();
}

export async function dismissRequestCore(db: Db, caller: Caller, args: { subject?: unknown }, _now: number, env: DeskEnv): Promise<Result> {
  const refused = guardWrite(caller, "members.manage", env);
  if (refused) return refused;
  if (!validSubject(args.subject)) return badSubject();
  const row = await requestRow(db, args.subject);
  if (!row) return fail("not-found", "No access request from that account id.");
  await db.delete("accessRequests", row._id);
  return done();
}
