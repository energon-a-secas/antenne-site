import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The build contract is docs/plans/2026-09-15-antenne-desk.md in the monorepo,
// section 4.1, and these tables are that listing.
//
// tests/support/fakedb.mjs parses this file for its tables, fields and indexes,
// so a core that reads an index or writes a field not declared here fails make
// validate the way it would fail on a deployment. The parser knows only
// v.string(), v.number(), v.boolean(), v.null(), v.any(), v.union and
// v.optional, so an enumeration (a role, a status, a trigger) is a string the
// cores check, an array or object is v.any() the cores check, and a document id
// kept in another table is a string.
//
// Every read goes through a declared index: fakedb has no filter(), and a
// deployment reading without one scans the table.
export default defineSchema({
  // One row per granted person. role is editor, reviewer or submitter; owners
  // come from DESK_OWNERS and are never rows.
  members: defineTable({
    subject: v.string(),
    role: v.string(),
    label: v.string(),
    email: v.union(v.string(), v.null()),
    grantedBy: v.string(),
    grantedAt: v.number(),
  }).index("by_subject", ["subject"]).index("by_role", ["role"]),

  accessRequests: defineTable({
    subject: v.string(),
    label: v.string(),
    email: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
    requestedAt: v.number(),
  }).index("by_subject", ["subject"]).index("by_requestedAt", ["requestedAt"]),

  // status: pending, approved, publishing, committed, live, spiked.
  // source: desk or machine. submittedBy: a Clerk subject, or key:<keyId>.
  // post is the normalized post; linkChecks is null or [{ url, status, blocking }].
  // by_submittedBy is how desk:queue reads a submitter's own drafts, so other
  // people's drafts never crowd theirs out of the 200 it reads per status.
  drafts: defineTable({
    storyId: v.string(),
    post: v.any(),
    status: v.string(),
    assignee: v.union(v.string(), v.null()),
    rev: v.number(),
    machineRev: v.number(),
    humanTouched: v.boolean(),
    contentHash: v.string(),
    external: v.boolean(),
    source: v.string(),
    submittedBy: v.string(),
    submittedAt: v.number(),
    updatedAt: v.number(),
    approvedHash: v.union(v.string(), v.null()),
    approvedBy: v.union(v.string(), v.null()),
    approvedAt: v.union(v.number(), v.null()),
    publishAfter: v.union(v.number(), v.null()),
    claimRun: v.union(v.string(), v.null()),
    claimedAt: v.union(v.number(), v.null()),
    commitSha: v.union(v.string(), v.null()),
    committedAt: v.union(v.number(), v.null()),
    linkOverride: v.union(v.string(), v.null()),
    linkChecks: v.any(),
    note: v.union(v.string(), v.null()),
  })
    .index("by_storyId", ["storyId"])
    .index("by_status", ["status", "updatedAt"])
    .index("by_assignee", ["assignee", "status"])
    .index("by_submittedBy", ["submittedBy", "status"])
    .index("by_claimRun", ["claimRun"]),

  // One row per change to a draft, written in the same mutation as the change.
  // detail carries ids, revs, field names and hashes, never story text.
  draftEvents: defineTable({
    draftId: v.string(),
    storyId: v.string(),
    actor: v.string(),
    action: v.string(),
    detail: v.any(),
    at: v.number(),
  }).index("by_draft", ["draftId", "at"]).index("by_at", ["at"]),

  // state: queued, dispatched, claimed, pushed, built, done, failed.
  // trigger: approve, now, retry, push, reconcile.
  publishRuns: defineTable({
    state: v.string(),
    trigger: v.string(),
    attempts: v.number(),
    followUp: v.boolean(),
    runAt: v.number(),
    dispatchedAt: v.union(v.number(), v.null()),
    claimedAt: v.union(v.number(), v.null()),
    ghRunId: v.union(v.string(), v.null()),
    runUrl: v.union(v.string(), v.null()),
    commitSha: v.union(v.string(), v.null()),
    storyIds: v.any(),
    error: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_state", ["state", "updatedAt"]),

  publishedIds: defineTable({
    storyId: v.string(),
    contentHash: v.string(),
    commitSha: v.string(),
    at: v.number(),
  }).index("by_storyId", ["storyId"]),

  // At most one row, key "desk".
  settings: defineTable({
    key: v.string(),
    defaultAssignee: v.union(v.string(), v.null()),
    publishDelayMs: v.number(),
    updatedBy: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // As vitrina: bucket is "<principal>|<limit name>".
  rateEvents: defineTable({ bucket: v.string(), at: v.number() })
    .index("by_bucket_at", ["bucket", "at"]).index("by_at", ["at"]),
});
