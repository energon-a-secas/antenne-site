// Plain node, no install. Run with: make validate
//
// The publish bridge (docs/plans/2026-09-15-antenne-desk.md sections 4.1, 4.3, 5 and 6.1) over
// tests/support/fakedb.mjs: the run state machine and its one active run, followUp, the /publish/*
// cores and every refusal they make before a write, verification, reconcile's branches, the sweep,
// the fetch-dependent parts with a fake fetch, and the route table. The wrappers in convex/*.ts,
// wired end to end, are in tests/convex-publish-wired.test.mjs.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { approveCore, newDraft } from '../convex/lib/draftsCore.ts';
import * as L from '../convex/lib/limits.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import * as core from '../convex/lib/publishCore.ts';
import * as net from '../convex/lib/publishFetch.ts';
import * as mach from '../convex/lib/publishMachine.ts';
import * as rec from '../convex/lib/publishRecord.ts';
import { ROUTES, machineRequest } from '../convex/lib/routes.ts';

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
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const [T0, MIN, SHA, MARK] = [Date.UTC(2026, 8, 15, 12), 60000, 'a'.repeat(40), 'SECRET-TEXT'];
const [OWNER, EDITOR, REVIEWER, SUBMITTER, STRANGER] = ['user_owner', 'user_editor', 'user_reviewer', 'user_submitter', 'user_stranger'];
const ENV = Object.freeze({ DESK_OWNERS: OWNER, GITHUB_DISPATCH_TOKEN_EXPIRES: '2027-01-31' });
const FROZEN = Object.freeze({ ...ENV, DESK_FROZEN: '1' });
const GH = access.machineCaller('gh', ['publish']);
const URL42 = 'https://github.com/energon-a-secas/antenne-site/actions/runs/42/attempts/1';

// Convex's db.normalizeId, for the fake's "table:n" ids: the cores take run and draft ids as text.
const world = () => Object.assign(createFakeDb(), { normalizeId: (table, id) => (typeof id === 'string' && id.startsWith(`${table}:`) ? id : null) });
async function people(db) {
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  return db;
}
const POST = (slug, over = {}) => ({
  id: `2026-09-15-${slug}`, date: '2026-09-15', kind: 'feature', site: 'dispatch-site', title: `Title ${slug} ${MARK}`, summary: `A summary ${MARK}.`,
  body: [`A paragraph ${MARK}.`], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'], ...over,
});
const normal = (slug, over) => validatePost(POST(slug, over), { mode: 'desk' }).post;
async function draft(db, slug, fields = {}, over = {}) {
  const [post, status] = [normal(slug, over), fields.status ?? 'pending'];
  const hash = await contentHash(post);
  return db.insert('drafts', { ...newDraft({ post, hash, external: false, source: 'desk', submittedBy: SUBMITTER, assignee: null, now: T0 - 10 * MIN }), approvedHash: status === 'pending' ? null : hash, ...fields });
}
const due = (at = T0 - MIN) => ({ status: 'approved', approvedBy: EDITOR, approvedAt: at, publishAfter: at, updatedAt: at });
const run = (db, state, extra = {}) => db.insert('publishRuns', core.runRow('approve', T0 - 30 * MIN, T0 - 30 * MIN, { state, ...extra }));
const get = (db, id) => db.rows(id.split(':')[0]).find((r) => r._id === id);
const res = (out) => (out && 'result' in out ? out.result : out);
async function refused(raw, fn, code, what) {
  const [db, snap] = [countWrites(raw), () => JSON.stringify(Object.keys(raw.schema).map((t) => raw.rows(t)))];
  const [before, out] = [snap(), res(await fn(db))];
  eq([out.ok, out.code, db.writes(), snap() === before], [false, code, 0, true], `${what}: ${code}, nothing written`);
  return out;
}

// ── The run state machine ───────────────────────────────────────────────────
await section('queueRun: one active run; a trigger during it sets followUp; a queued run moves to an earlier runAt', async () => {
  const db = world();
  const a = await core.queueRun(db, 'approve', T0 + 5 * MIN, T0);
  eq([a.intent, get(db, a.runId).state, get(db, a.runId).trigger, get(db, a.runId).followUp], [{ kind: 'dispatch', runId: a.runId, runAt: T0 + 5 * MIN }, 'queued', 'approve', false], 'no active run: a queued run, dispatched at runAt');
  const b = await core.queueRun(db, 'approve', T0 + 6 * MIN, T0 + 1);
  eq([b.runId, b.intent, get(db, a.runId).followUp, get(db, a.runId).runAt, db.count('publishRuns')], [a.runId, null, true, T0 + 5 * MIN, 1], 'a later trigger reuses it with followUp and keeps its runAt');
  const c = await core.queueRun(db, 'now', T0 + 2, T0 + 2);
  eq([c.runId, c.intent, get(db, a.runId).runAt], [a.runId, { kind: 'dispatch', runId: a.runId, runAt: T0 + 2 }, T0 + 2], 'Publish now pulls a queued run earlier and dispatches it then');
  for (const state of ['dispatched', 'claimed', 'pushed', 'built']) {
    await db.patch(a.runId, { state, followUp: false });
    const d = await core.queueRun(db, 'now', T0 + 3, T0 + 3);
    eq([d.runId, d.intent, get(db, a.runId).followUp, db.count('publishRuns')], [a.runId, null, true, 1], `during a ${state} run: no second run, and followUp`);
  }
  for (const state of ['done', 'failed']) eq([await db.patch(a.runId, { state }), await core.activeRun(db)], [undefined, null], `a ${state} run is not active`);
  const e = await core.queueRun(db, 'retry', T0 + 4, T0 + 4);
  eq([e.runId !== a.runId, get(db, e.runId).trigger, db.count('publishRuns')], [true, 'retry', 2], 'with none active, the next trigger creates a run');
  eq([...core.RUN_STATES], ['queued', 'dispatched', 'claimed', 'pushed', 'built', 'done', 'failed'], 'the run states of section 4.1');
});

// ── /publish/claim ──────────────────────────────────────────────────────────
await section('claim: at most CLAIM_MAX, only approvals whose publishAfter has come, stale claims first, fresh claims left', async () => {
  const db = world();
  for (let i = 0; i < L.CLAIM_MAX + 2; i++) await draft(db, `due-${String(i).padStart(2, '0')}`, due(T0 - 60 * MIN + i));
  const later = await draft(db, 'later', { ...due(T0 - MIN), publishAfter: T0 + MIN });
  await draft(db, 'stale', { ...due(T0 - 90 * MIN), status: 'publishing', claimRun: 'publishRuns:999', claimedAt: T0 - L.CLAIM_STALE_MS - 1 });
  const fresh = await draft(db, 'fresh', { ...due(T0 - 90 * MIN), status: 'publishing', claimRun: 'publishRuns:998', claimedAt: T0 - L.CLAIM_STALE_MS });
  const { runId } = await core.queueRun(db, 'approve', T0, T0 - 5);
  const out = await mach.claimCore(db, GH, { runId, ghRunId: '42', runUrl: URL42 }, T0, ENV);
  const ids = out.result.stories.map((s) => s.storyId);
  eq([out.result.ok, out.result.runId, ids.length, ids[0], ids[1]], [true, runId, L.CLAIM_MAX, '2026-09-15-stale', '2026-09-15-due-00'], `${L.CLAIM_MAX} taken: the stale claim first, then the oldest approvals`);
  eq([ids.includes(get(db, later).storyId), ids.includes(get(db, fresh).storyId), get(db, later).status, get(db, fresh).claimRun], [false, false, 'approved', 'publishRuns:998'], 'an approval not yet due and a claim not yet stale are left alone');
  const first = get(db, db.rows('drafts')[0]._id);
  eq(out.result.stories[1], { storyId: first.storyId, post: first.post, approvedHash: first.approvedHash }, 'each story carries its post and its approvedHash');
  eq([first.status, first.claimRun, first.claimedAt, first.rev], ['publishing', runId, T0, 2], 'claimed drafts are publishing, with claimRun, claimedAt and a new rev');
  const r = get(db, runId);
  eq([r.state, r.ghRunId, r.runUrl, r.claimedAt, r.storyIds.length], ['claimed', '42', URL42, T0, L.CLAIM_MAX], 'the run is claimed, with the GitHub run and the story ids');
  const ev = db.rows('draftEvents');
  eq([ev.length, ev.every((e) => e.actor === 'key:gh' && e.action === 'claim'), JSON.stringify(ev).includes(MARK)], [L.CLAIM_MAX, true, false], 'one claim event per draft, by key:gh, with no story text');
  await refused(db, (d) => mach.claimCore(d, GH, { runId, ghRunId: null, runUrl: null }, T0 + 1, ENV), 'status', 'claiming a run already claimed');
});

await section('claim with runId null: a push run only when something is due and no run is active; during one it sets followUp', async () => {
  const db = world();
  let out = await mach.claimCore(db, GH, { runId: null }, T0, ENV);
  eq([out.result, db.count('publishRuns'), db.count('rateEvents')], [{ ok: true, runId: null, stories: [] }, 0, 1], 'nothing due: nothing to publish, no run, one rate row');
  const a = await draft(db, 'a', due());
  out = await mach.claimCore(db, GH, { runId: null, ghRunId: '7', runUrl: null }, T0, ENV);
  const pushRun = get(db, out.result.runId);
  eq([out.result.stories.length, pushRun.trigger, pushRun.state, pushRun.ghRunId, get(db, a).claimRun], [1, 'push', 'claimed', '7', pushRun._id], 'one due: a run with trigger push, claimed');
  const b = await draft(db, 'b', due());
  out = await mach.claimCore(db, GH, { runId: null }, T0 + 1, ENV);
  eq([out.result, get(db, pushRun._id).followUp, get(db, b).status, db.count('publishRuns')], [{ ok: true, runId: null, stories: [] }, true, 'approved', 1], 'during an active run: nothing taken, followUp set');
  const empty = world();
  const q = await run(empty, 'dispatched', { followUp: true });
  await draft(empty, 'soon', { ...due(), publishAfter: T0 + 3 * MIN });
  out = await mach.claimCore(empty, GH, { runId: q }, T0, ENV);
  const next = empty.rows('publishRuns')[1];
  eq([out.result.stories, get(empty, q).state, next.state, next.trigger, out.intents], [[], 'done', 'queued', 'reconcile', [{ kind: 'dispatch', runId: next._id, runAt: T0 + 3 * MIN }]], 'a named run with nothing due is done, and its follow-up is queued for the next approval');
});

await section('claim refusals write nothing: frozen, a key without publish, a person, a bad id or url, the 121st call', async () => {
  const db = await people(world());
  const q = await run(db, 'queued');
  await draft(db, 'a', due());
  const args = { runId: q, ghRunId: '1', runUrl: URL42 };
  await refused(db, (d) => mach.claimCore(d, GH, args, T0, FROZEN), 'frozen', 'DESK_FROZEN=1');
  await refused(db, (d) => mach.claimCore(d, access.machineCaller('local', ['submit', 'status']), args, T0, ENV), 'forbidden', 'the submit and status key');
  await refused(db, async (d) => mach.claimCore(d, await access.resolveCaller(d, OWNER, ENV), args, T0, ENV), 'forbidden', 'an owner, who is a person');
  await refused(db, (d) => mach.claimCore(d, GH, { ...args, runId: 'publishRuns:404' }, T0, ENV), 'not-found', 'an unknown run');
  await refused(db, (d) => mach.claimCore(d, GH, { ...args, runId: 'drafts:1' }, T0, ENV), 'not-found', 'another table\'s id');
  for (const [what, over] of [['a url off GitHub', { runUrl: 'https://evil.example/actions/runs/1' }], ['a run id that is not digits', { ghRunId: '4x' }], ['runId a number', { runId: 5 }]]) await refused(db, (d) => mach.claimCore(d, GH, { ...args, ...over }, T0, ENV), 'invalid', what);
  for (let i = 0; i < 120; i++) await db.insert('rateEvents', { bucket: 'key:gh|machine.publish', at: T0 - 1000 });
  await refused(db, (d) => mach.claimCore(d, GH, args, T0, ENV), 'rate-limited', `the ${L.LIMITS['machine.publish'].max + 1}st publish call in an hour`);
});

// ── conflict, pushed, built, release ────────────────────────────────────────
async function claimedWorld(n = 2) {
  const [db, ids] = [world(), []];
  for (let i = 0; i < n; i++) ids.push(await draft(db, `s${i}`, due()));
  const { runId } = await core.queueRun(db, 'approve', T0, T0 - 5);
  await mach.claimCore(db, GH, { runId }, T0, ENV);
  return { db, ids, runId };
}
await section('conflict: back to pending with note conflict, approval cleared, rev bumped; only this claimed run\'s drafts', async () => {
  const { db, ids: [a, b], runId } = await claimedWorld();
  const out = await mach.conflictCore(db, GH, { runId, storyIds: [get(db, a).storyId, '2026-09-15-unknown'] }, T0 + 1, ENV);
  const d = get(db, a);
  eq([out.result, d.status, d.note, d.approvedHash, d.approvedBy, d.approvedAt, d.publishAfter, d.claimRun, d.claimedAt, d.rev], [{ ok: true }, 'pending', 'conflict', null, null, null, null, null, null, 3], 'the story is pending, noted, with no approval and no claim');
  eq([get(db, b).status, get(db, runId).storyIds, db.rows('draftEvents').at(-1).action], ['publishing', [get(db, b).storyId], 'conflict'], 'the other story stays claimed, the run keeps only it');
  const ok = await approveCore(await people(db), await access.resolveCaller(db, EDITOR, ENV), { draftId: a, expectedRev: 2 }, T0 + 2, ENV);
  eq(ok.result.code, 'stale', 'an approve holding the rev from before the conflict is stale');
  await refused(db, (x) => mach.conflictCore(x, GH, { runId, storyIds: Array(L.CLAIM_MAX + 1).fill('2026-09-15-s1') }, T0, ENV), 'invalid', `${L.CLAIM_MAX + 1} ids`);
  await refused(db, (x) => mach.conflictCore(x, GH, { runId, storyIds: ['Not An Id'] }, T0, ENV), 'invalid', 'an id that is not one');
  await db.patch(runId, { state: 'pushed', commitSha: SHA });
  await refused(db, (x) => mach.conflictCore(x, GH, { runId, storyIds: [get(db, b).storyId] }, T0, ENV), 'status', 'a conflict after the push');
});

await section('pushed: only 40 lowercase hex; the run is pushed and verifyCommit is asked for', async () => {
  const { db, runId } = await claimedWorld(1);
  for (const [what, sha] of [['uppercase', 'A'.repeat(40)], ['39 characters', 'a'.repeat(39)], ['41 characters', 'a'.repeat(41)], ['not hex', 'g'.repeat(40)], ['a number', 7], ['a padded sha', ` ${SHA}`]]) await refused(db, (x) => mach.pushedCore(x, GH, { runId, sha, noChange: false }, T0, ENV), 'invalid', `a sha that is ${what}`);
  await refused(db, (x) => mach.pushedCore(x, GH, { runId, sha: SHA }, T0, ENV), 'invalid', 'noChange missing');
  const out = await mach.pushedCore(db, GH, { runId, sha: SHA, noChange: false }, T0 + 1, ENV);
  eq([out.result.ok, get(db, runId).state, get(db, runId).commitSha, out.intents], [true, 'pushed', SHA, [{ kind: 'verify', runId, sha: SHA }]], 'pushed, with the sha, and a verification scheduled');
  eq((await mach.pushedCore(db, GH, { runId, sha: SHA, noChange: false }, T0 + 2, ENV)).intents.length, 1, 'the same report again is answered again');
  await refused(db, (x) => mach.pushedCore(x, GH, { runId, sha: 'b'.repeat(40), noChange: true }, T0, ENV), 'status', 'another sha for a pushed run');
});

await section('built and verification: done only once every claimed story is committed at the sha, then the follow-up is queued', async () => {
  const { db, ids: [a, b], runId } = await claimedWorld();
  await db.patch(runId, { followUp: true });
  await mach.pushedCore(db, GH, { runId, sha: SHA, noChange: false }, T0 + 1, ENV);
  await refused(db, (x) => mach.builtCore(x, GH, { runId, sha: SHA, pagesStatus: 'errored' }, T0, ENV), 'invalid', 'a Pages status other than built');
  let out = await mach.builtCore(db, GH, { runId, sha: SHA, pagesStatus: 'built' }, T0 + 2, ENV);
  eq([get(db, runId).state, out.intents], ['built', [{ kind: 'verify', runId, sha: SHA }]], 'built while stories are still publishing, and verification asked for');
  await refused(db, (x) => mach.pushedCore(x, GH, { runId, sha: SHA, noChange: false }, T0, ENV), 'status', 'a push report once Pages built');
  const [ha, hb] = [get(db, a).approvedHash, get(db, b).approvedHash];
  const other = { storyId: '2026-09-01-older', contentHash: 'c'.repeat(64) };
  out = await rec.recordCommitCore(db, { runId, sha: SHA, stories: [{ storyId: get(db, a).storyId, contentHash: ha }, { storyId: get(db, b).storyId, contentHash: 'd'.repeat(64) }, other], complete: true }, T0 + 3, ENV);
  eq([get(db, a).status, get(db, a).commitSha, get(db, a).committedAt, get(db, b).status, get(db, runId).state], ['committed', SHA, T0 + 3, 'publishing', 'built'], 'a story whose hash matches approvedHash is committed; one that differs is not, so the run is not done');
  eq(db.rows('publishedIds').map((r) => r.storyId), [get(db, a).storyId, get(db, b).storyId, other.storyId], 'publishedIds resynced from the file');
  out = await rec.recordCommitCore(db, { runId, sha: SHA, stories: [{ storyId: get(db, a).storyId, contentHash: ha }, { storyId: get(db, b).storyId, contentHash: hb }], complete: true }, T0 + 4, ENV);
  const next = db.rows('publishRuns')[1];
  eq([get(db, b).status, get(db, runId).state, get(db, runId).followUp, next.state, out.intents], ['committed', 'done', false, 'queued', [{ kind: 'dispatch', runId: next._id, runAt: T0 + 4 }]], 'the last story committed: done, and the follow-up queued');
  eq([db.rows('publishedIds').map((r) => r.storyId).includes(other.storyId), db.rows('publishedIds').find((r) => r.storyId === get(db, b).storyId).contentHash], [false, hb], 'a complete read removes ids the file dropped and updates changed hashes');
  eq(res(await rec.recordCommitCore(db, { runId, sha: 'b'.repeat(40), stories: [], complete: true }, T0, ENV)), { ok: true, ignored: true }, 'a verification for another sha is ignored');
  const v2 = await claimedWorld(1);
  await mach.pushedCore(v2.db, GH, { runId: v2.runId, sha: SHA, noChange: true }, T0 + 1, ENV);
  await rec.recordCommitCore(v2.db, { runId: v2.runId, sha: SHA, error: '404' }, T0 + 2, ENV);
  eq(get(v2.db, v2.runId).error, 'verify 404', 'a read that failed is stored as a short code');
  await v2.db.insert('publishedIds', { storyId: '2026-09-01-kept', contentHash: 'c'.repeat(64), commitSha: SHA, at: T0 });
  await rec.recordCommitCore(v2.db, { runId: v2.runId, sha: SHA, stories: [{ storyId: get(v2.db, v2.ids[0]).storyId, contentHash: get(v2.db, v2.ids[0]).approvedHash }], complete: false }, T0 + 3, ENV);
  eq([get(v2.db, v2.ids[0]).status, get(v2.db, v2.runId).state, v2.db.count('publishedIds')], ['committed', 'pushed', 2], 'verified before Pages built: committed, the run waits for built, and a partial read removes nothing');
  out = await mach.builtCore(v2.db, GH, { runId: v2.runId, sha: SHA, pagesStatus: 'built' }, T0 + 4, ENV);
  eq([get(v2.db, v2.runId).state, get(v2.db, v2.runId).error, out.intents], ['done', null, []], 'then built finds every story committed: done');
});

await section('release: publishing back to approved, never a committed draft, never after a push; dry-run is done, others retry', async () => {
  const { db, ids: [a, b], runId } = await claimedWorld();
  await db.patch(b, { status: 'committed', commitSha: SHA });
  const out = await mach.releaseCore(db, GH, { runId, reason: 'build' }, T0 + 1, ENV);
  eq([out.result, get(db, a).status, get(db, a).claimRun, get(db, a).publishAfter, get(db, b).status, get(db, b).claimRun], [{ ok: true, released: 1 }, 'approved', null, T0 - MIN, 'committed', runId], 'the publishing draft is approved and unclaimed; the committed one is untouched');
  eq([get(db, runId).state, get(db, runId).attempts, get(db, runId).error, out.intents], ['queued', 1, 'released build', []], 'the run spends an attempt and is queued for reconcile');
  const dry = await claimedWorld(1);
  eq([res(await mach.releaseCore(dry.db, GH, { runId: dry.runId, reason: mach.DRY_RUN }, T0 + 1, ENV)).released, get(dry.db, dry.runId).state, get(dry.db, dry.runId).attempts, get(dry.db, dry.ids[0]).status], [1, 'done', 0, 'approved'], 'a dry run releases and is done');
  const last = await claimedWorld(1);
  await last.db.patch(last.runId, { attempts: L.RUN_MAX_ATTEMPTS - 1 });
  await mach.releaseCore(last.db, GH, { runId: last.runId, reason: 'push' }, T0 + 1, ENV);
  eq([get(last.db, last.runId).state, get(last.db, last.runId).attempts], ['failed', L.RUN_MAX_ATTEMPTS], `the ${L.RUN_MAX_ATTEMPTS}th attempt fails the run`);
  const late = await claimedWorld(1);
  await mach.pushedCore(late.db, GH, { runId: late.runId, sha: SHA, noChange: false }, T0 + 1, ENV);
  await refused(late.db, (x) => mach.releaseCore(x, GH, { runId: late.runId, reason: 'pages' }, T0 + 2, ENV), 'status', 'a release after the push');
  await refused(late.db, (x) => mach.releaseCore(x, GH, { runId: late.runId, reason: 'Not a word' }, T0 + 2, ENV), 'invalid', 'a reason that is not a word');
});

// ── reconcile and sweep ─────────────────────────────────────────────────────
await section('reconcile: every branch of section 6.1', async () => {
  const at = (db, state, extra = {}) => run(db, state, extra);
  const go = async (db, now = T0, env = ENV) => core.reconcileCore(db, now, env);
  let db = world();
  let q = await at(db, 'queued', { runAt: T0 + 1 });
  eq((await go(db)).intents, [], 'a queued run before its runAt waits');
  eq((await go(db, T0 + 1)).intents, [{ kind: 'dispatch', runId: q, runAt: T0 + 1 }], 'past its runAt it is dispatched');
  q = await at(db = world(), 'dispatched', { dispatchedAt: T0 - L.DISPATCH_STALE_MS });
  eq((await go(db)).intents, [], `dispatched ${L.DISPATCH_STALE_MS} ms ago is not yet stale`);
  let out = await go(db, T0 + 1);
  eq([get(db, q).state, get(db, q).attempts, get(db, q).error, out.intents], ['queued', 1, 'dispatch stale', [{ kind: 'dispatch', runId: q, runAt: T0 + 1 }]], 'a stale dispatch is sent again, spending an attempt');
  q = await at(db = world(), 'claimed', { claimedAt: T0 - L.CLAIM_STALE_MS - 1 });
  const held = await draft(db, 'held', { ...due(), status: 'publishing', claimRun: q, claimedAt: T0 - L.CLAIM_STALE_MS - 1 });
  const kept = await draft(db, 'kept', { ...due(), status: 'committed', claimRun: q });
  out = await go(db);
  eq([get(db, held).status, get(db, kept).status, get(db, q).state, get(db, q).error, out.intents], ['approved', 'committed', 'queued', 'claim stale', [{ kind: 'dispatch', runId: q, runAt: T0 }]], 'a stale claim is released (never a committed draft) and requeued');
  q = await at(db = world(), 'pushed', { commitSha: SHA, updatedAt: T0 - MIN });
  eq([(await go(db)).intents, get(db, q).attempts], [[{ kind: 'verify', runId: q, sha: SHA }], 0], 'a pushed run gets verifyCommit again; recent, it spends no attempt');
  await db.patch(q, { updatedAt: T0 - core.RECONCILE_EVERY_MS, attempts: L.RUN_MAX_ATTEMPTS - 1 });
  const pub = await draft(db, 'pub', { ...due(), status: 'publishing', claimRun: q, claimedAt: T0 - 60 * MIN });
  out = await go(db);
  eq([get(db, q).state, get(db, q).error, get(db, pub).status], ['failed', 'verify stale', 'publishing'], 'idle through its last attempt it fails, and after the push nothing is released');
  q = await at(db = world(), 'pushed', { commitSha: SHA, updatedAt: T0 - core.RECONCILE_EVERY_MS, attempts: L.RUN_MAX_ATTEMPTS - 1 });
  await draft(db, 'verified', { ...due(), status: 'committed', claimRun: q });
  await go(db);
  eq([get(db, q).state, get(db, q).error], ['failed', 'built stale'], 'every story verified but no built report: failed as built stale');
  q = await at(db = world(), 'built', { commitSha: SHA });
  await draft(db, 'done', { ...due(), status: 'live', claimRun: q });
  await go(db);
  eq(get(db, q).state, 'done', 'a built run whose stories are all committed or live is done');
  q = await at(db = world(), 'queued', { attempts: L.RUN_MAX_ATTEMPTS, runAt: T0 - 1 });
  eq([(await go(db)).intents, get(db, q).state], [[], 'failed'], `a run at ${L.RUN_MAX_ATTEMPTS} attempts is failed, not dispatched`);
  db = world();
  await draft(db, 'soon', { ...due(), publishAfter: T0 + 1 });
  eq([(await go(db)).intents, db.count('publishRuns')], [[], 0], 'no active run and nothing due: nothing queued');
  out = await go(db, T0 + 1);
  const made = db.rows('publishRuns')[0];
  eq([made.trigger, made.state, out.intents], ['reconcile', 'queued', [{ kind: 'dispatch', runId: made._id, runAt: T0 + 1 }]], 'an approval due with nothing active queues a run');
  await db.patch(made._id, { state: 'failed' });
  eq([(await go(db, T0 + 2)).intents, db.count('publishRuns')], [[], 1], 'after a failed run nothing is queued by itself: Retry is the way on');
  q = await at(db = world(), 'done', { followUp: true });
  await draft(db, 'wait', { ...due(), publishAfter: T0 + 4 * MIN });
  out = await go(db);
  eq([get(db, q).followUp, db.rows('publishRuns')[1]?.trigger, out.intents.map((i) => i.runAt)], [false, 'reconcile', [T0 + 4 * MIN]], 'a finished run still owed its follow-up gets it, at the next approval');
  await refused(db, (x) => core.reconcileCore(x, T0, FROZEN), 'frozen', 'reconcile while frozen');
});

await section('sweep: aged rows go, recent rows and every draftEvent stay; a full batch asks for another pass', async () => {
  const db = world();
  const D = 24 * 60 * MIN;
  for (const at of [T0 - 31 * D - 1, T0 - 31 * D + 1]) await db.insert('rateEvents', { bucket: 'x|draft.write', at });
  for (const [subject, requestedAt] of [['user_old', T0 - 30 * D - 1], ['user_new', T0 - D]]) await db.insert('accessRequests', { subject, label: 'x', email: null, note: null, requestedAt });
  for (const [slug, status, updatedAt] of [['old-spike', 'spiked', T0 - 90 * D - 1], ['new-spike', 'spiked', T0 - D], ['old-live', 'live', T0 - 400 * D]]) await draft(db, slug, { status, updatedAt });
  for (const [state, updatedAt] of [['done', T0 - 30 * D - 1], ['failed', T0 - 30 * D - 1], ['queued', T0 - 300 * D]]) await run(db, state, { updatedAt });
  await db.insert('draftEvents', { draftId: 'drafts:1', storyId: 's', actor: 'a', action: 'spike', detail: {}, at: T0 - 999 * D });
  const out = await core.sweepCore(db, T0, ENV);
  eq([out.result.deleted, out.more], [{ rateEvents: 1, accessRequests: 1, drafts: 1, publishRuns: 2 }, false], 'one of each aged kind, both finished runs');
  eq([db.count('rateEvents'), db.rows('accessRequests')[0].subject, db.rows('drafts').map((d) => d.storyId), db.rows('publishRuns')[0].state, db.count('draftEvents')], [1, 'user_new', ['2026-09-15-new-spike', '2026-09-15-old-live'], 'queued', 1], 'what is recent, live, active or an event stays');
  for (let i = 0; i < core.SWEEP_BATCH + 1; i++) await db.insert('rateEvents', { bucket: 'y|draft.write', at: T0 - 40 * D });
  eq([(await core.sweepCore(db, T0, ENV)).more, db.count('rateEvents')], [true, 2], `${core.SWEEP_BATCH} per pass, and more says so`);
  await refused(db, (x) => core.sweepCore(x, T0, FROZEN), 'frozen', 'sweep while frozen');
});

// ── publish:status, publish:now, publish:retry ──────────────────────────────
await section('publish:now and publish:retry: owner and editor; frozen refuses both; retry only after a failed run', async () => {
  const db = await people(world());
  const as = (s) => access.resolveCaller(db, s, ENV);
  const codes = [];
  for (const who of [REVIEWER, SUBMITTER, STRANGER, null]) codes.push(res(await mach.claimCore(db, await as(who), {}, T0, ENV)).code, res(await core.publishNowCore(db, await as(who), {}, T0, ENV)).code);
  eq(codes, ['forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden', 'not-member', 'forbidden', 'not-signed-in'], 'a reviewer, a submitter, a stranger and nobody cannot publish');
  const now = await core.publishNowCore(db, await as(EDITOR), {}, T0, ENV);
  const r = db.rows('publishRuns')[0];
  eq([now.result, r.trigger, now.intents], [{ ok: true, runId: r._id }, 'now', [{ kind: 'dispatch', runId: r._id, runAt: T0 }]], 'an editor: a run dispatched now');
  eq([res(await core.publishNowCore(db, await as(OWNER), {}, T0 + 1, ENV)).runId, get(db, r._id).followUp, db.count('publishRuns')], [r._id, true, 1], 'an owner during it: the same run, with followUp');
  await refused(db, async (x) => core.publishNowCore(x, await as(OWNER), {}, T0, FROZEN), 'frozen', 'publish:now while frozen');
  await refused(db, async (x) => core.publishRetryCore(x, await as(OWNER), {}, T0, FROZEN), 'frozen', 'publish:retry while frozen');
  await refused(db, async (x) => core.publishRetryCore(x, await as(OWNER), {}, T0, ENV), 'status', 'retry while the last run is not failed');
  await db.patch(r._id, { state: 'failed' });
  const retry = await core.publishRetryCore(db, await as(EDITOR), {}, T0 + 2, ENV);
  eq([get(db, retry.result.runId).trigger, retry.intents.length, db.count('publishRuns')], ['retry', 1, 2], 'after a failure, retry queues a new run now');
});

await section('publish:status: last run, counts, token expiry and warning for reviewers up; empty for no role; reads while frozen', async () => {
  const db = await people(world());
  for (const [slug, status] of [['a', 'approved'], ['b', 'approved'], ['c', 'publishing'], ['d', 'committed'], ['e', 'live'], ['f', 'pending']]) await draft(db, slug, { status, updatedAt: T0 - MIN });
  await draft(db, 'old-live', { status: 'live', updatedAt: T0 - L.LIVE_SHOWN_MS - 1 });
  const r = await run(db, 'failed', { error: 'dispatch 401', runUrl: URL42, storyIds: ['x'] });
  const as = (s) => access.resolveCaller(db, s, ENV);
  const out = await core.publishStatusCore(db, await as(REVIEWER), {}, T0, FROZEN);
  eq([out.counts, out.tokenExpires, out.tokenWarning, out.lastRun.runId, out.lastRun.state, out.lastRun.error, out.lastRun.stories], [{ approved: 2, publishing: 1, committed: 1, live: 1 }, '2027-01-31', false, r, 'failed', 'dispatch 401', 1], 'a reviewer, even while frozen');
  eq(JSON.stringify(out).includes(MARK), false, 'never a title or a body');
  eq([core.tokenWarningOf('2026-10-15', T0), core.tokenWarningOf('2026-10-16', T0), core.tokenWarningOf('2026-01-01', T0), core.tokenWarningOf(null, T0)], [true, false, true, false], 'the warning: expiry within 30 days, or past; none when unknown');
  eq([res(await core.publishStatusCore(db, await as(SUBMITTER), {}, T0, ENV)).code, await core.publishStatusCore(db, await as(STRANGER), {}, T0, ENV)], ['forbidden', { ok: true, lastRun: null, counts: null, tokenExpires: null, tokenWarning: false }], 'a submitter is refused; no role gets empty data');
});

// ── The network, with a fake fetch ──────────────────────────────────────────
const TOKEN = 'dispatch-token-never-stored-5f1e9c';
const reply = (status, body = null) => ({ status, json: async () => { if (body === null) throw new SyntaxError('no body'); return body; }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
await section('dispatchRequest: the request section 6.1 names; 200 or 204 dispatched; failures are words, never the token', async () => {
  const calls = [];
  const fake = (answer) => async (url, init) => { calls.push({ url, init }); return typeof answer === 'function' ? answer(init) : answer; };
  eq(await net.dispatchRequest(fake(reply(204)), TOKEN, 'publishRuns:3'), { kind: 'ok', status: 204, ghRunId: null, runUrl: null }, '204: dispatched');
  const { url, init } = calls[0];
  eq([url, init.method, init.headers, JSON.parse(init.body), init.signal instanceof AbortSignal], [net.DISPATCH_URL, 'POST', { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'antenne-desk', 'Content-Type': 'application/json' }, { ref: 'main', inputs: { run_id: 'publishRuns:3' } }, true], 'POST to the publish.yml dispatch URL with the four headers and an abort signal');
  eq(net.DISPATCH_URL, 'https://api.github.com/repos/energon-a-secas/antenne-site/actions/workflows/publish.yml/dispatches', 'the URL, literally');
  eq(await net.dispatchRequest(fake(reply(200, { workflow_run_id: 99, html_url: 'https://github.com/energon-a-secas/antenne-site/actions/runs/99' })), TOKEN, 'r'), { kind: 'ok', status: 200, ghRunId: '99', runUrl: 'https://github.com/energon-a-secas/antenne-site/actions/runs/99' }, '200: the run id and page recorded');
  eq(await net.dispatchRequest(fake(reply(200, { html_url: 'javascript:alert(1)' })), TOKEN, 'r'), { kind: 'ok', status: 200, ghRunId: null, runUrl: null }, 'a page that is not a GitHub run page is dropped');
  eq(await net.dispatchRequest(fake(reply(401)), TOKEN, 'r'), { kind: 'status', status: 401 }, 'any other status is a failure');
  eq(await net.dispatchRequest(fake(() => { throw new Error(`connect failed with Bearer ${TOKEN}`); }), TOKEN, 'r'), { kind: 'error', error: 'network' }, 'a thrown error is the word network, whatever its message holds');
  const hang = async (_u, i) => new Promise((_, no) => i.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))));
  eq([await net.dispatchRequest(hang, TOKEN, 'r', 20), net.DISPATCH_TIMEOUT_MS], [{ kind: 'error', error: 'timeout' }, 10000], 'the AbortController gives up: timeout (10 s in the action)');
  const before = calls.length;
  eq([await net.dispatchRequest(fake(reply(204)), '  ', 'r'), calls.length - before], [{ kind: 'error', error: 'no-token' }, 0], 'no token: no request');
  eq([rec.dispatchError({ kind: 'status', status: 502 }), rec.dispatchError({ kind: 'error', error: 'timeout' }), rec.dispatchError({ kind: 'status', status: TOKEN }), rec.dispatchError({ kind: 'error', error: TOKEN })], ['dispatch 502', 'dispatch timeout', 'dispatch unknown', 'dispatch unknown'], 'the stored error is dispatch and a status or a word, nothing a caller could smuggle in');
  const db = world();
  const q = await run(db, 'queued', { attempts: 0 });
  const begun = await rec.beginDispatchCore(db, { runId: q }, T0, ENV);
  eq([begun.go, get(db, q).state, (await rec.beginDispatchCore(db, { runId: q }, T0, ENV)).go], [true, 'dispatched', false], 'begin marks the run dispatched, so a second dispatch of it sends nothing');
  await rec.dispatchResultCore(db, { runId: q, dispatchedAt: T0, outcome: { kind: 'error', error: 'timeout' } }, T0 + 1, ENV);
  eq([get(db, q).state, get(db, q).attempts, get(db, q).error], ['dispatched', 1, 'dispatch timeout'], 'a timeout spends an attempt and stays dispatched, since GitHub may have taken it');
  await rec.dispatchResultCore(db, { runId: q, dispatchedAt: T0, outcome: { kind: 'status', status: 422 } }, T0 + 2, ENV);
  eq([get(db, q).state, get(db, q).attempts, get(db, q).error], ['queued', 2, 'dispatch 422'], 'a refused dispatch is requeued for reconcile');
  eq((await rec.beginDispatchCore(db, { runId: q }, T0, FROZEN)).code, 'frozen', 'frozen: dispatch refuses before any write');
});

await section('readArchive, checkLive and verifyCommit hashes: archive-normalized posts, matched against approvedHash', async () => {
  const posts = [normal('one'), normal('two'), { id: 'Bad Id' }];
  const fake = async () => reply(200, JSON.stringify({ updated: '2026-09-15', posts }));
  const got = await net.readArchive(fake, net.LIVE_URL);
  eq([got.ok, got.complete, got.stories.map((s) => s.storyId), got.stories[0].contentHash === (await contentHash(posts[0]))], [true, false, ['2026-09-15-one', '2026-09-15-two'], true], 'ids and hashes; a post the archive refuses makes the read incomplete');
  eq([(await net.readArchive(async () => reply(404), 'x')).error, (await net.readArchive(async () => reply(200, 'not json'), 'x')).error, (await net.readArchive(async () => { throw new TypeError('fetch failed'); }, 'x')).error], ['404', 'format', 'network'], 'failures are short codes');
  eq([net.rawArchiveUrl(SHA), net.LIVE_URL], [`https://raw.githubusercontent.com/energon-a-secas/antenne-site/${SHA}/data/posts.json`, 'https://antenne.neorgon.com/data/posts.json'], 'the two archives section 6.1 reads');
  const db = world();
  const one = await draft(db, 'one', { ...due(), status: 'committed' });
  const two = await draft(db, 'two', { ...due(), status: 'committed', approvedHash: 'e'.repeat(64) });
  const three = await draft(db, 'three', { ...due(), status: 'committed' });
  eq(await rec.liveWantedCore(db), true, 'committed drafts: checkLive reads the site');
  eq(res(await rec.recordLiveCore(db, { stories: got.stories }, T0, ENV)), { ok: true, live: 2 }, 'both stories the live archive holds go live');
  eq([one, two, three].map((id) => [get(db, id).status, get(db, id).note]), [['live', null], ['live', 'edited'], ['committed', null]], 'the approved hash goes live as before; another hash (edited on main) goes live with note edited; a story not live stays committed');
  eq([db.rows('draftEvents').map((e) => [e.action, e.detail.edited ?? false, e.detail.contentHash ?? null]), await rec.liveWantedCore(db)], [[['live', false, null], ['live', true, got.stories[1].contentHash]], true], 'the edited one\'s event says so, with the live hash; the committed one is still looked for');
  await refused(db, (x) => rec.recordLiveCore(x, { stories: [{ storyId: 'x', contentHash: 'short' }] }, T0, ENV), 'invalid', 'a malformed archive answer');
});

await section('links: HEAD then GET on 405, redirects followed; blocking only for neorgon.com on 404, 410 or no DNS', async () => {
  const seen = [];
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nx.neorgon.com' } });
  const plan = {
    'HEAD https://gone.neorgon.com/a': reply(404), 'HEAD https://github.com/energon-a-secas/x': reply(404), 'HEAD https://old.neorgon.com/': reply(410),
    'HEAD https://head.neorgon.com/': reply(405), 'GET https://head.neorgon.com/': reply(200), 'HEAD https://down.neorgon.com/': reply(503),
  };
  const fake = async (url, init) => {
    seen.push([init.method, url, init.redirect]);
    if (url === 'https://nx.neorgon.com/') throw dns;
    if (url === 'https://again.neorgon.com/') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN again.neorgon.com' } });
    if (url === 'https://slow.neorgon.com/') throw new DOMException('aborted', 'AbortError');
    return plan[`${init.method} ${url}`];
  };
  const urls = ['https://gone.neorgon.com/a', 'https://github.com/energon-a-secas/x', 'https://old.neorgon.com/', 'https://head.neorgon.com/', 'https://down.neorgon.com/', 'https://nx.neorgon.com/', 'https://again.neorgon.com/', 'https://slow.neorgon.com/'];
  const checksOut = await net.checkLinks(fake, urls);
  eq(checksOut.map((c) => [c.status, c.blocking]), [[404, true], [404, false], [410, true], [200, false], [503, false], ['dns', true], ['network', false], ['timeout', false]], 'neorgon 404 and 410 and a name that does not resolve block; off-neorgon, 5xx, a resolver hiccup and a timeout warn');
  eq([seen.filter(([, u]) => u === 'https://head.neorgon.com/').map(([m]) => m), seen.every(([, , r]) => r === 'follow'), seen.filter(([m]) => m === 'GET').length, net.LINK_TIMEOUT_MS], [['HEAD', 'GET'], true, 1, 8000], 'GET only after a 405, every request follows redirects, 8 s each');
  const db = world();
  const d = await draft(db, 'links', {}, { links: [{ label: 'Gone', url: 'https://gone.neorgon.com/a' }, { label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }] });
  eq(await rec.linkTargetCore(db, { draftId: d }, ENV), { urls: ['https://gone.neorgon.com/a', 'https://dispatch.neorgon.com/desk.html'] }, 'the check visits the draft\'s links');
  eq([await rec.linkTargetCore(db, { draftId: d }, FROZEN), await rec.linkTargetCore(db, { draftId: 'drafts:404' }, ENV)], [null, null], 'nothing while frozen, nothing for a missing draft');
  await rec.recordLinksCore(db, { draftId: d, checks: [checksOut[0], { url: 'https://left.neorgon.com/', status: 200, blocking: false }] }, T0, ENV);
  eq([get(db, d).linkChecks, get(db, d).rev, db.rows('draftEvents').at(-1).detail], [[checksOut[0]], 1, { checked: 1, blocking: 1 }], 'recorded for the urls the draft still links, rev unchanged');
  await refused(db, (x) => rec.recordLinksCore(x, { draftId: d, checks: [{ url: 'x', status: 'boom', blocking: true }] }, T0, ENV), 'invalid', 'a check with a status that is no status');
});

// ── The route table ─────────────────────────────────────────────────────────
const VECTORS = JSON.parse(read('tests/sign-vectors.json')).vectors;
const KEYS = Object.fromEntries(VECTORS.map((v) => [v.keyId, { scopes: v.scopes, secret: v.secret }]));
const MACHINE_KEYS = Object.entries(KEYS).map(([id, k]) => `${id}:${k.scopes.join('+')}:${k.secret}`).join(',');
const TS = Math.floor(T0 / 1000);
const signed = (keyId, path, body, ts = TS) => new Headers({ 'X-Antenne-Key': keyId, 'X-Antenne-Timestamp': String(ts), 'X-Antenne-Signature': createHmac('sha256', Buffer.from(KEYS[keyId].secret, 'base64')).update(`${keyId}.${ts}.${path}.${body}`).digest('base64') });
await section('routes.ts: the five /publish/* rows, publish scope, writes, their shapes', async () => {
  const PATHS = ['/publish/claim', '/publish/conflict', '/publish/pushed', '/publish/built', '/publish/release'];
  eq(ROUTES.filter((r) => r.path.startsWith('/publish/')).map((r) => [r.path, r.scope, r.fn, r.write, r.meter]), PATHS.map((p) => [p, 'publish', `publish:${p.slice(9)}`, true, false]), 'one row per route, scope publish, frozen-refused writes that rate themselves');
  const pipe = async (path, key, body, env = { MACHINE_KEYS }) => {
    const ran = [];
    const a = await machineRequest('POST', path, signed(key, path, body), async () => body, env, T0, async (fn) => { ran.push(fn); return { ok: true }; });
    return [a.status, a.body.code ?? 'ok', ran];
  };
  const good = { '/publish/claim': { runId: null, ghRunId: '1', runUrl: null }, '/publish/conflict': { runId: 'r', storyIds: [] }, '/publish/pushed': { runId: 'r', sha: SHA, noChange: false }, '/publish/built': { runId: 'r', sha: SHA, pagesStatus: 'built' }, '/publish/release': { runId: 'r', reason: 'dry-run' } };
  const bad = { '/publish/claim': {}, '/publish/conflict': { runId: 'r', storyIds: 'x' }, '/publish/pushed': { runId: 'r', sha: SHA, noChange: 'no' }, '/publish/built': { runId: 'r', sha: SHA }, '/publish/release': { runId: 1, reason: 'x' } };
  for (const p of PATHS) {
    eq(await pipe(p, 'gh', JSON.stringify(good[p])), [200, 'ok', [`publish:${p.slice(9)}`]], `${p}: the gh key reaches its function`);
    eq(await pipe(p, 'local', JSON.stringify(good[p])), [403, 'scope', []], `${p}: a submit and status key is 403 scope`);
    eq(await pipe(p, 'gh', JSON.stringify(good[p]), { MACHINE_KEYS, DESK_FROZEN: '1' }), [503, 'frozen', []], `${p}: 503 while frozen`);
    eq(await pipe(p, 'gh', JSON.stringify(bad[p])), [400, 'malformed', []], `${p}: a body of the wrong shape is 400 malformed`);
  }
});

// ── Refusals before any write ───────────────────────────────────────────────
await section('conflict, pushed, built, release: frozen, a key without publish, a person and the 121st call write nothing', async () => {
  const LOCAL = access.machineCaller('local', ['submit', 'status']);
  for (const [name, state, args] of [['conflictCore', 'claimed', { storyIds: [] }], ['pushedCore', 'claimed', { sha: SHA, noChange: false }], ['builtCore', 'pushed', { sha: SHA, pagesStatus: 'built' }], ['releaseCore', 'claimed', { reason: 'build' }]]) {
    const db = await people(world());
    const a = { runId: await run(db, state, { commitSha: SHA }), ...args };
    await refused(db, (x) => mach[name](x, GH, a, T0, FROZEN), 'frozen', `${name} while frozen`);
    await refused(db, (x) => mach[name](x, LOCAL, a, T0, ENV), 'forbidden', `${name} with the submit and status key`);
    await refused(db, async (x) => mach[name](x, await access.resolveCaller(x, OWNER, ENV), a, T0, ENV), 'forbidden', `${name} from an owner, a person`);
    for (let i = 0; i < 120; i++) await db.insert('rateEvents', { bucket: 'key:gh|machine.publish', at: T0 - 1000 });
    await refused(db, (x) => mach[name](x, GH, a, T0, ENV), 'rate-limited', `${name}: the 121st publish call in an hour`);
  }
});

await section('this run\'s publishing drafts only: conflict and verification skip others; built wants the pushed sha of a pushed run', async () => {
  const { db, ids: [a, b], runId } = await claimedWorld();
  const other = await draft(db, 'other', { ...due(), status: 'publishing', claimRun: 'publishRuns:77', claimedAt: T0 });
  await db.patch(b, { status: 'committed', commitSha: 'c'.repeat(40) });
  await mach.conflictCore(db, GH, { runId, storyIds: [get(db, other).storyId, get(db, b).storyId] }, T0 + 1, ENV);
  eq([get(db, other).status, get(db, other).note, get(db, b).status, get(db, b).rev], ['publishing', null, 'committed', 2], 'conflict leaves another run\'s draft and a committed one alone');
  const early = await run(db, 'claimed', { commitSha: SHA });
  await refused(db, (x) => mach.builtCore(x, GH, { runId: early, sha: SHA, pagesStatus: 'built' }, T0, ENV), 'status', 'built for a run that has not pushed, even naming its sha');
  await mach.pushedCore(db, GH, { runId, sha: SHA, noChange: false }, T0 + 2, ENV);
  await refused(db, (x) => mach.builtCore(x, GH, { runId, sha: 'b'.repeat(40), pagesStatus: 'built' }, T0, ENV), 'status', 'built naming another commit than the pushed one');
  await refused(db, (x) => mach.builtCore(x, GH, { runId, sha: 'A'.repeat(40), pagesStatus: 'built' }, T0, ENV), 'invalid', 'built with a sha that is not lowercase hex');
  const file = [a, b].map((id) => ({ storyId: get(db, id).storyId, contentHash: get(db, id).approvedHash }));
  await refused(db, (x) => rec.recordCommitCore(x, { runId, sha: SHA, stories: file, complete: true }, T0, FROZEN), 'frozen', 'recordCommit while frozen');
  await refused(db, (x) => rec.recordCommitCore(x, { runId, sha: SHA, error: 'Not A Word!' }, T0, ENV), 'invalid', 'a verify error that is not a short word');
  for (const state of ['claimed', 'done', 'failed']) {
    await db.patch(runId, { state });
    eq(res(await rec.recordCommitCore(db, { runId, sha: SHA, stories: file, complete: true }, T0, ENV)), { ok: true, ignored: true }, `a verification for a ${state} run is ignored`);
  }
  await db.patch(runId, { state: 'pushed' });
  eq([res(await rec.recordCommitCore(db, { runId, sha: SHA, stories: file, complete: true }, T0 + 3, ENV)).committed, get(db, a).status, get(db, b).commitSha, get(db, b).rev], [1, 'committed', 'c'.repeat(40), 2], 'a draft already committed is not committed again');
  const big = world();
  const q = await run(big, 'pushed', { commitSha: SHA });
  for (let i = 0; i <= net.PUBLISHED_SYNC_MAX; i++) await big.insert('publishedIds', { storyId: `2026-01-01-old-${i}`, contentHash: 'c'.repeat(64), commitSha: SHA, at: T0 });
  const synced = res(await rec.recordCommitCore(big, { runId: q, sha: SHA, stories: [{ storyId: '2026-09-15-new', contentHash: 'd'.repeat(64) }], complete: true }, T0, ENV));
  eq([synced.added, synced.removed, big.count('publishedIds')], [1, 0, net.PUBLISHED_SYNC_MAX + 2], `over ${net.PUBLISHED_SYNC_MAX} published ids, a complete read removes none`);
});

await section('dispatch, live and link records refuse while frozen, and ignore a late or misplaced answer', async () => {
  const db = world();
  const q = await run(db, 'queued', { attempts: L.RUN_MAX_ATTEMPTS });
  eq([await rec.beginDispatchCore(db, { runId: q }, T0, ENV), get(db, q).state, get(db, q).error], [{ go: false, code: 'failed', dispatchedAt: null, intents: [] }, 'failed', 'attempts'], `a queued run at ${L.RUN_MAX_ATTEMPTS} attempts is failed, never sent`);
  const d = await run(db, 'dispatched', { dispatchedAt: T0 });
  const ok = { kind: 'ok', status: 204, ghRunId: null, runUrl: null };
  await refused(db, (x) => rec.dispatchResultCore(x, { runId: d, dispatchedAt: T0, outcome: ok }, T0, FROZEN), 'frozen', 'a dispatch answer while frozen');
  const back = await run(db, 'queued', { dispatchedAt: T0 });
  for (const [what, args] of [['an earlier dispatch', { runId: d, dispatchedAt: T0 - 1 }], ['a run requeued since', { runId: back, dispatchedAt: T0 }]]) {
    eq([res(await rec.dispatchResultCore(db, { ...args, outcome: { kind: 'status', status: 500 } }, T0 + 1, ENV)), get(db, args.runId).attempts], [{ ok: true, ignored: true }, 0], `the answer to ${what} is ignored`);
  }
  await refused(db, (x) => rec.recordLiveCore(x, { stories: [] }, T0, FROZEN), 'frozen', 'recordLive while frozen');
  const [c, s] = [await draft(db, 'kept', { ...due(), status: 'committed' }), await draft(db, 'spiked', { status: 'spiked' })];
  await refused(db, (x) => rec.recordLinksCore(x, { draftId: c, checks: [] }, T0, FROZEN), 'frozen', 'links:record while frozen');
  eq([res(await rec.recordLinksCore(db, { draftId: c, checks: [] }, T0, ENV)), get(db, c).linkChecks, await rec.linkTargetCore(db, { draftId: c }, ENV), await rec.linkTargetCore(db, { draftId: s }, ENV)], [{ ok: true, recorded: 0 }, null, null, null], 'a committed or spiked draft is neither checked nor recorded');
  eq([net.isNeorgonLink('https://evilneorgon.com/'), net.isNeorgonLink('https://neorgon.com.evil.example/'), net.isNeorgonLink('http://neorgon.com/'), net.isNeorgonLink('https://NEORGON.com'), net.isNeorgonLink('https://a.b.neorgon.com/x')], [false, false, false, true, true], 'neorgon.com and its subdomains only, dot-anchored, over https');
  eq(await net.checkLink(async () => reply(404), 'https://evilneorgon.com/x'), { url: 'https://evilneorgon.com/x', status: 404, blocking: false }, 'a look-alike host answering 404 does not block');
});

await section('publish:now and publish:retry spend draft.write: the 601st in an hour is refused before any write', async () => {
  const db = await people(world());
  await run(db, 'failed');
  for (let i = 0; i < L.LIMITS['draft.write'].max; i++) await db.insert('rateEvents', { bucket: `${EDITOR}|draft.write`, at: T0 - 1000 });
  const editor = await access.resolveCaller(db, EDITOR, ENV);
  await refused(db, (x) => core.publishNowCore(x, editor, {}, T0, ENV), 'rate-limited', 'publish:now');
  await refused(db, (x) => core.publishRetryCore(x, editor, {}, T0, ENV), 'rate-limited', 'publish:retry');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
