// Adapted from projects/vitrina-site/convex/lib/admin.ts (adminSubjects and isAdminSubject, renamed).
//
// The desk's two subject lists, DESK_OWNERS and DESK_DENY, arrive as arguments.
// Cores never read process.env, so the node tests hand in a list without
// touching the environment, and only the wrappers in convex/*.ts name the
// variables (docs/plans/2026-09-15-antenne-desk.md sections 1 and 4.2).

/** A comma separated list of Clerk subjects; blanks and surrounding space are ignored. */
export function parseSubjects(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exact match only. An unset list lists nobody, never everybody. */
export function isListed(subject: string | null | undefined, raw: string | null | undefined): boolean {
  if (!subject) return false;
  return parseSubjects(raw).includes(subject);
}
