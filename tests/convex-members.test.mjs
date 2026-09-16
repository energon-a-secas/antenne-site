// Plain node, no install. Run with: make validate
//
// People and settings (docs/plans/2026-09-15-antenne-desk.md section 4.3) over
// tests/support/fakedb.mjs: grants and the refusals of a bad subject, role or
// label; revocation moving assigned drafts in batches; access requests and
// their caps; recordRate pruning the rate rows a window no longer counts;
// dismissal; the People panel's reads; settings. Every refusal is held to
// writing nothing.

import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { newDraft } from '../convex/lib/draftsCore.ts';
import { LABEL_MAX, LIMITS, NOTE_MAX, RATE_PRUNE_MAX, REQUESTS_MAX } from '../convex/lib/limits.ts';
import { checkRate, recordRate } from '../convex/lib/rate.ts';
import {
  assignableCore, dismissRequestCore, grantCore, listMembersCore, meCore, requestAccessCore, revokeCore,
} from '../convex/lib/membersCore.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import { getSettingsCore, updateSettingsCore } from '../convex/lib/settingsCore.ts';

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
const DAY = 24 * 60 * 60 * 1000;
const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const REVIEWER = 'user_reviewer';
const SUBMITTER = 'user_submitter';
const STRANGER = 'user_stranger';
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const TABLES = ['members', 'accessRequests', 'drafts', 'draftEvents', 'publishRuns', 'publishedIds', 'settings', 'rateEvents'];
const POST = Object.freeze({
  id: '2026-09-14-antenne-desk', date: '2026-09-14', kind: 'launch', site: 'dispatch-site', title: 'The desk opens',
  summary: 'Drafts go to a private queue.', body: ['One paragraph.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'],
});
const code = (r) => (r.ok ? 'ok' : r.code);
const as = (db, subject, env = ENV) => access.resolveCaller(db, subject, env);

async function world() {
  const db = countWrites(createFakeDb());
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) {
    await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  }
  db.resetWrites();
  return db;
}
async function seedDraft(db, slug, over = {}) {
  const verdict = validatePost({ ...POST, id: `2026-09-14-${slug}` }, { mode: 'desk' });
  const row = newDraft({ post: verdict.post, hash: await contentHash(verdict.post), external: false, source: 'desk', submittedBy: SUBMITTER, assignee: null, now: T0 - 1000 });
  return db.insert('drafts', { ...row, ...over });
}
const setDefault = (db, subject) => db.insert('settings', { key: 'desk', defaultAssignee: subject, publishDelayMs: 300000, updatedBy: OWNER, updatedAt: T0 });
/** Runs a call that must be refused with `want`, and proves it wrote nothing. */
async function refused(db, run, want, what) {
  db.resetWrites();
  const before = JSON.stringify(TABLES.map((t) => db.rows(t)));
  const r = await run();
  eq([r.ok, r.code, db.writes()], [false, want, 0], `${what}: ${want}, and nothing written`);
  eq(JSON.stringify(TABLES.map((t) => db.rows(t))) === before, true, `${what}: every table is as it was`);
  return r;
}

await section('members:grant adds a role, changes it on a second grant, and fulfils a pending request', async () => {
  const db = await world();
  const owner = await as(db, OWNER);
  const nia = 'user_2niaNewcomer';
  eq(await requestAccessCore(db, await as(db, nia), { note: 'I review launches', name: 'Nia Newcomer', email: 'nia@example.com' }, T0, ENV), { ok: true }, 'Nia asks for access');
  eq(await grantCore(db, owner, { subject: nia, role: 'reviewer', label: '  Nia  ' }, T0 + 1, ENV), { ok: true }, 'the owner grants reviewer');
  const row = db.rows('members').find((r) => r.subject === nia);
  eq([row.role, row.label, row.email, row.grantedBy, row.grantedAt], ['reviewer', 'Nia', 'nia@example.com', OWNER, T0 + 1], 'the row: trimmed label, the request\'s email, who granted and when');
  eq(db.rows('accessRequests'), [], 'the request is fulfilled and gone');
  eq((await as(db, nia)).role, 'reviewer', 'her next call resolves the new role');
  eq(await grantCore(db, owner, { subject: nia, role: 'editor', label: 'Nia' }, T0 + 2, ENV), { ok: true }, 'a second grant');
  eq(db.rows('members').filter((r) => r.subject === nia).map((r) => [r.role, r.email]), [['editor', 'nia@example.com']], 'changes the role in the same row, email kept');
});

await section('members:grant refuses a bad subject, an owner, a bad role, a bad label and a non-owner', async () => {
  const db = await world();
  const owner = await as(db, OWNER);
  for (const subject of ['', 'user_', 'usr_2abc', 'user-2abc', 'user_2abc ', 'user_2a-b', 'USER_2abc', 42, null, OWNER]) {
    await refused(db, () => grantCore(db, owner, { subject, role: 'reviewer', label: 'X' }, T0, ENV), 'bad-subject', `subject ${JSON.stringify(subject)}`);
  }
  for (const role of ['owner', 'admin', '', 'Editor', null]) {
    await refused(db, () => grantCore(db, owner, { subject: 'user_2abc', role, label: 'X' }, T0, ENV), 'bad-role', `role ${JSON.stringify(role)}`);
  }
  for (const [label, codes] of [['   ', ['required']], ['x'.repeat(LABEL_MAX + 1), ['too-long']], [`Nia${String.fromCharCode(7)}`, ['chars']], ['ghp_notreal', ['token']]]) {
    const r = await refused(db, () => grantCore(db, owner, { subject: 'user_2abc', role: 'editor', label }, T0, ENV), 'invalid', `label ${JSON.stringify(label)}`);
    eq(r.problems.map((p) => p.code), codes, `label ${JSON.stringify(label)} is named ${codes}`);
  }
  for (const [who, want] of [[EDITOR, 'forbidden'], [STRANGER, 'not-member'], [null, 'not-signed-in']]) {
    const caller = await as(db, who);
    await refused(db, () => grantCore(db, caller, { subject: 'user_2abc', role: 'editor', label: 'X' }, T0, ENV), want, `a grant by ${who}`);
  }
});

await section('members:revoke deletes the row and moves assigned pending drafts 100 at a time', async () => {
  const db = await world();
  const owner = await as(db, OWNER);
  await setDefault(db, EDITOR);
  for (let i = 0; i < 250; i += 1) await seedDraft(db, `p${i}`, { assignee: REVIEWER });
  for (let i = 0; i < 3; i += 1) await seedDraft(db, `a${i}`, { assignee: REVIEWER, status: 'approved', approvedBy: OWNER });
  db.resetWrites();
  eq(await revokeCore(db, owner, { subject: REVIEWER }, T0, ENV), { ok: true, moved: 100, more: true }, 'the first call moves 100 and says there are more');
  eq(db.writes(), 1 + 100 * 2, 'one delete, then a patch and an event per moved draft');
  eq((await as(db, REVIEWER)).role, null, 'the revoked reviewer holds no role from the next call on');
  eq(await revokeCore(db, owner, { subject: REVIEWER }, T0, ENV), { ok: true, moved: 100, more: true }, 'the second call moves 100 more');
  eq(await revokeCore(db, owner, { subject: REVIEWER }, T0, ENV), { ok: true, moved: 50, more: false }, 'the third moves the last 50');
  const drafts = db.rows('drafts');
  eq([drafts.filter((d) => d.status === 'pending' && d.assignee === EDITOR && d.rev === 2).length, drafts.filter((d) => d.status === 'approved' && d.assignee === REVIEWER).length],
    [250, 3], 'every pending draft went to the default assignee with its rev bumped; approved drafts stay');
  const events = db.rows('draftEvents');
  eq([events.length, events.every((e) => e.action === 'assign' && e.actor === OWNER && e.detail.reason === 'revoke' && e.detail.assignee.from === REVIEWER && e.detail.assignee.to === EDITOR)],
    [250, true], 'one assign event per moved draft');
  await refused(db, () => revokeCore(db, owner, { subject: REVIEWER }, T0, ENV), 'not-found', 'a fourth call with nothing left');
  await refused(db, () => revokeCore(db, owner, { subject: 'reviewer' }, T0, ENV), 'bad-subject', 'a subject that is no account id');
  const editor = await as(db, EDITOR);
  await refused(db, () => revokeCore(db, editor, { subject: SUBMITTER }, T0, ENV), 'forbidden', 'an editor revoking');
  await seedDraft(db, 'owner-held', { assignee: OWNER });
  await refused(db, () => revokeCore(db, owner, { subject: OWNER }, T0, ENV), 'bad-subject', 'revoking an owner, who holds no row and leaves through DESK_OWNERS');

  const solo = await world();
  await setDefault(solo, REVIEWER);
  const held = await seedDraft(solo, 'held', { assignee: REVIEWER });
  eq(await revokeCore(solo, await as(solo, OWNER), { subject: REVIEWER }, T0, ENV), { ok: true, moved: 1, more: false }, 'revoking the default assignee themself');
  eq(solo.rows('drafts').find((d) => d._id === held).assignee, null, 'moves their drafts to nobody, never back to them');
  const demoted = await world();
  await setDefault(demoted, SUBMITTER);
  const held2 = await seedDraft(demoted, 'held', { assignee: EDITOR });
  await revokeCore(demoted, await as(demoted, OWNER), { subject: EDITOR }, T0, ENV);
  eq(demoted.rows('drafts').find((d) => d._id === held2).assignee, null, 'and to nobody when the default assignee is below reviewer');
});

await section('members:requestAccess: role null only, 50 open requests, 3 a day, a note of at most 200', async () => {
  const db = await world();
  const ask = async (subject, args = {}, now = T0) => requestAccessCore(db, await as(db, subject), args, now, ENV);
  const answers = [];
  for (let i = 0; i < REQUESTS_MAX; i += 1) answers.push(code(await ask(`user_asker${i}`, { name: `Asker ${i}` }, T0 + i)));
  eq([answers.every((a) => a === 'ok'), db.count('accessRequests')], [true, 50], 'fifty accounts ask');
  const late = await as(db, 'user_asker50');
  await refused(db, () => requestAccessCore(db, late, {}, T0 + 60, ENV), 'queue-full', 'the 51st account');
  eq(code(await ask('user_asker0', { note: 'Second try' }, T0 + 100)), 'ok', 'an account that already asked may ask again at the cap');
  eq([db.count('accessRequests'), db.rows('accessRequests').find((r) => r.subject === 'user_asker0').note], [50, 'Second try'], 'which updates its request instead of adding one');
  eq(code(await ask('user_asker0', {}, T0 + 101)), 'ok', 'a third request in a day');
  const again = await as(db, 'user_asker0');
  await refused(db, () => requestAccessCore(db, again, {}, T0 + 102, ENV), 'rate-limited', 'a fourth in the same day');
  eq(code(await ask('user_asker0', {}, T0 + DAY + 1)), 'ok', 'the next day it may ask again');

  const fresh = await world();
  const denied = { ...ENV, DESK_DENY: 'user_2banned' };
  await refused(fresh, async () => requestAccessCore(fresh, await as(fresh, EDITOR), {}, T0, ENV), 'forbidden', 'a member');
  await refused(fresh, () => requestAccessCore(fresh, { kind: 'anon' }, {}, T0, ENV), 'not-signed-in', 'a signed-out caller');
  await refused(fresh, async () => requestAccessCore(fresh, await as(fresh, 'user_2banned', denied), {}, T0, denied), 'forbidden', 'an account in DESK_DENY');
  const stranger = await as(fresh, 'user_2long');
  const long = await refused(fresh, () => requestAccessCore(fresh, stranger, { note: 'x'.repeat(NOTE_MAX + 1) }, T0, ENV), 'invalid', 'a note over 200 characters');
  eq(long.problems, [{ field: 'note', code: 'too-long' }], 'named too-long');
  await refused(fresh, () => requestAccessCore(fresh, stranger, { note: 'my token is ghp_notreal' }, T0, ENV), 'invalid', 'a note carrying a token');
  eq(code(await requestAccessCore(fresh, stranger, { note: '   ', name: `  ${'N'.repeat(100)}`, email: 'n@example.com' }, T0, ENV)), 'ok', 'a blank note is no note');
  const row = fresh.rows('accessRequests').find((r) => r.subject === 'user_2long');
  eq([row.note, row.label, row.email, row.requestedAt], [null, 'N'.repeat(LABEL_MAX), 'n@example.com', T0], 'label and email are the token claims, trimmed and clipped');
  eq(code(await requestAccessCore(fresh, await as(fresh, 'user_2quiet'), {}, T0, ENV)), 'ok', 'a token with no name or email');
  eq(fresh.rows('accessRequests').find((r) => r.subject === 'user_2quiet').email, null, 'stores no email');
  const me = await meCore(fresh, stranger, {}, T0, ENV);
  eq([me.signedIn, me.role, me.requested], [true, null, true], 'desk:me says requested');
});

await section('recordRate prunes its own bucket\'s aged-out rows, 100 a call, and keeps every row a window still counts', async () => {
  const db = await world();
  const { windowMs } = LIMITS['access.request'];
  const bucket = `${STRANGER}|access.request`;
  const now = T0 + 10 * DAY;
  for (let i = RATE_PRUNE_MAX; i >= 0; i -= 1) await db.insert('rateEvents', { bucket, at: now - windowMs - 1 - i });
  await db.insert('rateEvents', { bucket, at: now - windowMs });
  const others = [{ bucket: `${EDITOR}|access.request`, at: now - windowMs - 1 }, { bucket: `${STRANGER}|draft.write`, at: now - 2 * DAY }];
  for (const row of others) await db.insert('rateEvents', row);
  const mine = () => db.rows('rateEvents').filter((r) => r.bucket === bucket).map((r) => r.at);
  db.resetWrites();
  await recordRate(db, STRANGER, 'access.request', now);
  eq([db.writes(), mine()], [RATE_PRUNE_MAX + 1, [now - windowMs - 1, now - windowMs, now]],
    'one call deletes the 100 oldest aged-out rows and adds its own; the row exactly at the window edge still counts and stays');
  await recordRate(db, STRANGER, 'access.request', now);
  eq(mine(), [now - windowMs, now, now], 'the next call deletes the last aged-out row');
  eq(db.rows('rateEvents').filter((r) => r.bucket !== bucket).map((r) => ({ bucket: r.bucket, at: r.at })), others, 'another account\'s bucket and another limit\'s bucket are left alone');
  eq((await checkRate(db, STRANGER, 'access.request', now)).used, 3, 'and checkRate counts the three rows inside the day');
});

await section('members:dismissRequest', async () => {
  const db = await world();
  await requestAccessCore(db, await as(db, 'user_2asker'), { note: 'Hello' }, T0, ENV);
  const owner = await as(db, OWNER);
  const editor = await as(db, EDITOR);
  await refused(db, () => dismissRequestCore(db, editor, { subject: 'user_2asker' }, T0, ENV), 'forbidden', 'an editor dismissing');
  await refused(db, () => dismissRequestCore(db, owner, { subject: 'user 2asker' }, T0, ENV), 'bad-subject', 'a bad subject');
  eq(await dismissRequestCore(db, owner, { subject: 'user_2asker' }, T0, ENV), { ok: true }, 'the owner dismisses');
  eq(db.count('accessRequests'), 0, 'the request is gone');
  await refused(db, () => dismissRequestCore(db, owner, { subject: 'user_2asker' }, T0, ENV), 'not-found', 'dismissing it again');
});

await section('members:list, members:assignable and desk:me', async () => {
  const env = { DESK_OWNERS: `${OWNER},user_2second,${OWNER}`, DESK_DENY: SUBMITTER };
  const db = await world();
  await requestAccessCore(db, await as(db, 'user_2late', env), {}, T0 + 5, env);
  await requestAccessCore(db, await as(db, 'user_2early', env), {}, T0 + 1, env);
  const list = await listMembersCore(db, await as(db, OWNER, env), {}, T0, env);
  eq(list.members.map((m) => [m.subject, m.role, m.denied]), [[EDITOR, 'editor', false], [REVIEWER, 'reviewer', false], [SUBMITTER, 'submitter', true]], 'members, with DESK_DENY shown');
  eq(list.owners, [{ subject: OWNER, denied: false }, { subject: 'user_2second', denied: false }], 'owners from DESK_OWNERS, once each');
  eq(list.requests.map((r) => r.subject), ['user_2early', 'user_2late'], 'requests, oldest first');
  eq(code(await listMembersCore(db, await as(db, EDITOR, env), {}, T0, env)), 'forbidden', 'an editor cannot list people');
  const people = await assignableCore(db, await as(db, EDITOR, env), {}, T0, env);
  eq(people.people, [{ subject: OWNER, label: null, role: 'owner' }, { subject: 'user_2second', label: null, role: 'owner' },
    { subject: EDITOR, label: 'editor', role: 'editor' }, { subject: REVIEWER, label: 'reviewer', role: 'reviewer' }], 'assignable: owners, editors, reviewers; never a submitter');
  eq(code(await assignableCore(db, await as(db, REVIEWER, env), {}, T0, env)), 'forbidden', 'a reviewer cannot list assignable people');
  eq(await meCore(db, { kind: 'anon' }, {}, T0, env), { ok: true, signedIn: false, subject: null, label: null, role: null, frozen: false, requested: false }, 'desk:me signed out');
  eq(await meCore(db, await as(db, EDITOR, env), {}, T0, env), { ok: true, signedIn: true, subject: EDITOR, label: 'editor', role: 'editor', frozen: false, requested: false }, 'desk:me for a member');
});

await section('settings:get and settings:update', async () => {
  const db = await world();
  const owner = await as(db, OWNER);
  eq(await getSettingsCore(db, await as(db, EDITOR), {}, T0, ENV), { ok: true, defaultAssignee: null, publishDelayMs: 300000 }, 'defaults before any row: nobody, five minutes');
  eq(code(await getSettingsCore(db, await as(db, REVIEWER), {}, T0, ENV)), 'forbidden', 'a reviewer cannot read settings');
  eq(await getSettingsCore(db, await as(db, STRANGER), {}, T0, ENV), { ok: true, defaultAssignee: null, publishDelayMs: null }, 'no role: empty data');
  eq(await updateSettingsCore(db, owner, { defaultAssignee: REVIEWER, publishDelayMs: 0 }, T0, ENV), { ok: true }, 'the owner sets both');
  eq(await getSettingsCore(db, owner, {}, T0, ENV), { ok: true, defaultAssignee: REVIEWER, publishDelayMs: 0 }, 'and reads them back');
  eq(await updateSettingsCore(db, owner, { publishDelayMs: 1800000 }, T0 + 1, ENV), { ok: true }, 'thirty minutes is allowed');
  const row = db.rows('settings');
  eq([row.length, row[0].defaultAssignee, row[0].updatedBy, row[0].updatedAt], [1, REVIEWER, OWNER, T0 + 1], 'one row; a field left out keeps its value');
  for (const ms of [-1, 1800001, 1.5, '60000', null, Infinity]) {
    const r = await refused(db, () => updateSettingsCore(db, owner, { publishDelayMs: ms }, T0, ENV), 'invalid', `publishDelayMs ${String(ms)}`);
    eq(r.problems, [{ field: 'publishDelayMs', code: 'format' }], `publishDelayMs ${String(ms)} is named`);
  }
  await refused(db, () => updateSettingsCore(db, owner, { defaultAssignee: SUBMITTER }, T0, ENV), 'bad-role', 'a submitter as default assignee');
  await refused(db, () => updateSettingsCore(db, owner, { defaultAssignee: STRANGER }, T0, ENV), 'bad-subject', 'an account with no role');
  eq(await updateSettingsCore(db, owner, { defaultAssignee: null }, T0, ENV), { ok: true }, 'nobody is allowed');
  const editor = await as(db, EDITOR);
  await refused(db, () => updateSettingsCore(db, editor, { publishDelayMs: 0 }, T0, ENV), 'forbidden', 'an editor updating');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
