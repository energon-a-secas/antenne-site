// Plain node, no install. Run with: make validate
//
// The draft cores (docs/plans/2026-09-15-antenne-desk.md sections 4.2 and 4.3)
// over the in-memory database in tests/support/fakedb.mjs: stale revs, approval
// with a patch and its hash, approveMany item by item, own submissions, the
// owner's self-approve, external links, blocking link checks, an edit undoing
// an approval, the smaller transitions, the rate rows and the queue, including
// a submitter's own drafts read through by_submittedBy. Every refusal is held to
// writing nothing, counted by countWrites and checked against a snapshot.

import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as schema from '../js/schema.js';
import * as access from '../convex/lib/access.ts';
import {
  approveCore, approveManyCore, assignCore, editCore, newDraft, overrideLinksCore, queueCore, recheckLinksCore,
  reopenCore, spikeCore, submitCore, takeCore, withdrawCore,
} from '../convex/lib/draftsCore.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';

let failed = 0;
let checks = 0;
function eq(actual, expected, what) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
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

const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const REVIEWER = 'user_reviewer';
const SUBMITTER = 'user_submitter';
const STRANGER = 'user_stranger';
const OTHER = 'user_other';
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const TABLES = ['members', 'accessRequests', 'drafts', 'draftEvents', 'publishRuns', 'publishedIds', 'settings', 'rateEvents'];
const POST = Object.freeze({
  id: '2026-09-14-antenne-desk', date: '2026-09-14', kind: 'launch', site: 'dispatch-site', title: 'The desk opens',
  summary: 'Drafts go to a private queue.', body: ['One paragraph.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'],
});
const post = (slug, over = {}) => ({ ...POST, id: `2026-09-14-${slug}`, ...over });
const as = (db, subject, env = ENV) => access.resolveCaller(db, subject, env);
const draftOf = (db, id) => db.rows('drafts').find((d) => d._id === id);
const eventsOf = (db, id) => db.rows('draftEvents').filter((e) => e.draftId === id);

async function world() {
  const db = countWrites(createFakeDb());
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) {
    await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  }
  db.resetWrites();
  return db;
}
async function seedDraft(db, over = {}) {
  const verdict = validatePost(over.post ?? POST, { mode: 'desk' });
  const row = newDraft({ post: verdict.post, hash: await contentHash(verdict.post), external: verdict.external, source: 'desk', submittedBy: OTHER, assignee: null, now: T0 - 1000 });
  const id = await db.insert('drafts', { ...row, ...over, post: verdict.post });
  db.resetWrites();
  return id;
}
/** Runs a call that must be refused with `want`, and proves it wrote nothing. */
async function refused(db, run, want, what) {
  db.resetWrites();
  const before = JSON.stringify(TABLES.map((t) => db.rows(t)));
  const answer = await run();
  const r = answer && 'intent' in answer && 'result' in answer ? answer.result : answer;
  eq([r.ok, r.code, db.writes()], [false, want, 0], `${what}: ${want}, and nothing written`);
  eq(JSON.stringify(TABLES.map((t) => db.rows(t))) === before, true, `${what}: every table is as it was`);
  return r;
}

await section('drafts:submit stores a pending desk draft with its hash, and one event with no story text', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const r = await submitCore(db, editor, { post: post('launch', { title: '  The desk opens  ', extra: 'dropped' }) }, T0, ENV);
  eq([r.ok, typeof r.draftId, r.storyId], [true, 'string', '2026-09-14-launch'], 'submit answers draftId and storyId');
  const d = draftOf(db, r.draftId);
  const normalized = schema.validatePost(post('launch'), { mode: 'desk' }).post;
  eq(d.post, normalized, 'the stored post is the desk-mode normalized post: trimmed, unknown fields dropped');
  eq([d.status, d.rev, d.machineRev, d.source, d.submittedBy, d.humanTouched, d.assignee, d.external, d.linkChecks],
    ['pending', 1, 0, 'desk', EDITOR, true, null, false, null], 'pending, rev 1, from the desk, by the editor, unassigned, unchecked');
  eq(d.contentHash, await schema.contentHash(normalized), 'contentHash is js/schema.js contentHash of the normalized post');
  const events = eventsOf(db, r.draftId);
  eq(events.map((e) => [e.action, e.actor, e.storyId, e.at]), [['submit', EDITOR, '2026-09-14-launch', T0]], 'one submit event');
  eq(JSON.stringify(events[0].detail).includes('desk opens'), false, 'the event holds no story text');

  await refused(db, () => submitCore(db, editor, { post: post('launch') }, T0, ENV), 'duplicate-id', 'the same id again');
  await db.insert('publishedIds', { storyId: '2026-09-14-shipped', contentHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), at: T0 });
  await refused(db, () => submitCore(db, editor, { post: post('shipped') }, T0, ENV), 'duplicate-id', 'an id already published');
  const bad = await refused(db, () => submitCore(db, editor, { post: post('x', { id: '2026-09-10-x' }) }, T0, ENV), 'invalid', 'an id that does not start with its date');
  eq(bad.problems, [{ field: 'id', code: 'id-date' }], 'invalid carries the desk-mode problems');
});

await section('a desk submission goes to the default assignee while eligible, never to its own submitter', async () => {
  const db = await world();
  await db.insert('settings', { key: 'desk', defaultAssignee: REVIEWER, publishDelayMs: 300000, updatedBy: OWNER, updatedAt: T0 });
  const a = await submitCore(db, await as(db, EDITOR), { post: post('a') }, T0, ENV);
  const b = await submitCore(db, await as(db, REVIEWER), { post: post('b') }, T0, ENV);
  const denied = { ...ENV, DESK_DENY: REVIEWER };
  const c = await submitCore(db, await as(db, EDITOR, denied), { post: post('c') }, T0, denied);
  eq([a, b, c].map((r) => draftOf(db, r.draftId).assignee), [REVIEWER, null, null], 'assigned; not to the reviewer who submitted it; not to a denied reviewer');
});

await section('drafts:submit allows 30 stories an hour per account', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  for (let i = 0; i < 30; i += 1) await submitCore(db, editor, { post: post(`s${i}`) }, T0 + i, ENV);
  eq(db.count('drafts'), 30, 'thirty submissions in an hour');
  const r = await refused(db, () => submitCore(db, editor, { post: post('s30') }, T0 + 30, ENV), 'rate-limited', 'the 31st');
  eq(r.retryAfterMs > 0, true, 'and says when to retry');
  eq((await submitCore(db, await as(db, REVIEWER), { post: post('other') }, T0 + 31, ENV)).ok, true, 'another account is not affected');
  eq((await submitCore(db, editor, { post: post('later') }, T0 + HOUR + 1, ENV)).ok, true, 'an hour after the first, the window has room again');
});

await section('a stale expectedRev is refused before anything is written', async () => {
  const db = await world();
  const id = await seedDraft(db, { submittedBy: SUBMITTER, assignee: REVIEWER });
  const editor = await as(db, EDITOR);
  const r = await refused(db, () => editCore(db, editor, { draftId: id, expectedRev: 0, patch: { title: 'Late' } }, T0, ENV), 'stale', 'edit with rev 0');
  eq(r.rev, 1, 'stale names the current rev');
  await refused(db, () => approveCore(db, editor, { draftId: id, expectedRev: 2 }, T0, ENV), 'stale', 'approve with rev 2');
  await refused(db, () => spikeCore(db, editor, { draftId: id, expectedRev: '1' }, T0, ENV), 'stale', 'a rev sent as a string');
  eq((await editCore(db, editor, { draftId: id, expectedRev: 1, patch: { title: 'On time' } }, T0, ENV)).rev, 2, 'the current rev edits');
  const reviewer = await as(db, REVIEWER);
  await refused(db, () => approveCore(db, reviewer, { draftId: id, expectedRev: 1 }, T0, ENV), 'stale', 'an approve holding the rev from before that edit');
});

await section('drafts:approve saves the patch and approves in one mutation, storing approvedHash', async () => {
  const db = await world();
  const id = await seedDraft(db, { submittedBy: SUBMITTER, assignee: REVIEWER });
  const { result, intent } = await approveCore(db, await as(db, EDITOR), { draftId: id, expectedRev: 1, patch: { title: 'A sharper title', notAField: 1 } }, T0, ENV);
  eq(result, { ok: true, rev: 2, publishAfter: T0 + 300000 }, 'answers rev and publishAfter, five minutes on by default');
  eq(intent, { kind: 'publish', runAt: T0 + 300000 }, 'and hands the wrapper a publish intent at publishAfter');
  const d = draftOf(db, id);
  const saved = schema.validatePost({ ...POST, title: 'A sharper title' }, { mode: 'desk' }).post;
  eq(d.post, saved, 'the patch is saved, and a key that is no post field is ignored');
  eq([d.status, d.approvedBy, d.approvedAt, d.publishAfter, d.humanTouched, d.assignee], ['approved', EDITOR, T0, T0 + 300000, true, REVIEWER], 'approved by the editor; the assignee is kept');
  const hash = await schema.contentHash(saved);
  eq([d.approvedHash, d.contentHash], [hash, hash], 'approvedHash is contentHash of the saved post');
  eq(eventsOf(db, id).map((e) => [e.action, e.detail.fields, e.detail.approvedHash]), [['approve', ['title'], hash]], 'one approve event naming the changed field');
  eq(db.rows('rateEvents').map((r) => [r.bucket, r.at]), [[`${EDITOR}|draft.write`, T0]], 'and one draft.write rate row, in the editor\'s bucket at the time of the call');

  const quick = await world();
  await quick.insert('settings', { key: 'desk', defaultAssignee: null, publishDelayMs: 0, updatedBy: OWNER, updatedAt: T0 });
  const id2 = await seedDraft(quick, { submittedBy: SUBMITTER });
  const editor = await as(quick, EDITOR);
  eq((await approveCore(quick, editor, { draftId: id2, expectedRev: 1 }, T0, ENV)).result.publishAfter, T0, 'publishAfter follows settings.publishDelayMs');
  await refused(quick, () => approveCore(quick, editor, { draftId: id2, expectedRev: 2 }, T0, ENV), 'status', 'approving an approved draft again');
  const id3 = await seedDraft(quick, { post: post('third'), submittedBy: SUBMITTER });
  const bad = await refused(quick, () => approveCore(quick, editor, { draftId: id3, expectedRev: 1, patch: { title: '', tags: 'x' } }, T0, ENV), 'invalid', 'a patch that breaks the rules');
  eq(bad.problems, [{ field: 'tags', code: 'format' }, { field: 'title', code: 'required' }], 'with its problems');
  await refused(quick, () => approveCore(quick, editor, { draftId: id3, expectedRev: 1, patch: 'title' }, T0, ENV), 'invalid', 'a patch that is not an object');

  const free = await seedDraft(quick, { post: post('free'), submittedBy: SUBMITTER });
  const reviewer = await as(quick, REVIEWER);
  eq((await approveCore(quick, reviewer, { draftId: free, expectedRev: 1 }, T0, ENV)).result.ok, true, 'a reviewer approves an unassigned draft');
  eq([draftOf(quick, free).assignee, eventsOf(quick, free)[0].detail.took], [REVIEWER, true], 'and takes it in the same mutation');
  const held = await seedDraft(quick, { post: post('held'), submittedBy: SUBMITTER, assignee: EDITOR });
  await refused(quick, () => approveCore(quick, reviewer, { draftId: held, expectedRev: 1 }, T0, ENV), 'forbidden', 'a reviewer approving a draft assigned to someone else');
});

await section('drafts:approveMany answers each item on its own', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const one = await seedDraft(db, { post: post('one'), submittedBy: SUBMITTER });
  const own = await seedDraft(db, { post: post('own'), submittedBy: EDITOR });
  const stale = await seedDraft(db, { post: post('stale'), submittedBy: SUBMITTER });
  const decided = await seedDraft(db, { post: post('decided'), submittedBy: SUBMITTER, status: 'approved', approvedBy: OWNER });
  const two = await seedDraft(db, { post: post('two'), submittedBy: REVIEWER });
  const gone = await seedDraft(db, { post: post('gone'), submittedBy: SUBMITTER });
  await db.delete('drafts', gone);
  const untouched = [own, stale, decided].map((id) => draftOf(db, id));
  db.resetWrites();
  const items = [[one, 1], [own, 1], [stale, 7], [decided, 1], [gone, 1], [two, 1], [one, 1]].map(([draftId, expectedRev]) => ({ draftId, expectedRev }));
  const { result, intent } = await approveManyCore(db, editor, { items }, T0, ENV);
  eq(result.results.map((r) => [r.draftId, r.ok, r.code]),
    [[one, true, null], [own, false, 'own-submission'], [stale, false, 'stale'], [decided, false, 'status'], [gone, false, 'not-found'], [two, true, null], [one, false, 'stale']],
    'two approved; own-submission, stale, status, not-found and a repeat refused, in order');
  eq(intent, { kind: 'publish', runAt: T0 + 300000 }, 'one publish intent for the call');
  eq([draftOf(db, one).status, draftOf(db, two).status], ['approved', 'approved'], 'the two are approved');
  eq([own, stale, decided].map((id) => draftOf(db, id)), untouched, 'the refused items are untouched');
  eq(db.writes(), 2 * 2 + 1, 'a patch and an event per approved item, and one rate row for the call');
  await refused(db, () => approveManyCore(db, editor, { items: Array.from({ length: 26 }, () => ({ draftId: one, expectedRev: 2 })) }, T0, ENV), 'too-many', '26 items');
  await refused(db, () => approveManyCore(db, editor, { items: 'all' }, T0, ENV), 'invalid', 'items that are not a list');
  db.resetWrites();
  const none = await approveManyCore(db, editor, { items: [{ draftId: own, expectedRev: 1 }] }, T0, ENV);
  eq([none.result.results[0].code, none.intent, db.writes()], ['own-submission', null, 0], 'a call whose every item is refused writes nothing and schedules nothing');
  eq((await approveManyCore(db, editor, { items: Array.from({ length: 25 }, () => ({ draftId: own, expectedRev: 1 })) }, T0, ENV)).result.ok, true, '25 items are accepted');
});

await section('nobody but an owner approves their own submission, and an owner doing so is recorded as self-approve', async () => {
  const db = await world();
  for (const subject of [EDITOR, REVIEWER]) {
    const id = await seedDraft(db, { post: post(`own-${subject}`.replace('_', '-')), submittedBy: subject, assignee: subject });
    const caller = await as(db, subject);
    await refused(db, () => approveCore(db, caller, { draftId: id, expectedRev: 1 }, T0, ENV), 'own-submission', `${subject} approving their own story`);
  }
  const owner = await as(db, OWNER);
  const mine = await submitCore(db, owner, { post: post('solo') }, T0, ENV);
  eq((await approveCore(db, owner, { draftId: mine.draftId, expectedRev: 1 }, T0, ENV)).result.ok, true, 'the owner approves their own story');
  eq(eventsOf(db, mine.draftId).map((e) => e.action), ['submit', 'self-approve'], 'recorded as self-approve');
  const theirs = await seedDraft(db, { post: post('theirs'), submittedBy: SUBMITTER });
  await approveCore(db, owner, { draftId: theirs, expectedRev: 1 }, T0, ENV);
  eq(eventsOf(db, theirs).map((e) => e.action), ['approve'], 'an owner approving another person\'s story is a plain approve');
});

await section('a reviewer cannot approve a story with external links; an editor can', async () => {
  const db = await world();
  const elsewhere = [{ label: 'Elsewhere', url: 'https://example.com/' }];
  const sent = await submitCore(db, await as(db, SUBMITTER), { post: post('ext', { links: elsewhere }) }, T0, ENV);
  eq([sent.ok, draftOf(db, sent.draftId).external], [true, true], 'desk mode accepts the external link and marks the draft external');
  await db.patch('drafts', sent.draftId, { assignee: REVIEWER });
  const reviewer = await as(db, REVIEWER);
  await refused(db, () => approveCore(db, reviewer, { draftId: sent.draftId, expectedRev: 1 }, T0, ENV), 'external-links', 'the assigned reviewer');
  const cleaned = await approveCore(db, reviewer, { draftId: sent.draftId, expectedRev: 1, patch: { links: POST.links } }, T0, ENV);
  eq([cleaned.result.ok, draftOf(db, sent.draftId).external], [true, false], 'the reviewer may approve once a patch in that call removes the external link');
  const second = await seedDraft(db, { post: post('ext2', { links: elsewhere }), submittedBy: SUBMITTER });
  eq((await approveCore(db, await as(db, EDITOR), { draftId: second, expectedRev: 1 }, T0, ENV)).result.ok, true, 'an editor approves a story with external links');
});

await section('a blocking link check refuses approval until an owner overrides it', async () => {
  const db = await world();
  const url = POST.links[0].url;
  const id = await seedDraft(db, { submittedBy: SUBMITTER, linkChecks: [{ url, status: 404, blocking: true }] });
  const editor = await as(db, EDITOR);
  await refused(db, () => approveCore(db, editor, { draftId: id, expectedRev: 1 }, T0, ENV), 'links-blocked', 'approve with a 404 on a neorgon.com link');
  await refused(db, () => approveCore(db, editor, { draftId: id, expectedRev: 1, patch: { title: 'Retitled' } }, T0, ENV), 'links-blocked', 'a patch that keeps the broken url');
  await refused(db, () => overrideLinksCore(db, editor, { draftId: id, expectedRev: 1 }, T0, ENV), 'forbidden', 'an editor overriding');
  const over = await overrideLinksCore(db, await as(db, OWNER), { draftId: id, expectedRev: 1 }, T0, ENV);
  eq([over.ok, draftOf(db, id).linkOverride], [true, OWNER], 'the owner overrides');
  eq((await approveCore(db, editor, { draftId: id, expectedRev: 2 }, T0, ENV)).result.ok, true, 'then the editor approves');
  const warn = await seedDraft(db, { post: post('warn'), submittedBy: SUBMITTER, linkChecks: [{ url, status: 503, blocking: false }] });
  eq((await approveCore(db, editor, { draftId: warn, expectedRev: 1 }, T0, ENV)).result.ok, true, 'a warning does not block');
  const swap = await seedDraft(db, { post: post('swap'), submittedBy: SUBMITTER, linkChecks: [{ url, status: 404, blocking: true }], linkOverride: OWNER });
  eq((await editCore(db, editor, { draftId: swap, expectedRev: 1, patch: { links: [{ label: 'Feed', url: 'https://dispatch.neorgon.com/' }] } }, T0, ENV)).ok, true, 'an edit replaces the broken url');
  eq([draftOf(db, swap).linkChecks, draftOf(db, swap).linkOverride], [[], null], 'the check for a url that is gone is dropped, and the override with it');
});

await section('editing an approved draft returns it to pending and clears the approval', async () => {
  const db = await world();
  const id = await seedDraft(db, { submittedBy: SUBMITTER });
  const editor = await as(db, EDITOR);
  await approveCore(db, editor, { draftId: id, expectedRev: 1 }, T0, ENV);
  db.resetWrites();
  eq([await editCore(db, editor, { draftId: id, expectedRev: 2, patch: { title: `  ${POST.title}` } }, T0, ENV), db.writes(), draftOf(db, id).status],
    [{ ok: true, rev: 2 }, 0, 'approved'], 'an edit that changes nothing writes nothing, and the approval stands');
  eq(await editCore(db, editor, { draftId: id, expectedRev: 2, patch: { title: 'A sharper title' } }, T0 + 1, ENV), { ok: true, rev: 3 }, 'a real edit');
  const d = draftOf(db, id);
  eq([d.status, d.rev, d.approvedHash, d.approvedBy, d.approvedAt, d.publishAfter], ['pending', 3, null, null, null, null], 'is pending again with the approval cleared');
  eq(eventsOf(db, id).at(-1).detail, { rev: 3, fields: ['title'], from: 'approved', to: 'pending', contentHash: d.contentHash }, 'and its event records the way back');
  const owner = await as(db, OWNER);
  await refused(db, () => approveCore(db, owner, { draftId: id, expectedRev: 2 }, T0, ENV), 'stale', 'an approve still holding the old rev');
});

await section('reviewers edit what they hold; submitters edit their own pending drafts and see nothing else', async () => {
  const db = await world();
  const held = await seedDraft(db, { post: post('held'), assignee: REVIEWER });
  const free = await seedDraft(db, { post: post('free') });
  const mine = await seedDraft(db, { post: post('mine'), submittedBy: SUBMITTER });
  const mineApproved = await seedDraft(db, { post: post('mine-approved'), submittedBy: SUBMITTER, status: 'approved', approvedBy: EDITOR });
  const reviewer = await as(db, REVIEWER);
  const submitter = await as(db, SUBMITTER);
  const patch = { summary: 'A new summary.' };
  eq((await editCore(db, reviewer, { draftId: held, expectedRev: 1, patch }, T0, ENV)).ok, true, 'a reviewer edits a draft assigned to them');
  await refused(db, () => editCore(db, reviewer, { draftId: free, expectedRev: 1, patch }, T0, ENV), 'forbidden', 'a reviewer editing an unassigned draft');
  eq((await editCore(db, submitter, { draftId: mine, expectedRev: 1, patch }, T0, ENV)).ok, true, 'a submitter edits their own pending draft');
  await refused(db, () => editCore(db, submitter, { draftId: mineApproved, expectedRev: 1, patch }, T0, ENV), 'status', 'a submitter editing their own approved draft');
  await refused(db, () => editCore(db, submitter, { draftId: free, expectedRev: 1, patch }, T0, ENV), 'not-found', 'a submitter editing a draft they did not submit');
  await refused(db, () => editCore(db, submitter, { draftId: mine, expectedRev: 2, patch: { id: '2026-09-14-held' } }, T0, ENV), 'duplicate-id', 'an edit onto an id another draft holds');
  const renamed = await editCore(db, submitter, { draftId: mine, expectedRev: 2, patch: { id: '2026-09-15-renamed', date: '2026-09-15' } }, T0, ENV);
  eq([renamed.ok, draftOf(db, mine).storyId, eventsOf(db, mine).at(-1).storyId], [true, '2026-09-15-renamed', '2026-09-15-renamed'], 'an id and date change moves storyId with the post');
});

await section('withdraw, spike, reopen, take, assign and recheckLinks', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const reviewer = await as(db, REVIEWER);
  const submitter = await as(db, SUBMITTER);
  const a = await seedDraft(db, { post: post('a'), submittedBy: SUBMITTER, assignee: REVIEWER });
  await approveCore(db, reviewer, { draftId: a, expectedRev: 1 }, T0, ENV);
  const b = await seedDraft(db, { post: post('b'), submittedBy: SUBMITTER, status: 'approved', approvedBy: EDITOR, assignee: REVIEWER });
  await refused(db, () => withdrawCore(db, reviewer, { draftId: b, expectedRev: 1 }, T0, ENV), 'forbidden', 'a reviewer withdrawing an approval not theirs');
  eq((await withdrawCore(db, reviewer, { draftId: a, expectedRev: 2 }, T0, ENV)).ok, true, 'a reviewer withdraws their own approval');
  eq([draftOf(db, a).status, draftOf(db, a).approvedHash, draftOf(db, a).publishAfter], ['pending', null, null], 'back to pending with no approval');
  await db.patch('drafts', b, { claimRun: 'publishRuns:1' });
  await refused(db, () => withdrawCore(db, editor, { draftId: b, expectedRev: 1 }, T0, ENV), 'status', 'withdrawing an approval a publish run has claimed');

  eq((await spikeCore(db, submitter, { draftId: a, expectedRev: 3, note: '  Not news after all  ' }, T0, ENV)).ok, true, 'a submitter spikes their own draft');
  eq([draftOf(db, a).status, draftOf(db, a).note], ['spiked', 'Not news after all'], 'with a trimmed note');
  const c = await seedDraft(db, { post: post('c'), submittedBy: SUBMITTER });
  const long = await refused(db, () => spikeCore(db, editor, { draftId: c, expectedRev: 1, note: 'x'.repeat(201) }, T0, ENV), 'invalid', 'a spike note over 200 characters');
  eq(long.problems, [{ field: 'note', code: 'too-long' }], 'named too-long');
  await refused(db, () => reopenCore(db, reviewer, { draftId: a, expectedRev: 4 }, T0, ENV), 'forbidden', 'a reviewer reopening');
  eq((await reopenCore(db, editor, { draftId: a, expectedRev: 4 }, T0, ENV)).ok, true, 'an editor reopens');
  eq([draftOf(db, a).status, draftOf(db, a).note], ['pending', null], 'pending, and the note cleared');

  eq((await takeCore(db, reviewer, { draftId: c, expectedRev: 1 }, T0, ENV)).ok, true, 'a reviewer takes an unassigned draft');
  await refused(db, () => takeCore(db, editor, { draftId: c, expectedRev: 2 }, T0, ENV), 'status', 'taking a draft someone holds');
  await refused(db, () => assignCore(db, editor, { draftId: c, expectedRev: 2, assignee: SUBMITTER }, T0, ENV), 'bad-role', 'assigning to a submitter');
  await refused(db, () => assignCore(db, editor, { draftId: c, expectedRev: 2, assignee: STRANGER }, T0, ENV), 'bad-subject', 'assigning to an account with no role');
  await refused(db, () => assignCore(db, editor, { draftId: c, expectedRev: 2, assignee: 'reviewer' }, T0, ENV), 'bad-subject', 'assigning to something that is no account id');
  eq((await assignCore(db, editor, { draftId: c, expectedRev: 2, assignee: OWNER }, T0, ENV)).ok, true, 'an editor assigns to an owner');
  eq((await assignCore(db, editor, { draftId: c, expectedRev: 3, assignee: null }, T0, ENV)).ok, true, 'and to nobody');
  eq(eventsOf(db, c).map((e) => [e.action, e.detail.rev]), [['take', 2], ['assign', 3], ['assign', 4]], 'each change is one event');

  db.resetWrites();
  const again = await recheckLinksCore(db, submitter, { draftId: c }, T0, ENV);
  eq([again.result.ok, again.intent, db.writes()], [true, { kind: 'links', draftId: c }, 1], 'recheckLinks writes only its rate row and hands back a links intent');
});

await section('a reviewer spikes, or asks for a link check on, only a story they hold or nobody holds', async () => {
  const db = await world();
  const SECOND = 'user_reviewer2';
  await db.insert('members', { subject: SECOND, role: 'reviewer', label: 'second', email: null, grantedBy: OWNER, grantedAt: T0 });
  const [reviewer, editor, submitter] = [await as(db, REVIEWER), await as(db, EDITOR), await as(db, SUBMITTER)];
  const byEditor = await seedDraft(db, { post: post('by-editor'), assignee: EDITOR });
  const bySecond = await seedDraft(db, { post: post('by-second'), submittedBy: SUBMITTER, assignee: SECOND, status: 'approved', approvedBy: SECOND });
  for (const [id, what] of [[byEditor, 'a pending story an editor holds'], [bySecond, 'an approved story another reviewer holds']]) {
    await refused(db, () => spikeCore(db, reviewer, { draftId: id, expectedRev: 1 }, T0, ENV), 'forbidden', `a reviewer spiking ${what}`);
    await refused(db, () => recheckLinksCore(db, reviewer, { draftId: id }, T0, ENV), 'forbidden', `a reviewer asking for a link check on ${what}`);
  }
  const free = await seedDraft(db, { post: post('free'), submittedBy: SUBMITTER });
  const held = await seedDraft(db, { post: post('held'), submittedBy: SUBMITTER, assignee: REVIEWER, status: 'approved', approvedBy: EDITOR });
  eq([(await recheckLinksCore(db, reviewer, { draftId: free }, T0, ENV)).result.ok, (await recheckLinksCore(db, reviewer, { draftId: held }, T0, ENV)).result.ok],
    [true, true], 'a reviewer asks for a link check on an unassigned story and on one they hold');
  eq([(await spikeCore(db, reviewer, { draftId: free, expectedRev: 1 }, T0, ENV)).ok, (await spikeCore(db, reviewer, { draftId: held, expectedRev: 1 }, T0, ENV)).ok],
    [true, true], 'and spikes either');
  eq((await spikeCore(db, editor, { draftId: bySecond, expectedRev: 1 }, T0, ENV)).ok, true, 'an editor spikes a story another reviewer holds');
  for (const status of ['publishing', 'committed', 'live', 'spiked']) {
    const id = await seedDraft(db, { post: post(`check-${status}`), submittedBy: SUBMITTER, status });
    await refused(db, () => recheckLinksCore(db, editor, { draftId: id }, T0, ENV), 'status', `a link check on a ${status} story`);
  }
  await refused(db, () => recheckLinksCore(db, submitter, { draftId: byEditor }, T0, ENV), 'not-found', 'a submitter asking for a link check on a story they did not submit');
});

await section('a machine draft is human-touched once a person changes its story, and not before', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const machine = async (slug) => {
    const verdict = validatePost(post(slug), { mode: 'desk' });
    const row = newDraft({ post: verdict.post, hash: await contentHash(verdict.post), external: false, source: 'machine', submittedBy: 'key:local', assignee: null, now: T0 - 1000 });
    return db.insert('drafts', row);
  };
  const touched = (id) => draftOf(db, id).humanTouched;
  const edited = await machine('edited');
  eq([draftOf(db, edited).source, draftOf(db, edited).machineRev, touched(edited)], ['machine', 1, false], 'a machine draft is born untouched');
  await editCore(db, editor, { draftId: edited, expectedRev: 1, patch: { title: `  ${POST.title}  ` } }, T0, ENV);
  eq(touched(edited), false, 'an edit that changes nothing leaves it untouched');
  eq((await editCore(db, editor, { draftId: edited, expectedRev: 1, patch: { title: 'A human title' } }, T0, ENV)).ok, true, 'an editor changes the title');
  eq(touched(edited), true, 'and it is human-touched');
  eq([(await approveCore(db, editor, { draftId: edited, expectedRev: 2 }, T0, ENV)).result.ok, touched(edited)], [true, true], 'approving it later with no patch keeps it human-touched');
  const patched = await machine('patched');
  eq((await approveCore(db, editor, { draftId: patched, expectedRev: 1, patch: { summary: 'A human summary.' } }, T0, ENV)).result.ok, true, 'approve with a patch that changes the story');
  eq(touched(patched), true, 'makes it human-touched');
  const [plain, same, many] = [await machine('plain'), await machine('same'), await machine('many')];
  await approveCore(db, editor, { draftId: plain, expectedRev: 1 }, T0, ENV);
  await approveCore(db, editor, { draftId: same, expectedRev: 1, patch: { title: POST.title } }, T0, ENV);
  await approveManyCore(db, editor, { items: [{ draftId: many, expectedRev: 1 }] }, T0, ENV);
  eq([plain, same, many].map((id) => [draftOf(db, id).status, touched(id)]), [['approved', false], ['approved', false], ['approved', false]],
    'approve with no patch, approve with a patch that changes nothing, and approveMany leave it untouched');
});

await section('drafts: 600 changes an hour per account, refused in every core that changes a draft', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const seed = (slug, over = {}) => seedDraft(db, { post: post(slug), submittedBy: SUBMITTER, ...over });
  const toggle = await seed('toggle');
  const ids = {
    edit: await seed('edit'), approve: await seed('approve'), many: await seed('many'), take: await seed('take'), spike: await seed('spike'),
    withdraw: await seed('withdraw', { status: 'approved', approvedBy: EDITOR }), reopen: await seed('reopen', { status: 'spiked' }), check: await seed('check'),
  };
  let rev = 1;
  let made = 0;
  for (let i = 0; i < 600; i += 1) {
    const r = await assignCore(db, editor, { draftId: toggle, expectedRev: rev, assignee: i % 2 === 0 ? OWNER : null }, T0 + i, ENV);
    if (r.ok) [rev, made] = [r.rev, made + 1];
  }
  eq([made, db.count('rateEvents')], [600, 600], 'six hundred changes inside one hour, one rate row each');
  const now = T0 + 600;
  const one = { expectedRev: 1 };
  const calls = {
    'drafts:edit': () => editCore(db, editor, { draftId: ids.edit, ...one, patch: { title: 'One too many' } }, now, ENV),
    'drafts:approve': () => approveCore(db, editor, { draftId: ids.approve, ...one }, now, ENV),
    'drafts:approve with a patch': () => approveCore(db, editor, { draftId: ids.approve, ...one, patch: { title: 'One too many' } }, now, ENV),
    'drafts:approveMany': () => approveManyCore(db, editor, { items: [{ draftId: ids.many, ...one }] }, now, ENV),
    'drafts:assign': () => assignCore(db, editor, { draftId: toggle, expectedRev: rev, assignee: OWNER }, now, ENV),
    'drafts:take': () => takeCore(db, editor, { draftId: ids.take, ...one }, now, ENV),
    'drafts:spike': () => spikeCore(db, editor, { draftId: ids.spike, ...one }, now, ENV),
    'drafts:withdraw': () => withdrawCore(db, editor, { draftId: ids.withdraw, ...one }, now, ENV),
    'drafts:reopen': () => reopenCore(db, editor, { draftId: ids.reopen, ...one }, now, ENV),
    'drafts:recheckLinks': () => recheckLinksCore(db, editor, { draftId: ids.check }, now, ENV),
  };
  const waits = [];
  for (const [name, run] of Object.entries(calls)) waits.push((await refused(db, run, 'rate-limited', `the 601st change, ${name}`)).retryAfterMs);
  // The first change (at T0) still counts at T0 + HOUR, so the window has room one millisecond later.
  eq([...new Set(waits)], [HOUR - 599], 'each refusal names the wait until the first change leaves the window');
  eq((await takeCore(db, await as(db, REVIEWER), { draftId: ids.take, ...one }, now, ENV)).ok, true, 'another account is not affected');
  eq((await submitCore(db, editor, { post: post('fresh') }, now, ENV)).ok, true, 'and drafts:submit counts in its own window');
  const reopen = now + waits[0];
  await refused(db, () => editCore(db, editor, { draftId: ids.edit, ...one, patch: { title: 'Nearly' } }, reopen - 1, ENV), 'rate-limited', 'a millisecond before that wait is over');
  eq((await editCore(db, editor, { draftId: ids.edit, ...one, patch: { title: 'An hour on' } }, reopen, ENV)).ok, true, 'once it is over, one more change fits');
  await refused(db, () => approveCore(db, editor, { draftId: ids.approve, ...one }, reopen, ENV), 'rate-limited', 'and only one, because the window slides');
});

await section('desk:queue: 200 per status, recent live and spiked only, a submitter\'s own, desk-mode problems', async () => {
  const db = await world();
  for (let i = 0; i < 201; i += 1) await seedDraft(db, { post: post(`p${i}`), updatedAt: T0 - 1000 - i });
  await seedDraft(db, { post: post('live-new'), status: 'live', updatedAt: T0 - 6 * DAY });
  await seedDraft(db, { post: post('live-old'), status: 'live', updatedAt: T0 - 8 * DAY });
  await seedDraft(db, { post: post('spiked-new'), status: 'spiked', updatedAt: T0 - 29 * DAY });
  await seedDraft(db, { post: post('spiked-old'), status: 'spiked', updatedAt: T0 - 31 * DAY });
  const broken = await seedDraft(db, { post: post('mine'), submittedBy: SUBMITTER, updatedAt: T0 });
  await db.patch('drafts', broken, { post: { ...draftOf(db, broken).post, id: '2026-09-01-mine' } });
  const queue = await queueCore(db, await as(db, EDITOR), {}, T0, ENV);
  const ids = queue.drafts.map((d) => d.storyId);
  eq(queue.drafts.filter((d) => d.status === 'pending').length, 200, 'at most 200 pending, of 202');
  eq(['live-new', 'live-old', 'spiked-new', 'spiked-old'].map((s) => ids.includes(`2026-09-14-${s}`)), [true, false, true, false], 'live older than 7 days and spiked older than 30 days are left out');
  const item = queue.drafts.find((d) => d.draftId === broken);
  eq(item.problems, [{ field: 'id', code: 'id-date' }], 'each draft carries its desk-mode problems');
  eq(Object.keys(item), ['draftId', 'storyId', 'post', 'status', 'assignee', 'rev', 'external', 'source', 'mine', 'submittedAt', 'updatedAt',
    'approvedBy', 'approvedAt', 'publishAfter', 'commitSha', 'linkChecks', 'linkOverride', 'note', 'problems'], 'the fields of section 4.3, in order');
  eq((await queueCore(db, await as(db, SUBMITTER), {}, T0, ENV)).drafts.map((d) => [d.draftId, d.mine]), [[broken, true]], 'a submitter sees only what they submitted');
  const stranger = await as(db, STRANGER);
  db.clearLog();
  eq(await queueCore(db, stranger, {}, T0, ENV), { ok: true, drafts: [] }, 'no role: empty data');
  eq(db.queried('drafts'), false, 'and not one draft is read');
});

await section('desk:queue reads a submitter\'s own drafts through by_submittedBy, however many others share each status', async () => {
  const db = await world();
  const STATES = ['pending', 'approved', 'publishing', 'committed', 'live', 'spiked'];
  const own = [];
  for (const status of STATES) own.push(await seedDraft(db, { post: post(`own-${status}`), submittedBy: SUBMITTER, status, updatedAt: T0 - DAY }));
  await seedDraft(db, { post: post('own-live-old'), submittedBy: SUBMITTER, status: 'live', updatedAt: T0 - 8 * DAY });
  await seedDraft(db, { post: post('own-spiked-old'), submittedBy: SUBMITTER, status: 'spiked', updatedAt: T0 - 31 * DAY });
  for (const status of STATES) for (let i = 0; i < 201; i += 1) await seedDraft(db, { post: post(`${status}-${i}`), status, updatedAt: T0 - i });
  const editorView = (await queueCore(db, await as(db, EDITOR), {}, T0, ENV)).drafts;
  eq([editorView.length, own.filter((id) => editorView.some((d) => d.draftId === id))], [1200, []],
    'an editor reads 200 per status by update, and 201 newer drafts in each status leave every one of the submitter\'s out');
  const submitter = await as(db, SUBMITTER);
  db.clearLog();
  const mine = (await queueCore(db, submitter, {}, T0, ENV)).drafts;
  eq(mine.map((d) => [d.draftId, d.status, d.mine]), own.map((id, i) => [id, STATES[i], true]), 'the submitter still sees their own draft in each status, only theirs, and not the old live or spiked one');
  eq(db.log.map((e) => `${e.table} ${e.index}`), STATES.map(() => 'drafts by_submittedBy'), 'one read per status, through by_submittedBy, never by_status');
  for (let i = 0; i < 201; i += 1) await seedDraft(db, { post: post(`mine-${i}`), submittedBy: SUBMITTER, updatedAt: T0 - 2 * DAY - i });
  const pending = (await queueCore(db, submitter, {}, T0, ENV)).drafts.filter((d) => d.status === 'pending');
  eq([pending.length, pending.every((d, i) => i === 0 || pending[i - 1].updatedAt >= d.updatedAt)], [200, true], 'at most 200 of their own per status, newest update first');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
