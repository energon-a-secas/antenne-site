// ── Desk people: your account, access requests, the People panel ──
// Everyone signed in sees their account id, which is what an owner grants a
// role to. With no role, "Request access" (or "requested" once sent). Owners
// also get the People panel: members, owners, open requests, a grant form with
// a role select, revoke behind a confirm, and the desk settings (default
// assignee, publish delay). Owners are DESK_OWNERS on the deployment and are
// never granted or revoked here.

import { FN, explain } from './desk-api.js';
import { ROLE_TEXT, agoHtml, can, confirmDialog, el, say, sayLater, swap } from './desk-ui.js';
import { escHtml } from './utils.js';

const MEMBER_ROLES = ['editor', 'reviewer', 'submitter'];
const DELAY_MAX_MIN = 30; // PUBLISH_DELAY_MAX_MS in convex/lib/limits.ts, in minutes
const NOTE_MAX = 200;
// convex/lib/membersCore.ts claimLabel stores '' when the token's name fails the text rules (queue #124).
const NO_NAME = 'No name on the account';
const PEOPLE_WORDS = Object.freeze({
  'not-found': 'No member or open request has that account id.',
  invalid: 'A label is 1 to 80 plain characters.',
});
const REQUEST_WORDS = Object.freeze({
  forbidden: 'This account cannot request access to the desk.',
  invalid: 'A note is at most 200 plain characters.',
  'rate-limited': 'At most 3 access requests a day.', // LIMITS["access.request"] in convex/lib/limits.ts
});
const SETTINGS_WORDS = Object.freeze({
  'bad-subject': 'That person can no longer hold stories: pick someone else as the default assignee, or Nobody.',
  'bad-role': 'Only a reviewer, an editor or an owner can be the default assignee.',
  invalid: 'The publish delay is a whole number of minutes from 0 to ' + DELAY_MAX_MIN + '.',
});

const view = { members: null, owners: [], requests: [], people: [], settings: null, dirty: false };
let desk = null;
let loads = 0;

const code = (subject) => '<code class="desk-account__id">' + escHtml(subject) + '</code>';

function renderAccount() {
  const box = el('deskAccount');
  const me = desk.me;
  if (!me || !me.signedIn) { swap(box, ''); return; }
  const label = me.label || desk.label || 'your account';
  const id = code(me.subject) + ' <button type="button" class="btn btn--ghost btn--sm" data-act="copy-id">Copy account id</button>';
  if (me.role) {
    swap(box, '<p>Signed in as <strong>' + escHtml(label) + '</strong>, ' + escHtml(ROLE_TEXT[me.role] || 'a member')
      + '. Your account id is ' + id + '</p>');
    return;
  }
  swap(box, '<p>Signed in as <strong>' + escHtml(label) + '</strong>. Your account id is ' + id + '</p>'
    + (me.requested
      ? '<p class="desk-account__state" data-state="requested">Access requested. An owner can now grant you a role; this page checks again every minute.</p>'
      : '<form class="desk-form" data-form="request">'
        + '<label class="desk-form__field desk-form__field--wide"><span>A note for the owner (optional)</span>'
        + '<textarea name="note" rows="2" maxlength="' + NOTE_MAX + '"></textarea></label>'
        + '<button type="submit" class="btn btn--primary btn--sm">Request access</button></form>'));
}

function memberRow(m) {
  return '<li><strong>' + escHtml(m.label) + '</strong> ' + code(m.subject)
    + ' <span class="desk-chip">' + escHtml(m.role) + '</span>'
    + (m.denied ? ' <span class="desk-chip desk-chip--bad">denied by DESK_DENY</span>' : '')
    + ' <button type="button" class="btn btn--ghost btn--sm" data-act="revoke" data-subject="' + escHtml(m.subject)
    + '" data-label="' + escHtml(m.label) + '">Revoke</button></li>';
}

/** Grant a role carries the label as stored, empty included, so the owner types one rather than NO_NAME. */
function requestRow(r, now) {
  const named = typeof r.label === 'string' && r.label.trim() !== '';
  return '<li>' + (named ? '<strong>' + escHtml(r.label) + '</strong>' : '<strong class="desk-people__unnamed">' + NO_NAME + '</strong>')
    + ' ' + code(r.subject)
    + (r.email ? ' <span>' + escHtml(r.email) + '</span>' : '')
    + (typeof r.requestedAt === 'number' ? ' <span>' + agoHtml(r.requestedAt, now) + '</span>' : '')
    + (r.note ? '<q class="desk-people__note">' + escHtml(r.note) + '</q>' : '')
    + ' <button type="button" class="btn btn--secondary btn--sm" data-act="use-request" data-subject="' + escHtml(r.subject)
    + '" data-label="' + escHtml(r.label) + '">Grant a role</button>'
    + ' <button type="button" class="btn btn--ghost btn--sm" data-act="dismiss" data-subject="' + escHtml(r.subject) + '">Dismiss</button></li>';
}

function settingsForm() {
  const s = view.settings || { defaultAssignee: null, publishDelayMs: 300000 };
  const people = view.people.slice();
  // members:revoke leaves the setting as it was (section 4.3), so the default can be someone who no longer holds stories.
  if (s.defaultAssignee && !people.some((p) => p.subject === s.defaultAssignee)) {
    people.push({ subject: s.defaultAssignee, label: s.defaultAssignee + ' (can no longer hold stories)' });
  }
  const minutes = typeof s.publishDelayMs === 'number' ? Math.round(s.publishDelayMs / 60000) : 5;
  return '<form class="desk-form" data-form="settings">'
    + '<label class="desk-form__field"><span>Default assignee for new stories</span><select name="defaultAssignee">'
    + '<option value="">Nobody</option>'
    + people.map((p) => '<option value="' + escHtml(p.subject) + '"' + (p.subject === s.defaultAssignee ? ' selected' : '') + '>'
      + escHtml(p.label || p.subject) + '</option>').join('')
    + '</select></label>'
    + '<label class="desk-form__field"><span>Publish delay after approval (minutes, 0 to ' + DELAY_MAX_MIN + ')</span>'
    + '<input type="number" name="delay" min="0" max="' + DELAY_MAX_MIN + '" step="1" value="' + escHtml(minutes) + '"></label>'
    + '<button type="submit" class="btn btn--primary btn--sm">Save settings</button></form>';
}

function renderPeople() {
  const now = Date.now();
  const list = (items, row, empty) => (items.length ? '<ul class="desk-people__list">' + items.map(row).join('') + '</ul>'
    : '<p class="desk-people__empty">' + empty + '</p>');
  swap(el('people'), '<section class="card desk-panel" aria-labelledby="membersTitle">'
    + '<h3 id="membersTitle">Members</h3>'
    + list(view.members || [], memberRow, 'Nobody holds a desk role yet.')
    + '<h3>Owners</h3><p class="desk-people__empty">Owners come from DESK_OWNERS on the deployment, so they are changed there, not here.</p>'
    + list(view.owners, (o) => '<li>' + code(o.subject) + (o.denied ? ' <span class="desk-chip desk-chip--bad">denied by DESK_DENY</span>' : '') + '</li>', 'No owner is set.')
    + '</section>'
    + '<section class="card desk-panel" aria-labelledby="requestsTitle">'
    + '<h3 id="requestsTitle">Access requests</h3>'
    + list(view.requests, (r) => requestRow(r, now), 'No open requests.')
    + '<h3>Grant a role</h3>'
    + '<form class="desk-form" data-form="grant">'
    + '<label class="desk-form__field"><span>Account id</span><input type="text" name="subject" placeholder="user_2abc" spellcheck="false"></label>'
    + '<label class="desk-form__field"><span>Label</span><input type="text" name="label" maxlength="80"></label>'
    + '<label class="desk-form__field"><span>Role</span><select name="role">'
    + MEMBER_ROLES.map((r) => '<option value="' + r + '"' + (r === 'reviewer' ? ' selected' : '') + '>' + r + '</option>').join('')
    + '</select></label>'
    + '<button type="submit" class="btn btn--primary btn--sm">Grant</button></form>'
    + '</section>'
    + '<section class="card desk-panel" aria-labelledby="settingsTitle">'
    + '<h3 id="settingsTitle">Settings</h3>' + settingsForm() + '</section>');
}

/** Renders the account readout, and for owners loads and renders the People panel. */
export async function load(ctx, { auto = false } = {}) {
  if (auto && (view.dirty || busyDialog())) return;
  renderAccount();
  if (!ctx.me || !can(ctx.me.role, 'members.manage')) { loads += 1; swap(el('people'), ''); return; }
  const mine = ++loads;
  const gen = ctx.gen;
  const [list, people, settings] = await Promise.all([
    ctx.call(FN.members.list), ctx.call(FN.members.assignable), ctx.call(FN.settings.get),
  ]);
  if (mine !== loads || gen !== ctx.gen) return;
  if (!list.ok) { say(explain(list)); return; }
  view.members = Array.isArray(list.members) ? list.members : [];
  view.owners = Array.isArray(list.owners) ? list.owners : [];
  view.requests = Array.isArray(list.requests) ? list.requests : [];
  view.people = people.ok && Array.isArray(people.people) ? people.people : [];
  view.settings = settings.ok ? { defaultAssignee: settings.defaultAssignee, publishDelayMs: settings.publishDelayMs } : null;
  view.dirty = false;
  renderPeople();
}

/** Forgets the People panel and the account readout, and drops any load still on its way. */
export function clear() {
  loads += 1;
  Object.assign(view, { members: null, owners: [], requests: [], people: [], settings: null, dirty: false });
  swap(el('people'), '');
  swap(el('deskAccount'), '');
}

function busyDialog() {
  const dialog = el('deskDialog');
  return !!(dialog && dialog.open);
}

/** Sends one people or settings mutation, says how it went (unless the account changed meanwhile), then reloads the desk. */
async function send(name, args, okText, words = PEOPLE_WORDS) {
  const tell = sayLater();
  const res = await desk.call(name, args);
  tell(res.ok ? (typeof okText === 'function' ? okText(res) : okText) : explain(res, words));
  if (res.ok) view.dirty = false;
  await desk.refresh();
  return res;
}

async function copyId() {
  const subject = desk.me && desk.me.subject;
  const clip = typeof navigator !== 'undefined' && navigator.clipboard;
  if (!subject || !clip) { say('Select the account id and copy it by hand.'); return; }
  const tell = sayLater();
  try {
    await clip.writeText(subject);
    tell('Account id copied.');
  } catch {
    tell('The browser blocked the copy: select the account id and copy it by hand.');
  }
}

async function onClick(e) {
  const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act]') : null;
  if (!btn) return undefined;
  const { act, subject, label } = btn.dataset;
  if (act === 'copy-id') return copyId();
  if (act === 'dismiss') return send(FN.members.dismissRequest, { subject }, 'Request dismissed.');
  if (act === 'use-request') {
    const form = el('people').querySelector('[data-form="grant"]');
    form.querySelector('[name="subject"]').value = subject;
    form.querySelector('[name="label"]').value = label || '';
    view.dirty = true;
    say('The grant form has that account: pick a role and press Grant.');
    return undefined;
  }
  if (act === 'revoke') {
    const ok = await confirmDialog({
      title: 'Revoke ' + (label || subject) + '?',
      lead: 'They lose their desk role at once. Pending stories they hold move to the default assignee, or to nobody.',
      items: [subject],
      confirm: 'Revoke',
    });
    if (!ok) return undefined;
    return send(FN.members.revoke, { subject }, (res) => 'Revoked ' + (label || subject) + '. Moved ' + Number(res.moved || 0)
      + (res.moved === 1 ? ' story.' : ' stories.') + (res.more ? ' More are still assigned to them: revoke again to move the rest.' : ''));
  }
  return undefined;
}

async function onSubmit(e) {
  const form = e.target;
  if (!form || !form.dataset || !form.dataset.form) return undefined;
  e.preventDefault();
  const value = (name) => { const f = form.querySelector('[name="' + name + '"]'); return f ? String(f.value) : ''; };
  const kind = form.dataset.form;
  if (kind === 'request') {
    const note = value('note').trim();
    return send(FN.members.requestAccess, note ? { note } : {}, 'Access requested. An owner can now grant you a role.', REQUEST_WORDS);
  }
  if (kind === 'grant') {
    const subject = value('subject').trim();
    const label = value('label').trim();
    const role = value('role');
    if (!subject || !label) { say('Give the account id and a label.'); return undefined; }
    return send(FN.members.grant, { subject, role, label }, 'Granted ' + role + ' to ' + label + '.');
  }
  if (kind === 'settings') {
    const minutes = Number(value('delay'));
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > DELAY_MAX_MIN) {
      say('The publish delay is a whole number of minutes from 0 to ' + DELAY_MAX_MIN + '.');
      return undefined;
    }
    // The default assignee goes out only when it was changed, so a stale one still stored never blocks the delay.
    const assignee = value('defaultAssignee') || null;
    const stored = view.settings ? view.settings.defaultAssignee : null;
    const publishDelayMs = minutes * 60000;
    const args = assignee === stored ? { publishDelayMs } : { defaultAssignee: assignee, publishDelayMs };
    return send(FN.settings.update, args, 'Settings saved.', SETTINGS_WORDS);
  }
  return undefined;
}

function onType() {
  view.dirty = true;
}

/** Binds the account and People listeners to the page, once per boot. */
export function mount(ctx) {
  desk = ctx;
  clear();
  for (const id of ['deskAccount', 'people']) {
    el(id).addEventListener('click', onClick);
    el(id).addEventListener('submit', onSubmit);
    el(id).addEventListener('input', onType);
  }
}
