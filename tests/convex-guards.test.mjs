// Plain node, no install. Run with: make validate
//
// Two backend guards that every behaviour test passed without (queue #134, the
// round 2 verifiers of 2026-09-22), each held here so that taking it out turns
// this file red:
//
// - REAL_TRIGGERS (convex/lib/submitCore.ts) names every trigger of a run that
//   can publish. newestRealRun reads one by_trigger range per name, so a trigger
//   left out of the list is a run nobody sees once a dry run comes after it: a
//   failed push run would stop pausing reconcile, and publish:retry would answer
//   that the last run did not fail. The triggers are listed literally below, not
//   read from the module, so dropping one from the module is noticed.
// - machinePending (the same file) counts the machine keys' pending drafts for
//   MACHINE_PENDING_MAX with a take bounded by the room still left, and stops
//   reading once the room is gone. A .collect() in its place, or a loop without
//   the early break, answers the same queue-full, so only the reads it makes can
//   tell: each by_submittedBy read is recorded here with its range and its limit.

import { readFileSync } from 'node:fs';
import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { newDraft } from '../convex/lib/draftsCore.ts';
import { MACHINE_PENDING_MAX } from '../convex/lib/limits.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import { publishRetryCore, reconcileCore, runRow } from '../convex/lib/publishCore.ts';
import { DRYRUN_TRIGGER, REAL_TRIGGERS, ingestCore, lastRunOf } from '../convex/lib/submitCore.ts';

let [failed, checks] = [0, 0];
function eq(actual, expected, what) {
  checks += 1;
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) return true;
  failed += 1;
  console.error(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
  return false;
}
async function section(title, fn) {
  const before = [failed, checks];
  await fn();
  const n = checks - before[1];
  if (failed === before[0]) console.log(`ok   ${title} (${n} checks)`);
  else console.error(`FAIL ${title}: ${failed - before[0]} of ${n} checks`);
}

const [T0, MIN] = [Date.UTC(2026, 8, 15, 12), 60000];
const [OWNER, EDITOR] = ['user_owner', 'user_editor'];
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const world = () => Object.assign(createFakeDb(), { normalizeId: (table, id) => (typeof id === 'string' && id.startsWith(`${table}:`) ? id : null) });
const POST = (slug) => ({
  id: `2026-09-15-${slug}`, date: '2026-09-15', kind: 'feature', site: 'dispatch-site', title: `Title ${slug}`, summary: 'A summary.',
  body: ['A paragraph.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'],
});
async function draft(db, slug, fields = {}) {
  const post = validatePost(POST(slug), { mode: 'desk' }).post;
  return db.insert('drafts', { ...newDraft({ post, hash: await contentHash(post), external: false, source: 'desk', submittedBy: 'user_submitter', assignee: null, now: T0 - 10 * MIN }), ...fields });
}

// ── REAL_TRIGGERS ───────────────────────────────────────────────────────────
// Every trigger section 4.1 gives a run that can publish. claimCore with runId null makes the push run
// (tests/convex-publish.test.mjs); the others come from approve, Publish now, Retry and reconcile.
const PUBLISHING_TRIGGERS = ['approve', 'now', 'retry', 'push', 'reconcile'];

await section('a failed run of every trigger that publishes, push included, still pauses reconcile behind a later dry run, and Retry follows it', async () => {
  for (const trigger of PUBLISHING_TRIGGERS) {
    const db = world();
    await db.insert('members', { subject: EDITOR, role: 'editor', label: 'editor', email: null, grantedBy: OWNER, grantedAt: T0 });
    const failedRun = await db.insert('publishRuns', runRow(trigger, T0 - 30 * MIN, T0 - 30 * MIN, { state: 'failed', error: 'attempts', attempts: 5 }));
    await db.insert('publishRuns', runRow(DRYRUN_TRIGGER, T0 - 5 * MIN, T0 - 5 * MIN, { state: 'done' }));
    await draft(db, `due-${trigger}`, { status: 'approved', approvedBy: EDITOR, approvedAt: T0 - MIN, publishAfter: T0 - MIN, updatedAt: T0 - MIN });
    const out = await reconcileCore(db, T0, ENV);
    eq([out.result.acted, out.intents, db.count('publishRuns')], [[], [], 2], `${trigger}: a due approval after a failed ${trigger} run and a dry run queues nothing`);
    eq((await lastRunOf(db, T0))?.runId, failedRun, `${trigger}: the last run /status and publish:status report is the failed ${trigger} run, not the dry run`);
    const retry = await publishRetryCore(db, await access.resolveCaller(db, EDITOR, ENV), {}, T0, ENV);
    eq([retry.result.ok, retry.result.code ?? null, retry.result.ok ? db.rows('publishRuns').at(-1).trigger : null], [true, null, 'retry'], `${trigger}: Retry is accepted after it, not refused with status`);
  }
  eq([...REAL_TRIGGERS].sort(), [...PUBLISHING_TRIGGERS].sort(), 'REAL_TRIGGERS is this list, so a trigger added there is added here too');
});

// ── machinePending's reads ──────────────────────────────────────────────────
const VECTORS = JSON.parse(readFileSync(new URL('./sign-vectors.json', import.meta.url), 'utf8')).vectors;
const keyEntry = (id) => { const v = VECTORS.find((x) => x.keyId === id); return `${id}:${v.scopes.join('+')}:${v.secret}`; };
const LOCAL = access.machineCaller('local', ['submit', 'status']);

/** db with every query recorded as { index, eqs, take, collect }, so a test can read what machinePending asked for. */
function recording(db) {
  const reads = [];
  const query = (table) => {
    const q = db.query(table);
    const entry = { table, index: null, eqs: [], take: null, collect: false };
    reads.push(entry);
    const w = {
      withIndex(name, fn) {
        entry.index = name;
        q.withIndex(name, fn && ((b) => {
          const eq0 = b.eq;
          b.eq = (field, value) => { entry.eqs.push(value); return eq0(field, value); };
          try { return fn(b); } finally { b.eq = eq0; }
        }));
        return w;
      },
      order(direction) { q.order(direction); return w; },
      filter: () => q.filter(),
      first: () => q.first(),
      unique: () => q.unique(),
      take(n) { entry.take = n; return q.take(n); },
      collect() { entry.collect = true; return q.collect(); },
    };
    return w;
  };
  return { db: { ...db, query }, reads };
}
async function seedMachine(db, keyId, n, from = 0) {
  for (let i = from; i < from + n; i += 1) {
    const post = validatePost(POST(`${keyId}-${i}`), { mode: 'desk' }).post;
    await db.insert('drafts', newDraft({ post, hash: await contentHash(post), external: false, source: 'machine', submittedBy: `key:${keyId}`, assignee: null, now: T0 - 5000 }));
  }
}
const pendingReads = (reads) => reads.filter((r) => r.table === 'drafts' && r.index === 'by_submittedBy').map((r) => [r.eqs, r.take, r.collect]);
const ingest = async (db, slug, env) => (await ingestCore(db, LOCAL, { stories: [POST(slug)] }, T0, env)).result.outcomes.map((o) => o.outcome);

await section(`machinePending reads each key's pending drafts in a take bounded by the room left of ${MACHINE_PENDING_MAX}, and stops once it is gone`, async () => {
  const env = { ...ENV, MACHINE_KEYS: [keyEntry('ci'), keyEntry('local')].join(',') };

  let raw = countWrites(world());
  await seedMachine(raw, 'ci', MACHINE_PENDING_MAX + 5);
  let rec = recording(raw);
  eq(await ingest(rec.db, 'one-more', env), ['queue-full'], `ci holds ${MACHINE_PENDING_MAX + 5}: a story from local is queue-full`);
  eq(pendingReads(rec.reads), [[['key:ci', 'pending'], MACHINE_PENDING_MAX, false]],
    `one read, of ci's pending range, take(${MACHINE_PENDING_MAX}), never collect(); local's range is never read once ci fills the room`);

  raw = countWrites(world());
  await seedMachine(raw, 'ci', 15);
  await seedMachine(raw, 'local', 10);
  rec = recording(raw);
  eq(await ingest(rec.db, 'room-left', env), ['created'], 'ci holds 15 and local 10: there is room');
  eq(pendingReads(rec.reads), [[['key:ci', 'pending'], MACHINE_PENDING_MAX, false], [['key:local', 'pending'], MACHINE_PENDING_MAX - 15, false]],
    `ci's range in take(${MACHINE_PENDING_MAX}), then local's in take(${MACHINE_PENDING_MAX - 15}), the room ci left`);

  raw = countWrites(world());
  await seedMachine(raw, 'local', 3);
  rec = recording(raw);
  eq(await ingest(rec.db, 'unset', ENV), ['created'], 'MACHINE_KEYS unset: only the caller counts');
  eq(pendingReads(rec.reads), [[['key:local', 'pending'], MACHINE_PENDING_MAX, false]], "with MACHINE_KEYS unset, one read: the caller's own range");

  const seen = recording(world());
  await seen.db.query('drafts').withIndex('by_submittedBy', (q) => q.eq('submittedBy', 'key:x').eq('status', 'pending')).collect();
  eq(pendingReads(seen.reads), [[['key:x', 'pending'], null, true]], 'the recorder sees a collect() and its range, so a .collect() in machinePending would show');
});

console.log(failed ? `\nconvex guards: ${failed} of ${checks} checks failed` : `\nconvex guards: all ${checks} checks pass`);
process.exit(failed ? 1 : 0);
