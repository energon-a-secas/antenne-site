// Plain node, no install. Run with: make validate
//
// Who may do what (docs/plans/2026-09-15-antenne-desk.md section 4.2), through
// the real cores over the in-memory database in tests/support/fakedb.mjs.
//
// The permission table is written out below a second time, literally. A test
// that imported PERMISSIONS would agree with whatever convex/lib/access.ts
// said, so a widened cell would pass. Every refusal is also held to writing
// nothing, because a Convex mutation that returns a failure still commits the
// writes it made before returning.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import {
  approveCore, approveManyCore, assignCore, editCore, newDraft, overrideLinksCore, queueCore, recheckLinksCore,
  reopenCore, spikeCore, submitCore, takeCore, withdrawCore,
} from '../convex/lib/draftsCore.ts';
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

// ── The contract's table, literally ─────────────────────────────────────────
const ALL = ['owner', 'editor', 'reviewer', 'submitter'];
const TABLE = {
  'queue.read': ALL,
  'draft.submit': ALL,
  'draft.edit': ALL,
  'draft.approve': ['owner', 'editor', 'reviewer'],
  'draft.spike': ALL,
  'draft.withdraw': ['owner', 'editor', 'reviewer'],
  'draft.reopen': ['owner', 'editor'],
  'draft.assign': ['owner', 'editor'],
  'draft.take': ['owner', 'editor', 'reviewer'],
  'draft.overrideLinks': ['owner'],
  'members.manage': ['owner'],
  'settings.read': ['owner', 'editor'],
  'settings.manage': ['owner'],
  'publish.read': ['owner', 'editor', 'reviewer'],
  'publish.trigger': ['owner', 'editor'],
  'access.request': [],
};
const MACHINE_ACTIONS = ['machine.submit', 'machine.status', 'machine.publish'];

const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const OWNER = 'user_owner';
const EDITOR = 'user_editor';
const REVIEWER = 'user_reviewer';
const SUBMITTER = 'user_submitter';
const STRANGER = 'user_stranger';
const OTHER = 'user_other';
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const SUBJECT = { owner: OWNER, editor: EDITOR, reviewer: REVIEWER, submitter: SUBMITTER, none: STRANGER, anon: null };
const CALLERS = ['owner', 'editor', 'reviewer', 'submitter', 'none', 'anon'];
const STATUSES = ['pending', 'approved', 'publishing', 'committed', 'live', 'spiked'];
const POST = Object.freeze({
  id: '2026-09-14-antenne-desk', date: '2026-09-14', kind: 'launch', site: 'dispatch-site', title: 'The desk opens',
  summary: 'Drafts go to a private queue.', body: ['One paragraph.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'],
});
const code = (r) => (r === null || r.ok ? 'ok' : r.code);
const as = (db, subject, env = ENV) => access.resolveCaller(db, subject, env);

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

await section('PERMISSIONS and SCOPES are section 4.2 cell for cell, and frozen', () => {
  eq(Object.fromEntries(Object.entries(access.PERMISSIONS).map(([a, roles]) => [a, [...roles]])), TABLE, 'every action lists exactly the contract\'s roles');
  eq(Object.fromEntries(Object.entries(access.SCOPES).map(([s, actions]) => [s, [...actions]])),
    { submit: ['machine.submit'], status: ['machine.status'], publish: ['machine.publish'] }, 'each machine scope reaches its one machine action');
  eq([Object.isFrozen(access.PERMISSIONS), Object.values(access.PERMISSIONS).every(Object.isFrozen), Object.isFrozen(access.SCOPES), Object.values(access.SCOPES).every(Object.isFrozen)],
    [true, true, true, true], 'the table cannot be changed at run time');
  eq([[...access.ROLES], [...access.MEMBER_ROLES], [...access.ASSIGNABLE_ROLES]],
    [ALL, ['editor', 'reviewer', 'submitter'], ['owner', 'editor', 'reviewer']], 'four roles; owners are never rows; reviewer or above holds a story');
});

await section('authorize answers every caller and every action as the table says', async () => {
  const env = { DESK_OWNERS: OWNER, DESK_DENY: 'user_denied' };
  const db = await world();
  const callers = { anon: { kind: 'anon' }, denied: await as(db, 'user_denied', env) };
  for (const name of ['owner', 'editor', 'reviewer', 'submitter', 'none']) callers[name] = await as(db, SUBJECT[name], env);
  for (const scope of ['submit', 'status', 'publish']) callers[`machine:${scope}`] = access.machineCaller(`k-${scope}`, [scope]);
  callers['machine:all'] = access.machineCaller('k-all', ['submit', 'status', 'publish', 'admin']);
  eq(['owner', 'editor', 'reviewer', 'submitter', 'none', 'denied'].map((n) => callers[n].role), [...ALL, null, null], 'the callers resolve to the roles under test');
  for (const action of [...Object.keys(TABLE), ...MACHINE_ACTIONS]) {
    const machineAction = MACHINE_ACTIONS.includes(action);
    for (const [name, caller] of Object.entries(callers)) {
      let want;
      if (name.startsWith('machine:')) want = machineAction && caller.scopes.includes(action.slice('machine.'.length)) ? 'ok' : 'forbidden';
      else if (machineAction) want = 'forbidden';
      else if (name === 'anon') want = 'not-signed-in';
      else if (action === 'access.request') want = name === 'none' ? 'ok' : 'forbidden';
      else if (name === 'none' || name === 'denied') want = 'not-member';
      else want = TABLE[action].includes(name) ? 'ok' : 'forbidden';
      eq(code(access.authorize(caller, action, env)), want, `${name} ${action}`);
    }
  }
  eq(access.machineCaller('k', ['submit', 'admin', '__proto__', 'constructor']).scopes, ['submit'], 'machineCaller drops scopes it does not know');
  eq(code(access.authorize(callers.editor, 'toString', env)), 'forbidden', 'an action outside the table is refused, never looked up on a prototype');
  eq(access.principalOf(callers['machine:submit']), 'key:k-submit', 'a machine principal is key:<keyId>');
});

await section('resolveCaller: DESK_DENY, then DESK_OWNERS, then a members row, matched exactly', async () => {
  const db = await world();
  await db.insert('members', { subject: 'user_rowowner', role: 'owner', label: 'x', email: null, grantedBy: OWNER, grantedAt: T0 });
  const role = async (subject, env) => {
    const c = await as(db, subject, env);
    return c.kind === 'anon' ? 'anon' : c.role;
  };
  eq([await role(null, ENV), await role('', ENV), await role(undefined, ENV)], ['anon', 'anon', 'anon'], 'no subject is anon');
  eq(await role(OWNER, { DESK_OWNERS: ` user_x ,${OWNER}, ` }), 'owner', 'DESK_OWNERS is comma separated; blanks and spaces are ignored');
  eq(await role(OWNER, { DESK_OWNERS: 'user_owner2,user_owne,USER_OWNER' }), null, 'matched exactly, never by prefix or case');
  eq(await role(OWNER, {}), null, 'an unset DESK_OWNERS makes nobody an owner');
  eq([await role(EDITOR, ENV), await role(REVIEWER, ENV), await role(SUBMITTER, ENV), await role(STRANGER, ENV)],
    ['editor', 'reviewer', 'submitter', null], 'a members row gives its role; no row gives null');
  eq(await role('user_rowowner', ENV), null, 'a row claiming owner gives nothing: owners are never rows');
  eq(await role(OWNER, { DESK_OWNERS: OWNER, DESK_DENY: OWNER }), null, 'DESK_DENY wins over DESK_OWNERS');
  eq(await role(EDITOR, { ...ENV, DESK_DENY: ` ${EDITOR} ` }), null, 'DESK_DENY wins over a members row');
  db.clearLog();
  await as(db, OWNER, ENV);
  eq(db.queried('members'), false, 'an owner is resolved from env alone');
  eq(await as(db, EDITOR, ENV), { kind: 'human', subject: EDITOR, role: 'editor', label: 'editor' }, 'a member carries the label of their row');
  eq((await as(db, 'key:local', ENV)).role, null, 'a key-shaped subject from a token is no machine and holds no role');
});

await section('assertMachineSeparation passes the shipped table, trips on a bad one, and runs at load', async () => {
  const trips = (table) => {
    try {
      access.assertMachineSeparation(table);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  const withScopes = (over) => ({ permissions: access.PERMISSIONS, scopes: { ...access.SCOPES, ...over } });
  eq(trips({ permissions: access.PERMISSIONS, scopes: access.SCOPES }), null, 'the shipped table passes');
  eq(/human action draft\.approve/.test(trips(withScopes({ submit: ['draft.approve'] })) || ''), true, 'a scope that reaches a human action throws');
  eq(/human action members\.manage/.test(trips(withScopes({ publish: ['machine.publish', 'members.manage'] })) || ''), true, 'so does a human action second on a scope');
  eq(trips(withScopes({ status: ['machine.submit'] })) !== null, true, 'two scopes reaching one machine action throws');
  eq(trips({ permissions: access.PERMISSIONS, scopes: { submit: ['machine.submit'], status: [] } }) !== null, true, 'a scope that reaches nothing throws');
  eq(trips(withScopes({ admin: ['machine.admin'] })) !== null, true, 'an unknown scope or machine action throws');
  eq(trips({ permissions: { ...access.PERMISSIONS, 'draft.approve': ['owner', 'publish'] }, scopes: access.SCOPES }) !== null, true, 'a scope name in the human table throws');
  eq(trips({ permissions: { ...access.PERMISSIONS, 'machine.submit': ['owner'] }, scopes: access.SCOPES }) !== null, true, 'a machine action in the human table throws');

  // At load: a copy of access.ts whose submit scope reaches draft.approve fails to import.
  const dir = mkdtempSync(join(tmpdir(), 'antenne-access-'));
  const lib = new URL('../convex/lib/', import.meta.url);
  for (const name of ['owners.ts', 'result.ts']) writeFileSync(join(dir, name), readFileSync(new URL(name, lib)));
  const source = readFileSync(new URL('access.ts', lib), 'utf8');
  const shipped = 'submit: Object.freeze(["machine.submit"] as MachineAction[])';
  eq(source.includes(shipped), true, 'the fixture finds the submit scope in access.ts');
  writeFileSync(join(dir, 'access.ts'), source.replace(shipped, 'submit: Object.freeze(["draft.approve"] as MachineAction[])'));
  let loadError = '';
  try {
    await import(pathToFileURL(join(dir, 'access.ts')).href);
  } catch (err) {
    loadError = err.message;
  }
  rmSync(dir, { recursive: true, force: true });
  eq(/human action draft\.approve/.test(loadError), true, 'importing access.ts with that table throws');
});

// ── Every draft action, caller and state ────────────────────────────────────
// The fixture satisfies each action's extra rule for the caller (their own
// submission for a submitter, assigned to the caller, approved by the caller,
// unassigned for take), so what is left to decide the answer is the role and
// the status. draft.assign and draft.overrideLinks name no status in the
// contract; the desk allows them on pending and approved, and on pending.
const DRAFT_ACTIONS = {
  'draft.edit': [(role) => (role === 'submitter' ? ['pending'] : ['pending', 'approved']), async (db, c, id) => (await editCore(db, c, { draftId: id, expectedRev: 1, patch: { title: 'A sharper title' } }, T0, ENV)).result],
  'draft.approve': [() => ['pending'], async (db, c, id) => (await approveCore(db, c, { draftId: id, expectedRev: 1 }, T0, ENV)).result],
  'draft.spike': [() => ['pending', 'approved'], (db, c, id) => spikeCore(db, c, { draftId: id, expectedRev: 1, note: 'Not news' }, T0, ENV)],
  'draft.withdraw': [() => ['approved'], (db, c, id) => withdrawCore(db, c, { draftId: id, expectedRev: 1 }, T0, ENV)],
  'draft.reopen': [() => ['spiked'], (db, c, id) => reopenCore(db, c, { draftId: id, expectedRev: 1 }, T0, ENV)],
  'draft.assign': [() => ['pending', 'approved'], (db, c, id) => assignCore(db, c, { draftId: id, expectedRev: 1, assignee: REVIEWER }, T0, ENV)],
  'draft.take': [() => ['pending'], (db, c, id) => takeCore(db, c, { draftId: id, expectedRev: 1 }, T0, ENV)],
  'draft.overrideLinks': [() => ['pending'], (db, c, id) => overrideLinksCore(db, c, { draftId: id, expectedRev: 1 }, T0, ENV)],
};
await section('every caller on every draft action in every draft state', async () => {
  let cases = 0;
  for (const [action, [statusesFor, run]] of Object.entries(DRAFT_ACTIONS)) {
    for (const who of CALLERS) {
      for (const status of STATUSES) {
        const db = await world();
        const me = SUBJECT[who];
        const id = await seedDraft(db, {
          status,
          submittedBy: who === 'submitter' ? SUBMITTER : OTHER,
          assignee: action === 'draft.take' ? null : me,
          approvedBy: status === 'pending' ? null : me ?? OTHER,
        });
        const caller = await as(db, me);
        const want = who === 'anon' ? 'not-signed-in' : who === 'none' ? 'not-member' : !TABLE[action].includes(who) ? 'forbidden' : statusesFor(who).includes(status) ? 'ok' : 'status';
        const label = `${who} ${action} on a ${status} draft`;
        eq(code(await run(db, caller, id)), want, label);
        if (want === 'ok') eq([db.rows('drafts')[0].rev, db.count('draftEvents')], [2, 1], `${label}: rev 2 and one draftEvents row`);
        else eq(db.writes(), 0, `${label}: refused, and nothing written`);
        cases += 1;
      }
    }
  }
  eq(cases, 8 * 6 * 6, 'eight draft actions, six callers, six states');
});

await section('queries give a caller with no role empty data; the other cores follow the table', async () => {
  for (const who of CALLERS) {
    const db = await world();
    const draftId = await seedDraft(db, { submittedBy: SUBMITTER });
    const caller = await as(db, SUBJECT[who]);
    const member = who !== 'none' && who !== 'anon';
    const verdict = (action) => (TABLE[action].includes(who) ? 'ok' : 'forbidden');
    const queue = await queueCore(db, caller, {}, T0, ENV);
    eq([queue.ok, queue.drafts.length], [true, member ? 1 : 0], `${who} desk:queue`);
    const list = await listMembersCore(db, caller, {}, T0, ENV);
    eq(member ? code(list) : list, member ? verdict('members.manage') : { ok: true, members: [], owners: [], requests: [] }, `${who} members:list`);
    const people = await assignableCore(db, caller, {}, T0, ENV);
    eq(member ? code(people) : people, member ? verdict('draft.assign') : { ok: true, people: [] }, `${who} members:assignable`);
    const settings = await getSettingsCore(db, caller, {}, T0, ENV);
    eq(member ? code(settings) : settings, member ? verdict('settings.read') : { ok: true, defaultAssignee: null, publishDelayMs: null }, `${who} settings:get`);
    const me = await meCore(db, caller, {}, T0, ENV);
    eq([me.ok, me.signedIn, me.role], [true, who !== 'anon', member ? who : null], `${who} desk:me`);

    const mutations = [
      ['draft.submit', () => submitCore(db, caller, { post: { ...POST, id: '2026-09-14-another-story' } }, T0, ENV)],
      ['draft.approve', async () => (await approveManyCore(db, caller, { items: [] }, T0, ENV)).result],
      ['draft.edit', async () => (await recheckLinksCore(db, caller, { draftId }, T0, ENV)).result],
      ['members.manage', () => grantCore(db, caller, { subject: 'user_newcomer', role: 'reviewer', label: 'Newcomer' }, T0, ENV)],
      ['settings.manage', () => updateSettingsCore(db, caller, { publishDelayMs: 60000 }, T0, ENV)],
      ['access.request', () => requestAccessCore(db, caller, { note: 'Please' }, T0, ENV)],
      ['members.manage', () => revokeCore(db, caller, { subject: EDITOR }, T0, ENV)],
    ];
    for (const [action, run] of mutations) {
      db.resetWrites();
      const want = who === 'anon' ? 'not-signed-in' : action === 'access.request' ? (who === 'none' ? 'ok' : 'forbidden') : member ? verdict(action) : 'not-member';
      const result = await run();
      eq(code(result), want, `${who} ${action}`);
      if (want !== 'ok') eq(db.writes(), 0, `${who} ${action}: refused, and nothing written`);
    }
  }
});

await section('DESK_DENY takes the role from an owner and from a member, everywhere', async () => {
  const env = { DESK_OWNERS: OWNER, DESK_DENY: `${OWNER}, ${EDITOR}` };
  for (const subject of [OWNER, EDITOR]) {
    const db = await world();
    const id = await seedDraft(db, { assignee: subject });
    const caller = await as(db, subject, env);
    eq(caller.role, null, `${subject} resolves to no role`);
    eq((await meCore(db, caller, {}, T0, env)).role, null, `${subject}: desk:me says no role`);
    eq((await queueCore(db, caller, {}, T0, env)).drafts, [], `${subject}: desk:queue is empty`);
    const calls = {
      edit: async () => (await editCore(db, caller, { draftId: id, expectedRev: 1, patch: { title: 'Denied' } }, T0, env)).result,
      approve: async () => (await approveCore(db, caller, { draftId: id, expectedRev: 1 }, T0, env)).result,
      submit: () => submitCore(db, caller, { post: { ...POST, id: '2026-09-14-denied' } }, T0, env),
      grant: () => grantCore(db, caller, { subject: 'user_x1', role: 'editor', label: 'X' }, T0, env),
      settings: () => updateSettingsCore(db, caller, { publishDelayMs: 0 }, T0, env),
    };
    for (const [name, run] of Object.entries(calls)) {
      db.resetWrites();
      eq([code(await run()), db.writes()], ['not-member', 0], `${subject}: ${name} is refused as not-member and writes nothing`);
    }
    db.resetWrites();
    eq([code(await requestAccessCore(db, caller, { note: 'Let me back' }, T0, env)), db.writes()], ['forbidden', 0], `${subject}: a denied account cannot request access either`);
  }
  const db = await world();
  eq(code(await access.checkAssignee(db, EDITOR, { ...ENV, DESK_DENY: EDITOR })), 'bad-subject', 'a denied editor cannot hold a story');
  eq(code(await access.checkAssignee(db, 'owner', { DESK_OWNERS: 'owner' })), 'bad-subject', 'nor can a DESK_OWNERS entry that is no Clerk account id');
  const people = await assignableCore(db, await as(db, OWNER), {}, T0, { ...ENV, DESK_DENY: REVIEWER });
  eq(people.people.map((p) => p.subject), [OWNER, EDITOR], 'nor is a denied reviewer offered as assignable');
});

await section('DESK_FROZEN=1 refuses every mutation with frozen and writes nothing; reads still work', async () => {
  for (const flag of ['1', ' 1\n']) {
    const env = { ...ENV, DESK_FROZEN: flag };
    const db = await world();
    const pending = await seedDraft(db, {});
    const approved = await seedDraft(db, { post: { ...POST, id: '2026-09-14-approved' }, status: 'approved', approvedBy: EDITOR });
    const spiked = await seedDraft(db, { post: { ...POST, id: '2026-09-14-spiked' }, status: 'spiked' });
    await db.insert('accessRequests', { subject: STRANGER, label: 'S', email: null, note: null, requestedAt: T0 });
    const owner = await as(db, OWNER, env);
    const asker = await as(db, 'user_asker', env);
    const rev = { expectedRev: 1 };
    const calls = {
      'drafts:submit': () => submitCore(db, owner, { post: { ...POST, id: '2026-09-14-frozen' } }, T0, env),
      'drafts:edit': async () => (await editCore(db, owner, { draftId: pending, ...rev, patch: { title: 'Frozen' } }, T0, env)).result,
      'drafts:approve': async () => (await approveCore(db, owner, { draftId: pending, ...rev }, T0, env)).result,
      'drafts:approveMany': async () => (await approveManyCore(db, owner, { items: [{ draftId: pending, ...rev }] }, T0, env)).result,
      'drafts:withdraw': () => withdrawCore(db, owner, { draftId: approved, ...rev }, T0, env),
      'drafts:reopen': () => reopenCore(db, owner, { draftId: spiked, ...rev }, T0, env),
      'drafts:take': () => takeCore(db, owner, { draftId: pending, ...rev }, T0, env),
      'drafts:overrideLinks': () => overrideLinksCore(db, owner, { draftId: pending, ...rev }, T0, env),
      'drafts:spike': () => spikeCore(db, owner, { draftId: pending, ...rev }, T0, env),
      'drafts:assign': () => assignCore(db, owner, { draftId: pending, ...rev, assignee: EDITOR }, T0, env),
      'drafts:recheckLinks': async () => (await recheckLinksCore(db, owner, { draftId: pending }, T0, env)).result,
      'members:grant': () => grantCore(db, owner, { subject: 'user_new', role: 'editor', label: 'New' }, T0, env),
      'members:revoke': () => revokeCore(db, owner, { subject: EDITOR }, T0, env),
      'members:requestAccess': () => requestAccessCore(db, asker, { note: 'Hello' }, T0, env),
      'members:dismissRequest': () => dismissRequestCore(db, owner, { subject: STRANGER }, T0, env),
      'settings:update': () => updateSettingsCore(db, owner, { publishDelayMs: 0 }, T0, env),
    };
    eq(Object.keys(calls).length, 16, 'every mutation of section 4.3 outside publish');
    for (const [name, run] of Object.entries(calls)) {
      db.resetWrites();
      eq([code(await run()), db.writes()], ['frozen', 0], `DESK_FROZEN=${JSON.stringify(flag)}: ${name} answers frozen and writes nothing`);
    }
    const me = await meCore(db, owner, {}, T0, env);
    eq([me.ok, me.frozen, me.role], [true, true, 'owner'], 'desk:me still answers, and says frozen');
    eq((await queueCore(db, owner, {}, T0, env)).drafts.length, 3, 'desk:queue still reads');
    eq([code(await listMembersCore(db, owner, {}, T0, env)), code(await assignableCore(db, owner, {}, T0, env)), code(await getSettingsCore(db, owner, {}, T0, env))],
      ['ok', 'ok', 'ok'], 'members:list, members:assignable and settings:get still read');
  }
  for (const flag of ['0', 'true', 'yes', '', undefined, '11']) {
    const env = { ...ENV, DESK_FROZEN: flag };
    const db = await world();
    eq(code(await submitCore(db, await as(db, OWNER, env), { post: POST }, T0, env)), 'ok', `DESK_FROZEN=${JSON.stringify(flag)} does not freeze`);
  }
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
