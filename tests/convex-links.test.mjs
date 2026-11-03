// Plain node, no install. Run with: make validate
//
// Review F24, the part that needs no owner decision (queue #130): "Check links
// again" (drafts:recheckLinks) sends links:check out to every host a desk story
// names, so it counts in draft.recheck, a bucket of its own (20 an hour per
// person, convex/lib/limits.ts), and spends nothing of draft.write's 600. The
// bucket is the person's, not the draft's, so holding many drafts buys no more
// checks. The wrapper refusing and scheduling no links:check is in
// tests/convex-publish-wired.test.mjs, and the desk's wording of the refusal in
// tests/desk-flow-more.test.mjs. Whether links:check should request hosts
// outside neorgon.com at all is still the owner's call (#130).

import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { editCore, newDraft, recheckLinksCore } from '../convex/lib/draftsCore.ts';
import { LIMITS } from '../convex/lib/limits.ts';
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

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const SUBMITTER = 'user_submitter';
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const TABLES = ['members', 'accessRequests', 'drafts', 'draftEvents', 'publishRuns', 'publishedIds', 'settings', 'rateEvents'];
const POST = Object.freeze({
  id: '2026-11-03-links', date: '2026-11-03', kind: 'feature', site: 'antenne-site', title: 'Six links',
  summary: 'A story that links out.', body: ['One paragraph.'], tags: ['desk'],
  links: [{ label: 'Desk', url: 'https://antenne.neorgon.com/desk.html' }, { label: 'Elsewhere', url: 'https://example.org/x' }],
});
const post = (slug) => ({ ...POST, id: `2026-11-03-${slug}` });
const as = (db, subject) => access.resolveCaller(db, subject, ENV);
const buckets = (db, subject) => db.rows('rateEvents').filter((r) => r.bucket.startsWith(`${subject}|`)).map((r) => r.bucket);

async function world() {
  const db = countWrites(createFakeDb());
  for (const [subject, role] of [[EDITOR, 'editor'], [SUBMITTER, 'submitter']]) {
    await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  }
  db.resetWrites();
  return db;
}
async function seedDraft(db, slug) {
  const verdict = validatePost(post(slug), { mode: 'desk' });
  const row = newDraft({ post: verdict.post, hash: await contentHash(verdict.post), external: verdict.external, source: 'desk', submittedBy: SUBMITTER, assignee: null, now: T0 - 1000 });
  const id = await db.insert('drafts', row);
  db.resetWrites();
  return id;
}
/** Runs a recheck that must be refused with `want`, and proves it wrote nothing and asked for no link check. */
async function refused(db, run, want, what) {
  db.resetWrites();
  const before = JSON.stringify(TABLES.map((t) => db.rows(t)));
  const { result, intent } = await run();
  eq([result.ok, result.code, intent, db.writes()], [false, want, null, 0], `${what}: ${want}, no links intent, and nothing written`);
  eq(JSON.stringify(TABLES.map((t) => db.rows(t))) === before, true, `${what}: every table is as it was`);
  return result;
}

await section('drafts:recheckLinks: 20 link checks an hour per person, in a bucket of its own', async () => {
  const db = await world();
  const [editor, submitter] = [await as(db, EDITOR), await as(db, SUBMITTER)];
  const { max, windowMs } = LIMITS['draft.recheck'];
  eq([max, windowMs], [20, HOUR], 'the bucket is 20 an hour, as tests/convex-contract.test.mjs states it');
  const mine = await seedDraft(db, 'mine');
  const intents = [];
  for (let i = 0; i < max; i += 1) {
    const r = await recheckLinksCore(db, submitter, { draftId: mine }, T0 + i, ENV);
    if (r.result.ok) intents.push(r.intent);
  }
  eq([intents.length, intents.every((t) => t.kind === 'links' && t.draftId === mine)], [20, true], 'twenty rechecks by one submitter inside an hour each hand back a links intent');
  eq(buckets(db, SUBMITTER), Array(20).fill(`${SUBMITTER}|draft.recheck`), 'one draft.recheck row each, and none in draft.write');

  const now = T0 + max;
  const r = await refused(db, () => recheckLinksCore(db, submitter, { draftId: mine }, now, ENV), 'rate-limited', 'the 21st recheck in an hour');
  // The first recheck (at T0) still counts at T0 + HOUR, so the window has room one millisecond later.
  eq([r.retryAfterMs, r.message], [HOUR - (max - 1), 'Too many link checks this hour. Try again in 1 hour.'], 'and names the wait until the first recheck leaves the window');

  const edit = await editCore(db, submitter, { draftId: mine, expectedRev: 1, patch: { title: 'Still mine' } }, now, ENV);
  eq([edit.result.ok, edit.result.rev], [true, 2], 'the same person\'s desk changes are not refused: draft.write is a separate window');
  eq(buckets(db, SUBMITTER).filter((b) => b.endsWith('|draft.write')), [`${SUBMITTER}|draft.write`], 'and that edit spends draft.write, not draft.recheck');
  const theirs = await recheckLinksCore(db, editor, { draftId: mine }, now, ENV);
  eq([theirs.result.ok, buckets(db, EDITOR)], [true, [`${EDITOR}|draft.recheck`]], 'another person\'s rechecks are not affected');

  const reopen = now + r.retryAfterMs;
  await refused(db, () => recheckLinksCore(db, submitter, { draftId: mine }, reopen - 1, ENV), 'rate-limited', 'a millisecond before that wait is over');
  eq((await recheckLinksCore(db, submitter, { draftId: mine }, reopen, ENV)).result.ok, true, 'once it is over, one more recheck fits');
  await refused(db, () => recheckLinksCore(db, submitter, { draftId: mine }, reopen, ENV), 'rate-limited', 'and only one, because the window slides');
});

await section('the bucket is the person\'s: rechecks spread over many drafts share the same 20', async () => {
  const db = await world();
  const submitter = await as(db, SUBMITTER);
  const { max } = LIMITS['draft.recheck'];
  const drafts = [];
  for (let i = 0; i < 4; i += 1) drafts.push(await seedDraft(db, `d${i}`));
  let passed = 0;
  for (let i = 0; i < max; i += 1) if ((await recheckLinksCore(db, submitter, { draftId: drafts[i % 4] }, T0 + i, ENV)).result.ok) passed += 1;
  eq(passed, max, 'twenty rechecks spread over four drafts pass');
  for (const id of drafts) await refused(db, () => recheckLinksCore(db, submitter, { draftId: id }, T0 + max, ENV), 'rate-limited', `the next recheck, on ${id}`);
  const fresh = await seedDraft(db, 'fresh');
  await refused(db, () => recheckLinksCore(db, submitter, { draftId: fresh }, T0 + max, ENV), 'rate-limited', 'and on a draft never checked before');
});

await section('a refusal before the bucket is read spends none of it', async () => {
  const db = await world();
  const editor = await as(db, EDITOR);
  const live = await seedDraft(db, 'gone');
  await db.patch('drafts', live, { status: 'live' });
  db.resetWrites();
  const r = await recheckLinksCore(db, editor, { draftId: live }, T0, ENV);
  eq([r.result.code, r.intent, db.count('rateEvents')], ['status', null, 0], 'a recheck on a live story is refused with status and records no rate row');
  const frozen = await recheckLinksCore(db, await access.resolveCaller(db, EDITOR, { ...ENV, DESK_FROZEN: '1' }), { draftId: live }, T0, { ...ENV, DESK_FROZEN: '1' });
  eq([frozen.result.code, db.count('rateEvents')], ['frozen', 0], 'and a frozen desk records none either');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
