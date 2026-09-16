import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { authorize, checkAssignee, guardWrite, isMember } from "./access.ts";
import type { Action, Caller, DeskEnv, Human } from "./access.ts";
import { canonicalJson, contentHash } from "./canonical.ts";
import { APPROVE_MANY_MAX, LIVE_SHOWN_MS, NOTE_MAX, QUEUE_PER_STATUS_MAX, SPIKED_SHOWN_MS } from "./limits.ts";
import { checkText, validatePost } from "./post.ts";
import type { Post, Problem } from "./post.ts";
import { recordRate, refuseIfLimited } from "./rate.ts";
import { done, fail } from "./result.ts";
import type { Failure, Result } from "./result.ts";
import { eligibleDefaultAssignee, readSettings } from "./settingsCore.ts";
import type { DeskSettings } from "./settingsCore.ts";

// desk:queue and the drafts:* mutations of docs/plans/2026-09-15-antenne-desk.md
// sections 4.2 and 4.3. A returned failure still commits whatever the mutation
// wrote before it, so every core runs all of its checks before its first
// write, in this order: frozen and the permission table; the draft (not-found,
// and a submitter's view is their own drafts); expectedRev (stale); status;
// the role's extra rule; the values (invalid, duplicate-id, external-links,
// links-blocked); the rate limit. Then it writes the change and one
// draftEvents row, whose detail holds ids, revs, field names and hashes and
// never story text.

type Reader = GenericDatabaseReader<any>;
type Db = GenericDatabaseWriter<any>;

export const STATUSES: readonly string[] = Object.freeze(["pending", "approved", "publishing", "committed", "live", "spiked"]);
const POST_FIELDS: readonly string[] = Object.freeze(["id", "date", "kind", "site", "title", "summary", "body", "links", "tags"]);
const UNAPPROVED = Object.freeze({ status: "pending", approvedHash: null, approvedBy: null, approvedAt: null, publishAfter: null });
const WRITES = "desk changes this hour";

/** What a wrapper schedules after the mutation commits. publish-bridge wires both kinds. */
export type Intent = { kind: "publish"; runAt: number } | { kind: "links"; draftId: string };
export type WithIntent = { result: Result; intent: Intent | null };

type DraftArgs = { draftId?: unknown; expectedRev?: unknown };
type Rule = (draft: any, caller: Human) => Failure | null;

export async function recordEvent(db: Db, draft: { _id: string; storyId: string }, actor: string, action: string, detail: Record<string, unknown>, now: number): Promise<void> {
  await db.insert("draftEvents", { draftId: draft._id, storyId: draft.storyId, actor, action, detail, at: now });
}

/** Every field of a new drafts row, so each way a draft is born writes the same shape. */
export function newDraft(p: { post: Post; hash: string; external: boolean; source: "desk" | "machine"; submittedBy: string; assignee: string | null; now: number }): Record<string, unknown> {
  return {
    storyId: p.post.id, post: p.post, status: "pending", assignee: p.assignee, rev: 1, machineRev: p.source === "machine" ? 1 : 0,
    humanTouched: p.source === "desk", contentHash: p.hash, external: p.external, source: p.source, submittedBy: p.submittedBy,
    submittedAt: p.now, updatedAt: p.now, approvedHash: null, approvedBy: null, approvedAt: null, publishAfter: null,
    claimRun: null, claimedAt: null, commitSha: null, committedAt: null, linkOverride: null, linkChecks: null, note: null,
  };
}

/** True when a draft or a published story already holds storyId. */
export async function idTaken(db: Reader, storyId: string, exceptDraftId: string | null): Promise<boolean> {
  const drafts = await db.query("drafts").withIndex("by_storyId", (q: any) => q.eq("storyId", storyId)).take(2);
  if (drafts.some((d: any) => d._id !== exceptDraftId)) return true;
  return (await db.query("publishedIds").withIndex("by_storyId", (q: any) => q.eq("storyId", storyId)).first()) !== null;
}

/** A link check blocks approval until an owner overrides it. */
export function linksBlocked(linkChecks: unknown, linkOverride: unknown): boolean {
  return linkOverride === null && Array.isArray(linkChecks) && linkChecks.some((c: any) => !!c && c.blocking === true);
}

function invalid(problems: Problem[]): Failure {
  return fail("invalid", "The story does not pass the desk rules.", { problems });
}

/** A submitter sees and acts on only the drafts they submitted; to them the rest do not exist. */
function visible(draft: any, caller: Human): boolean {
  return caller.role !== "submitter" || draft.submittedBy === caller.subject;
}

const reviewerHolds: Rule = (d, c) =>
  c.role === "reviewer" && d.assignee !== c.subject ? fail("forbidden", "A reviewer edits only the stories assigned to them.") : null;
const reviewerHoldsOrFree: Rule = (d, c) =>
  c.role === "reviewer" && d.assignee !== null && d.assignee !== c.subject ? fail("forbidden", "This story is assigned to someone else.") : null;
const notOwnSubmission: Rule = (d, c) =>
  c.role !== "owner" && d.submittedBy === c.subject ? fail("own-submission", "Someone else has to approve a story you submitted.") : null;
const unclaimed: Rule = (d) => (d.claimRun !== null ? fail("status", "Publishing has already claimed this story.", { status: d.status }) : null);
const reviewerOwnApproval: Rule = (d, c) =>
  c.role === "reviewer" && d.approvedBy !== c.subject ? fail("forbidden", "A reviewer withdraws only their own approvals.") : null;
const unassigned: Rule = (d) => (d.assignee !== null ? fail("status", "Someone already holds this story.", { status: d.status }) : null);

/** The checks every draft mutation shares, after its guard. Reads only. */
async function openDraft(db: Reader, caller: Human, args: DraftArgs, statuses: readonly string[], rules: readonly Rule[], checkRev = true): Promise<{ failure: Failure } | { draft: any }> {
  const draft = typeof args.draftId === "string" && args.draftId !== "" ? await db.get("drafts", args.draftId as any) : null;
  if (!draft || !visible(draft, caller)) return { failure: fail("not-found", "That story is not on the desk.") };
  if (checkRev && draft.rev !== args.expectedRev) {
    return { failure: fail("stale", "This story changed since you loaded it. Reload it and try again.", { rev: draft.rev }) };
  }
  if (!statuses.includes(draft.status)) return { failure: fail("status", `This story is ${draft.status}, so that cannot be done now.`, { status: draft.status }) };
  for (const rule of rules) {
    const refused = rule(draft, caller);
    if (refused) return { failure: refused };
  }
  return { draft };
}

type Revision = { post: Post; hash: string; external: boolean; fields: string[]; linkChecks: unknown; linkOverride: unknown };

function same(a: unknown, b: unknown): boolean {
  return a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
}

/**
 * The draft's post with the patch's post fields laid over it, judged in desk
 * mode. Link checks survive for the urls that are still there; an override
 * survives only while the set of urls is unchanged. Reads only.
 */
async function revise(db: Reader, draft: any, patch: unknown, required: boolean): Promise<{ failure: Failure } | Revision> {
  let raw: Record<string, unknown> = draft.post;
  if (patch === undefined || patch === null) {
    if (required) return { failure: invalid([{ field: "patch", code: "format" }]) };
  } else if (typeof patch !== "object" || Array.isArray(patch)) {
    return { failure: invalid([{ field: "patch", code: "format" }]) };
  } else {
    raw = { ...draft.post };
    for (const key of POST_FIELDS) if (Object.prototype.hasOwnProperty.call(patch, key)) raw[key] = (patch as any)[key];
  }
  const verdict = validatePost(raw, { mode: "desk" });
  if (!verdict.ok || !verdict.post) return { failure: invalid(verdict.problems) };
  const post = verdict.post;
  if (post.id !== draft.storyId && (await idTaken(db, post.id, draft._id))) return { failure: fail("duplicate-id", "Another story already uses that id.") };
  const fields = POST_FIELDS.filter((key) => !same((post as any)[key], draft.post ? draft.post[key] : undefined));
  const urls = new Set(post.links.map((l) => l.url));
  const oldUrls = new Set(Array.isArray(draft.post?.links) ? draft.post.links.map((l: any) => l && l.url) : []);
  const sameUrls = urls.size === oldUrls.size && [...urls].every((u) => oldUrls.has(u));
  const linkChecks = sameUrls || !Array.isArray(draft.linkChecks) ? draft.linkChecks : draft.linkChecks.filter((c: any) => c && urls.has(c.url));
  return { post, hash: await contentHash(post), external: verdict.external, fields, linkChecks, linkOverride: sameUrls ? draft.linkOverride : null };
}

function revisionFields(r: Revision): Record<string, unknown> {
  return { storyId: r.post.id, post: r.post, contentHash: r.hash, external: r.external, linkChecks: r.linkChecks, linkOverride: r.linkOverride };
}

// ── desk:queue ────────────────────────────────────────────────────────────────

/**
 * A submitter's own drafts in one status, through by_submittedBy, so other
 * people's drafts never crowd theirs out of the QUEUE_PER_STATUS_MAX read.
 * That index cannot range on updatedAt: its newest QUEUE_PER_STATUS_MAX rows
 * are read, the live and spiked cut-offs applied to those, and the rest
 * ordered newest update first, as by_status orders everyone else's.
 */
async function submitterRows(db: Reader, subject: string, status: string, since: number | null): Promise<any[]> {
  const rows = await db
    .query("drafts")
    .withIndex("by_submittedBy", (q: any) => q.eq("submittedBy", subject).eq("status", status))
    .order("desc")
    .take(QUEUE_PER_STATUS_MAX);
  return rows.filter((d: any) => since === null || d.updatedAt >= since).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
}

export async function queueCore(db: Reader, caller: Caller, _args: unknown, now: number, env: DeskEnv): Promise<Result> {
  // No role, no drafts: never a refusal that would say drafts exist.
  if (!isMember(caller)) return done({ drafts: [] });
  const refused = authorize(caller, "queue.read", env);
  if (refused) return refused;
  const drafts: Record<string, unknown>[] = [];
  for (const status of STATUSES) {
    const since = status === "live" ? now - LIVE_SHOWN_MS : status === "spiked" ? now - SPIKED_SHOWN_MS : null;
    const rows = caller.role === "submitter"
      ? await submitterRows(db, caller.subject, status, since)
      : await db
        .query("drafts")
        .withIndex("by_status", (q: any) => (since === null ? q.eq("status", status) : q.eq("status", status).gte("updatedAt", since)))
        .order("desc")
        .take(QUEUE_PER_STATUS_MAX);
    for (const d of rows) {
      if (!visible(d, caller)) continue;
      drafts.push({
        draftId: d._id, storyId: d.storyId, post: d.post, status: d.status, assignee: d.assignee, rev: d.rev,
        external: d.external, source: d.source, mine: d.submittedBy === caller.subject, submittedAt: d.submittedAt,
        updatedAt: d.updatedAt, approvedBy: d.approvedBy, approvedAt: d.approvedAt, publishAfter: d.publishAfter,
        commitSha: d.commitSha, linkChecks: d.linkChecks, linkOverride: d.linkOverride, note: d.note,
        problems: validatePost(d.post, { mode: "desk" }).problems,
      });
    }
  }
  return done({ drafts });
}

// ── drafts:submit and drafts:edit ─────────────────────────────────────────────

export async function submitCore(db: Db, caller: Caller, args: { post?: unknown }, now: number, env: DeskEnv): Promise<Result> {
  const refused = guardWrite(caller, "draft.submit", env);
  if (refused) return refused;
  const human = caller as Human;
  const verdict = validatePost(args.post, { mode: "desk" });
  if (!verdict.ok || !verdict.post) return invalid(verdict.problems);
  const post = verdict.post;
  if (await idTaken(db, post.id, null)) return fail("duplicate-id", "Another story already uses that id.");
  const limited = await refuseIfLimited(db, human.subject, "draft.submit", now, "stories submitted this hour");
  if (limited) return limited;
  const assignee = await eligibleDefaultAssignee(db, env, human.subject);
  const hash = await contentHash(post);

  const draftId = await db.insert("drafts", newDraft({ post, hash, external: verdict.external, source: "desk", submittedBy: human.subject, assignee, now }));
  await recordEvent(db, { _id: draftId, storyId: post.id }, human.subject, "submit", { rev: 1, contentHash: hash, assignee }, now);
  await recordRate(db, human.subject, "draft.submit", now);
  return done({ draftId, storyId: post.id });
}

/** Edits a pending or approved draft; an approved one returns to pending with its approval cleared. */
export async function editCore(db: Db, caller: Caller, args: DraftArgs & { patch?: unknown }, now: number, env: DeskEnv): Promise<Result> {
  const refused = guardWrite(caller, "draft.edit", env);
  if (refused) return refused;
  const human = caller as Human;
  const statuses = human.role === "submitter" ? ["pending"] : ["pending", "approved"];
  const opened = await openDraft(db, human, args, statuses, [reviewerHolds]);
  if ("failure" in opened) return opened.failure;
  const { draft } = opened;
  const revision = await revise(db, draft, args.patch, true);
  if ("failure" in revision) return revision.failure;
  // Nothing changed: no write, no event, and an approval stands.
  if (revision.fields.length === 0) return done({ rev: draft.rev });
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return limited;

  const rev = draft.rev + 1;
  const back = draft.status === "approved";
  await db.patch("drafts", draft._id, { ...revisionFields(revision), humanTouched: true, ...(back ? UNAPPROVED : {}), rev, updatedAt: now });
  await recordEvent(db, { _id: draft._id, storyId: revision.post.id }, human.subject, "edit",
    { rev, fields: revision.fields, from: draft.status, to: back ? "pending" : draft.status, contentHash: revision.hash }, now);
  await recordRate(db, human.subject, "draft.write", now);
  return done({ rev });
}

// ── drafts:approve and drafts:approveMany ─────────────────────────────────────

type Approval = { draft: any; revision: Revision; took: boolean };

async function approvalChecks(db: Reader, caller: Human, args: DraftArgs, patch: unknown): Promise<{ failure: Failure } | Approval> {
  const opened = await openDraft(db, caller, args, ["pending"], [notOwnSubmission, reviewerHoldsOrFree]);
  if ("failure" in opened) return opened;
  const { draft } = opened;
  const revision = await revise(db, draft, patch, false);
  if ("failure" in revision) return revision;
  if (caller.role === "reviewer" && revision.external) {
    return { failure: fail("external-links", "A story that links outside neorgon.com needs an editor or an owner to approve it.") };
  }
  if (linksBlocked(revision.linkChecks, revision.linkOverride)) {
    return { failure: fail("links-blocked", "A link on this story is broken. Fix it, or ask an owner to override the check.") };
  }
  return { draft, revision, took: caller.role === "reviewer" && draft.assignee === null };
}

async function approvalWrite(db: Db, caller: Human, approval: Approval, now: number, settings: DeskSettings): Promise<{ rev: number; publishAfter: number }> {
  const { draft, revision, took } = approval;
  const rev = draft.rev + 1;
  const publishAfter = now + settings.publishDelayMs;
  await db.patch("drafts", draft._id, {
    ...revisionFields(revision),
    humanTouched: draft.humanTouched || revision.fields.length > 0,
    status: "approved",
    assignee: took ? caller.subject : draft.assignee,
    approvedHash: revision.hash,
    approvedBy: caller.subject,
    approvedAt: now,
    publishAfter,
    rev,
    updatedAt: now,
  });
  // Only an owner gets past notOwnSubmission with their own story (section 4.2).
  const action = draft.submittedBy === caller.subject ? "self-approve" : "approve";
  await recordEvent(db, { _id: draft._id, storyId: revision.post.id }, caller.subject, action,
    { rev, approvedHash: revision.hash, fields: revision.fields, took }, now);
  return { rev, publishAfter };
}

/** Saves the optional patch and approves in one mutation, storing approvedHash = contentHash(post). */
export async function approveCore(db: Db, caller: Caller, args: DraftArgs & { patch?: unknown }, now: number, env: DeskEnv): Promise<WithIntent> {
  const refused = guardWrite(caller, "draft.approve", env);
  if (refused) return { result: refused, intent: null };
  const human = caller as Human;
  const approval = await approvalChecks(db, human, args, args.patch);
  if ("failure" in approval) return { result: approval.failure, intent: null };
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return { result: limited, intent: null };
  const settings = await readSettings(db);

  const { rev, publishAfter } = await approvalWrite(db, human, approval, now, settings);
  await recordRate(db, human.subject, "draft.write", now);
  return { result: done({ rev, publishAfter }), intent: { kind: "publish", runAt: publishAfter } };
}

/** Each item is approved or refused on its own; a refused item writes nothing. One draft.write for the call. */
export async function approveManyCore(db: Db, caller: Caller, args: { items?: unknown }, now: number, env: DeskEnv): Promise<WithIntent> {
  const refused = guardWrite(caller, "draft.approve", env);
  if (refused) return { result: refused, intent: null };
  const human = caller as Human;
  const items = args.items;
  if (!Array.isArray(items)) return { result: invalid([{ field: "items", code: "format" }]), intent: null };
  if (items.length > APPROVE_MANY_MAX) {
    return { result: fail("too-many", `At most ${APPROVE_MANY_MAX} stories can be approved at once.`, { max: APPROVE_MANY_MAX }), intent: null };
  }
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return { result: limited, intent: null };
  const settings = await readSettings(db);

  const results: { draftId: unknown; ok: boolean; code: string | null }[] = [];
  let runAt: number | null = null;
  for (const item of items) {
    const draftArgs: DraftArgs = item !== null && typeof item === "object" ? item : {};
    const approval = await approvalChecks(db, human, draftArgs, undefined);
    if ("failure" in approval) {
      results.push({ draftId: draftArgs.draftId ?? null, ok: false, code: approval.failure.code });
      continue;
    }
    const written = await approvalWrite(db, human, approval, now, settings);
    results.push({ draftId: approval.draft._id, ok: true, code: null });
    runAt = runAt === null ? written.publishAfter : Math.min(runAt, written.publishAfter);
  }
  if (runAt !== null) await recordRate(db, human.subject, "draft.write", now);
  return { result: done({ results }), intent: runAt === null ? null : { kind: "publish", runAt } };
}

// ── The simple transitions ────────────────────────────────────────────────────

type Change = { failure: Failure } | { fields: Record<string, unknown>; detail?: Record<string, unknown> };
type Transition = { action: Action; event: string; statuses: readonly string[]; rules: readonly Rule[]; change: (db: Reader, draft: any, caller: Human) => Promise<Change> };

async function transition(db: Db, caller: Caller, args: DraftArgs, now: number, env: DeskEnv, spec: Transition): Promise<Result> {
  const refused = guardWrite(caller, spec.action, env);
  if (refused) return refused;
  const human = caller as Human;
  const opened = await openDraft(db, human, args, spec.statuses, spec.rules);
  if ("failure" in opened) return opened.failure;
  const { draft } = opened;
  const change = await spec.change(db, draft, human);
  if ("failure" in change) return change.failure;
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return limited;

  const rev = draft.rev + 1;
  await db.patch("drafts", draft._id, { ...change.fields, rev, updatedAt: now });
  const to = typeof change.fields.status === "string" ? change.fields.status : draft.status;
  await recordEvent(db, draft, human.subject, spec.event, { rev, from: draft.status, to, ...(change.detail || {}) }, now);
  await recordRate(db, human.subject, "draft.write", now);
  return done({ rev });
}

/** approved to pending, only while no publish run has claimed it. */
export function withdrawCore(db: Db, caller: Caller, args: DraftArgs, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.withdraw", event: "withdraw", statuses: ["approved"], rules: [unclaimed, reviewerOwnApproval],
    change: async () => ({ fields: { ...UNAPPROVED } }),
  });
}

/** spiked to pending. */
export function reopenCore(db: Db, caller: Caller, args: DraftArgs, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.reopen", event: "reopen", statuses: ["spiked"], rules: [],
    change: async () => ({ fields: { status: "pending", note: null } }),
  });
}

/** An unassigned pending draft becomes the caller's. */
export function takeCore(db: Db, caller: Caller, args: DraftArgs, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.take", event: "take", statuses: ["pending"], rules: [unassigned],
    change: async (_db, _draft, human) => ({ fields: { assignee: human.subject } }),
  });
}

/** An owner lets a pending draft be approved despite a blocking link check, until its urls change. */
export function overrideLinksCore(db: Db, caller: Caller, args: DraftArgs, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.overrideLinks", event: "override-links", statuses: ["pending"], rules: [],
    change: async (_db, _draft, human) => ({ fields: { linkOverride: human.subject } }),
  });
}

/** pending or approved to spiked, with an optional note; an approval is cleared. */
export function spikeCore(db: Db, caller: Caller, args: DraftArgs & { note?: unknown }, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.spike", event: "spike", statuses: ["pending", "approved"], rules: [reviewerHoldsOrFree],
    change: async () => {
      let note: string | null = null;
      if (args.note !== undefined && args.note !== null && !(typeof args.note === "string" && args.note.trim() === "")) {
        const checked = checkText("note", args.note, NOTE_MAX);
        if (checked.problems.length) return { failure: invalid(checked.problems) };
        note = checked.text;
      }
      return { fields: { ...UNAPPROVED, status: "spiked", note } };
    },
  });
}

/** Assigns a pending or approved draft to nobody, or to a reviewer, editor or owner. */
export function assignCore(db: Db, caller: Caller, args: DraftArgs & { assignee?: unknown }, now: number, env: DeskEnv): Promise<Result> {
  return transition(db, caller, args, now, env, {
    action: "draft.assign", event: "assign", statuses: ["pending", "approved"], rules: [],
    change: async (reader, draft) => {
      const assignee = args.assignee === undefined ? null : args.assignee;
      if (assignee !== null) {
        const problem = await checkAssignee(reader, assignee, env);
        if (problem) return { failure: problem };
      }
      return { fields: { assignee }, detail: { assignee: { from: draft.assignee, to: assignee } } };
    },
  });
}

/**
 * Asks for a fresh link check. The permission is draft.edit's, with spike's
 * view (a reviewer on their own or unassigned stories, a submitter on theirs).
 * It changes no draft, so it writes no event; the intent names the draft.
 */
export async function recheckLinksCore(db: Db, caller: Caller, args: { draftId?: unknown }, now: number, env: DeskEnv): Promise<WithIntent> {
  const refused = guardWrite(caller, "draft.edit", env);
  if (refused) return { result: refused, intent: null };
  const human = caller as Human;
  const opened = await openDraft(db, human, args, ["pending", "approved"], [reviewerHoldsOrFree], false);
  if ("failure" in opened) return { result: opened.failure, intent: null };
  const limited = await refuseIfLimited(db, human.subject, "draft.write", now, WRITES);
  if (limited) return { result: limited, intent: null };
  await recordRate(db, human.subject, "draft.write", now);
  return { result: done(), intent: { kind: "links", draftId: opened.draft._id } };
}
