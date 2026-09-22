// Plain node, no install. Run with: make validate
//
// People and settings (docs/plans/2026-09-15-antenne-desk.md section 4.3) over
// tests/support/fakedb.mjs: grants and the refusals of a bad subject, role or
// label; revocation moving assigned drafts in batches; access requests and
// their caps; recordRate pruning the rate rows a window no longer counts;
// dismissal; the People panel's reads; settings. Every refusal is held to
// writing nothing. Last, a sweep of every public wrapper in convex/*.ts: the
// env each copies from process.env, and the caller taken only from the token.

import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

  const own = await world();
  await setDefault(own, EDITOR);
  const mine = await seedDraft(own, 'editors-own', { assignee: REVIEWER, submittedBy: EDITOR });
  const theirs = await seedDraft(own, 'someone-elses', { assignee: REVIEWER });
  eq(await revokeCore(own, await as(own, OWNER), { subject: REVIEWER }, T0, ENV), { ok: true, moved: 2, more: false }, 'revoking the holder of a story the default assignee submitted');
  eq([mine, theirs].map((id) => own.rows('drafts').find((d) => d._id === id).assignee), [null, EDITOR], 'that story goes to nobody, never to the person who submitted it; the other goes to the default assignee');
  eq(own.rows('draftEvents').map((e) => [e.draftId, e.detail.assignee.to]), [[mine, null], [theirs, EDITOR]], 'and each assign event names where its own story went');
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

  // Any Neorgon account sets its own name, and the owner's People panel shows it and prefills Grant with it.
  const [RLO, PDF, BEL] = [0x202e, 0x202c, 7].map((c) => String.fromCharCode(c));
  const claims = [
    [`${RLO}renwo eht${PDF}`, 'bidi@example.com'], ['Line one\nLine two', 'a b@example.com'], [`Bell${BEL}`, `x@example.com${RLO}`],
    ['sk-ant-notreal', 'no-at-sign'], ['   ', `${'x'.repeat(250)}@e.com`], ['Nía Ñandú', 'ghp_notreal@example.com'], ['Ada', ' ada@example.com '],
  ];
  const stored = [];
  for (const [i, [name, email]] of claims.entries()) {
    eq(code(await requestAccessCore(fresh, await as(fresh, `user_2claim${i}`), { name, email }, T0, ENV)), 'ok', `claims ${JSON.stringify([name, email])}: the request is still taken`);
    const row = fresh.rows('accessRequests').find((r) => r.subject === `user_2claim${i}`);
    stored.push([row.label, row.email]);
  }
  eq(stored, [['', 'bidi@example.com'], ['', null], ['', null], ['', null], ['', null], ['Nía Ñandú', null], ['Ada', 'ada@example.com']],
    'a name with bidi, control or token-like text is stored as no label; an email with spaces, bidi, no @, over 254 or token-like text as no email; each on its own');
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

// ── The public wrappers themselves: their env, and the caller only from the token ──
// Every section above hands the cores an env object. These load each convex/*.ts
// that exports a query, mutation or action, through stand-ins for convex/values
// and convex/_generated (neither exists without an install or a deployment; the
// same stand-ins as tests/convex-publish-wired.test.mjs, with internal functions
// marked apart), and sweep every public export. Arguments come from the export's
// own validators with every string set to an owner's subject, so a wrapper that
// stops copying DESK_OWNERS, DESK_DENY or DESK_FROZEN from process.env, or that
// takes the caller from an argument, answers differently and this turns red.
const STAND_INS = {
  'convex/values': 'export const v = new Proxy({}, { get: (_, kind) => (...args) => ({ kind, args }) });',
  './_generated/server': 'const reg = (kind) => (def) => ({ ...def, kind }); export const query = reg("query"); export const mutation = reg("mutation"); export const action = reg("action"); export const internalQuery = reg("internal"); export const internalMutation = reg("internal"); export const internalAction = reg("internal"); export const httpAction = (fn) => ({ kind: "http", run: fn });',
  './_generated/api': 'const ref = (p) => new Proxy({ name: p.join(":") }, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : k in t ? t[k] : ref([...p, k])) }); export const internal = ref([]);',
};
registerHooks({
  resolve(specifier, context, next) {
    const stand = STAND_INS[specifier];
    if (stand && (!specifier.startsWith('.') || /\/convex\/[^/]+\.ts$/.test(context.parentURL ?? ''))) return { url: `data:text/javascript,${encodeURIComponent(stand)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const CONVEX = new URL('../convex/', import.meta.url);
const PUBLIC = [];
for (const file of readdirSync(CONVEX).filter((f) => f.endsWith('.ts')).sort()) {
  if (!/^export\s+const\s+\w+\s*=\s*(query|mutation|action)\s*\(/m.test(readFileSync(new URL(file, CONVEX), 'utf8'))) continue;
  for (const [name, fn] of Object.entries(await import(new URL(file, CONVEX).href))) {
    if (['query', 'mutation', 'action'].includes(fn?.kind)) PUBLIC.push({ name: `${file.slice(0, -3)}:${name}`, fn });
  }
}
/** A value for one stand-in validator: every string an owner's subject, every id a real row. */
function valueFor(validator, ids) {
  const [kind, a] = [validator.kind, validator.args];
  if (kind === 'string') return OWNER;
  if (kind === 'id' && ids[a[0]]) return ids[a[0]];
  if (kind === 'number') return 1;
  if (kind === 'boolean') return true;
  if (kind === 'null') return null;
  if (kind === 'any') return { subject: OWNER, submittedBy: OWNER, assignee: OWNER };
  if (kind === 'optional') return valueFor(a[0], ids);
  if (kind === 'union') return valueFor(a.find((o) => o.kind !== 'null') ?? a[0], ids);
  if (kind === 'array') return [valueFor(a[0], ids)];
  if (kind === 'object') return Object.fromEntries(Object.entries(a[0]).map(([k, x]) => [k, valueFor(x, ids)]));
  throw new Error(`the sweep has no value for v.${kind}(${a.map((x) => JSON.stringify(x)).join(', ')})`);
}
/** An answer that says nothing about the desk: every field null, false or empty, bar signedIn and the caller's own subject. */
const empty = (r, subject) => r.ok === true && Object.entries(r).every(([k, x]) => k === 'ok' || k === 'signedIn' || x === null || x === false || (Array.isArray(x) && x.length === 0) || (k === 'subject' && x === subject));
/** Calls one public function in a fresh world as `subject` (null: no token) under `env`; returns its answer, writes and schedules. */
async function call({ fn }, subject, env) {
  const db = Object.assign(await world(), { normalizeId: (table, id) => (typeof id === 'string' && id.startsWith(`${table}:`) ? id : null) });
  const ids = { drafts: await seedDraft(db, 'sweep') };
  await db.insert('accessRequests', { subject: 'user_2asker', label: 'Asker', email: null, note: null, requestedAt: T0 });
  db.resetWrites();
  const before = JSON.stringify(Object.keys(db.schema).map((t) => db.rows(t)));
  const scheduled = [];
  const record = async (...a) => { scheduled.push(a.length); };
  const ctx = { db, auth: { getUserIdentity: async () => (subject === null ? null : { subject, name: 'Some Name', email: 'some@example.com' }) }, scheduler: { runAfter: record, runAt: record } };
  const saved = Object.fromEntries(['DESK_OWNERS', 'DESK_DENY', 'DESK_FROZEN'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { DESK_OWNERS: OWNER, DESK_DENY: '', DESK_FROZEN: '' }, env);
  let answer;
  try {
    answer = await fn.handler(ctx, Object.fromEntries(Object.entries(fn.args ?? {}).map(([k, x]) => [k, valueFor(x, ids)])));
  } catch (err) {
    answer = { threw: String(err && err.message) };
  } finally {
    for (const [k, x] of Object.entries(saved)) if (x === undefined) delete process.env[k]; else process.env[k] = x;
  }
  const quiet = db.writes() === 0 && scheduled.length === 0 && JSON.stringify(Object.keys(db.schema).map((t) => db.rows(t))) === before;
  return { answer, quiet };
}
const GUARDS = ['not-signed-in', 'not-member', 'frozen'];
const NOBODY = 'user_2nobody';
const PASSES = [
  ['an owner, neither denied nor frozen (the control: every call gets past the guards, every read shows something)', OWNER, {},
    (r) => !r.threw && !GUARDS.includes(r.code), (r) => !empty(r, OWNER), () => false],
  ['an owner listed in DESK_DENY: role null, so not-member and empty reads', OWNER, { DESK_DENY: OWNER },
    (r, name) => r.code === (name === 'members:requestAccess' ? 'forbidden' : 'not-member'), (r) => empty(r, OWNER), () => true],
  ['an owner while DESK_FROZEN=1: every change answers frozen, reading still works', OWNER, { DESK_FROZEN: '1' },
    (r) => r.code === 'frozen', (r, name) => !empty(r, OWNER) && (name !== 'desk:me' || r.frozen === true), () => true],
  ['no token, every string argument an owner\'s subject: not-signed-in and empty reads', null, {},
    (r) => r.code === 'not-signed-in', (r) => empty(r, null), () => true],
  ['a signed-in account with no role and the same arguments: not-member (it may only ask for access) and empty reads', NOBODY, {},
    (r, name) => (name === 'members:requestAccess' ? r.ok === true : r.code === 'not-member'), (r) => empty(r, NOBODY), (name) => name !== 'members:requestAccess'],
];
await section('the public wrappers read DESK_OWNERS, DESK_DENY and DESK_FROZEN from process.env and the caller only from the token', async () => {
  const names = PUBLIC.map((p) => p.name);
  const SECTION_4_3 = ['desk:me', 'desk:queue', ...['submit', 'edit', 'approve', 'approveMany', 'withdraw', 'reopen', 'take', 'overrideLinks', 'spike', 'assign', 'recheckLinks'].map((n) => `drafts:${n}`),
    ...['list', 'assignable', 'grant', 'revoke', 'requestAccess', 'dismissRequest'].map((n) => `members:${n}`), 'settings:get', 'settings:update', 'publish:status', 'publish:now', 'publish:retry'];
  eq(SECTION_4_3.filter((n) => !names.includes(n)), [], `the sweep reaches every section 4.3 function (${names.length} public functions found)`);
  for (const [what, subject, env, changes, reads, quietWanted] of PASSES) {
    const [wrong, loud] = [[], []];
    for (const p of PUBLIC) {
      const { answer, quiet } = await call(p, subject, env);
      const good = p.fn.kind === 'query' ? answer.ok === true && reads(answer, p.name) : changes(answer, p.name);
      if (!good) wrong.push(`${p.name} ${JSON.stringify(answer).slice(0, 160)}`);
      if (quietWanted(p.name) && !quiet) loud.push(p.name);
    }
    eq(wrong, [], `${what}: every answer`);
    eq(loud, [], `${what}: nothing written and nothing scheduled`);
  }
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
