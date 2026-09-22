// ── Desk lanes: the queue by who holds each story ────────────
// desk:queue, split into the lanes of section 7: Assigned to you, Unassigned,
// With others, Approved, Committed and live, Spiked. Each card offers only
// what the caller's role may do to it (the server refuses the rest anyway),
// and every draft mutation sends the rev the card was drawn at as
// expectedRev, so a story someone else changed meanwhile comes back stale:
// the desk then reloads the queue and says so. "Approve all shown" lists
// every title in a dialog before it sends drafts:approveMany; "New story"
// sends drafts:submit. A card open in the editor offers only the editor's
// Save, Save and approve, and Cancel, and Approve all leaves it out: what
// either approves is then always the text on screen.

import { FN, explain } from './desk-api.js';
import {
  actButton, agoHtml, can, clock, confirmDialog, draftCard, editorHtml, el, linksBlocked, postToValues, refreshEditor, say,
  sayLater, swap, untilHtml, valuesToPost,
} from './desk-ui.js';
import { validatePost } from './schema.js';
import { escHtml } from './utils.js';

const APPROVE_MANY_MAX = 25; // convex/lib/limits.ts
const ANY = ['owner', 'editor', 'reviewer', 'submitter'];
// Once the newest run failed, reconcile queues nothing for due approvals (plan section 6.1, amended 2026-09-21).
const WAITING = 'Waiting: the last publish run failed, so this goes out once an owner or an editor presses Retry';
const ASSIGN_WORDS = Object.freeze({
  'bad-subject': 'That person can no longer hold stories. The desk reloaded the list: pick someone else.',
  'bad-role': 'Only a reviewer, an editor or an owner can hold a story.',
});
const pending = (d) => d.status === 'pending';

/**
 * A submitter also sees With others: the stories there are their own, held by
 * a reviewer, and nowhere else would show them. Nobody but a reviewer or up
 * can hold a story, so a submitter has no Assigned to you.
 */
export const LANES = Object.freeze([
  { key: 'mine', title: 'Assigned to you', roles: ['owner', 'editor', 'reviewer'],
    lead: 'Stories you hold: approve, edit or spike them.',
    has: (d, me) => pending(d) && d.assignee === me.subject },
  { key: 'free', title: 'Unassigned', roles: ANY,
    lead: 'Nobody holds these yet. Take one, or approve it as it is.',
    has: (d) => pending(d) && d.assignee === null },
  { key: 'others', title: 'With others', roles: ['owner', 'editor', 'submitter'],
    lead: 'Stories someone else holds.',
    has: (d, me) => pending(d) && d.assignee !== null && d.assignee !== me.subject },
  { key: 'approved', title: 'Approved', roles: ANY,
    lead: 'Each publishes by itself once its delay has passed. Withdraw one before then to stop it.',
    has: (d) => d.status === 'approved' || d.status === 'publishing' },
  { key: 'done', title: 'Committed and live', roles: ANY,
    lead: 'In data/posts.json, then seen on the live site. A live story stays here for 7 days.',
    has: (d) => d.status === 'committed' || d.status === 'live' },
  { key: 'spiked', title: 'Spiked', roles: ANY,
    lead: 'Stories that will not run. Shown for 30 days.',
    has: (d) => d.status === 'spiked' },
]);

// me is the caller the drafts were fetched for: a queue is drawn only against
// the caller it was read as, never against whoever desk:me says came after.
// choices: an Assign to pick not yet sent, by draftId, kept across a redraw.
const view = { me: null, drafts: [], people: [], editing: null, creating: null, choices: new Map() };
const NOBODY = Object.freeze({ role: null, subject: null });
let desk = null;
let loads = 0;

/** What the caller may do to one draft: the server's rules (convex/lib/draftsCore.ts), mirrored. */
export function allowed(d, me) {
  const r = me.role;
  const s = me.subject;
  const open = pending(d) || d.status === 'approved';
  const holdsOrFree = r !== 'reviewer' || d.assignee === null || d.assignee === s;
  const own = r !== 'submitter' || d.mine === true;
  return {
    edit: can(r, 'draft.edit') && open && (r !== 'reviewer' || d.assignee === s) && (r !== 'submitter' || (d.mine === true && pending(d))),
    approve: can(r, 'draft.approve') && pending(d) && (r === 'owner' || d.mine !== true) && holdsOrFree
      && !(r === 'reviewer' && d.external === true) && !linksBlocked(d),
    take: can(r, 'draft.take') && pending(d) && d.assignee === null,
    spike: can(r, 'draft.spike') && open && holdsOrFree && own,
    withdraw: can(r, 'draft.withdraw') && d.status === 'approved' && (r !== 'reviewer' || d.approvedBy === s),
    reopen: can(r, 'draft.reopen') && d.status === 'spiked',
    assign: can(r, 'draft.assign') && open,
    override: can(r, 'draft.overrideLinks') && pending(d) && linksBlocked(d),
    recheck: can(r, 'draft.edit') && open && holdsOrFree && own,
  };
}

const titleOf = (d) => (d && d.post && typeof d.post.title === 'string' && d.post.title.trim() ? d.post.title.trim() : (d && d.storyId) || 'this story');
const find = (draftId) => view.drafts.find((d) => d.draftId === draftId) || null;

function labelOf(subject) {
  const person = view.people.find((p) => p.subject === subject);
  return person && person.label ? person.label : subject;
}

function whoText(d, me) {
  const held = d.assignee === null ? 'Unassigned' : d.assignee === me.subject ? 'Assigned to you' : 'Assigned to ' + labelOf(d.assignee);
  return held + (d.mine === true ? ', submitted by you' : '');
}

/** The card's time line, as markup: the times in it stay current without a redraw (desk-ui stampTimes). */
function whenHtml(d, now) {
  if (d.status === 'approved' && typeof d.publishAfter === 'number') {
    if (d.publishAfter > now) return escHtml('Publishes after ' + clock(d.publishAfter) + ' (') + untilHtml(d.publishAfter, now) + ')';
    return escHtml(desk && desk.runFailed === true ? WAITING : 'Due: it goes out with the next publish run');
  }
  if (d.status === 'publishing') return escHtml('Publishing now: a run has claimed it');
  if (d.status === 'committed') return escHtml('Committed' + (typeof d.commitSha === 'string' ? ' as ' + d.commitSha.slice(0, 7) : '') + ', waiting to show on the live site');
  if (d.status === 'live') return escHtml('Live on dispatch.neorgon.com');
  if (typeof d.submittedAt === 'number') return escHtml('Submitted ') + agoHtml(d.submittedAt, now);
  return '';
}

/** Why a reviewer or up cannot approve a pending story, when the reason is one they can act on. */
function blockedNote(d, me, a) {
  if (!pending(d) || a.approve || !can(me.role, 'draft.approve')) return '';
  if (d.mine === true && me.role !== 'owner') return 'You submitted this story, so someone else approves it.';
  if (me.role === 'reviewer' && d.external === true) return 'It links outside neorgon.com, so an editor or an owner approves it.';
  if (linksBlocked(d)) return 'A link is broken: fix it, or an owner overrides the check.';
  return '';
}

/** The Assign to select, and the button that sends it: browsing the names with the keyboard sends nothing. */
function assignHtml(d) {
  const people = view.people.slice();
  if (d.assignee !== null && !people.some((p) => p.subject === d.assignee)) people.push({ subject: d.assignee, label: null });
  const chosen = view.choices.has(d.draftId) ? view.choices.get(d.draftId) : d.assignee || '';
  return '<label class="desk-assign"><span>Assign to</span><select data-act="assign" data-draft="' + escHtml(d.draftId)
    + '" data-rev="' + escHtml(d.rev) + '"><option value=""' + (chosen === '' ? ' selected' : '') + '>Nobody</option>'
    + people.map((p) => '<option value="' + escHtml(p.subject) + '"' + (p.subject === chosen ? ' selected' : '') + '>'
      + escHtml(p.label || p.subject) + '</option>').join('')
    + '</select></label>' + actButton('assign-go', 'Assign', d);
}

function cardFor(d, me, now) {
  const a = allowed(d, me);
  const editing = view.editing && view.editing.draftId === d.draftId ? view.editing : null;
  // While the editor is open its own buttons are the card's only controls: an Approve here would approve the
  // stored text under a preview of the edit, and Take, Spike or Assign would make the next Save stale.
  const b = [];
  if (!editing) {
    if (a.approve) b.push(actButton('approve', 'Approve', d, 'primary'));
    if (a.take) b.push(actButton('take', 'Take', d));
    if (a.edit) b.push(actButton('edit', 'Edit', d));
    if (a.withdraw) b.push(actButton('withdraw', 'Withdraw', d));
    if (a.reopen) b.push(actButton('reopen', 'Reopen', d));
    if (a.override) b.push(actButton('override', 'Override the link check', d));
    if (a.recheck && d.post && Array.isArray(d.post.links) && d.post.links.length) b.push(actButton('recheck', 'Check links again', d, 'ghost'));
    if (a.spike) b.push(actButton('spike', 'Spike', d, 'ghost'));
    if (a.assign) b.push(assignHtml(d));
  }
  const editor = editing ? editorHtml(d.draftId, editing.values,
    actButton('save', 'Save', d, 'primary') + (a.approve ? actButton('save-approve', 'Save and approve', d) : '')
    + actButton('cancel-edit', 'Cancel', d, 'ghost')) : '';
  const shown = editing ? { ...d, post: valuesToPost(editing.values) } : d;
  return draftCard(shown, { who: whoText(d, me), when: whenHtml(d, now), note: blockedNote(d, me, a), actions: b.join(''), editor });
}

function laneHtml(lane, items, me, now) {
  return '<section class="desk-lane" data-lane="' + lane.key + '" aria-labelledby="lane-' + lane.key + '">'
    + '<div class="desk-lane__head"><h3 class="desk-lane__title" id="lane-' + lane.key + '">' + escHtml(lane.title) + '</h3>'
    + '<span class="desk-lane__count">' + items.length + '</span></div>'
    + '<p class="desk-lane__lead">' + escHtml(lane.lead) + '</p>'
    + (items.length
      ? '<div class="stack stack--tight">' + items.map((d) => cardFor(d, me, now)).join('') + '</div>'
      : '<p class="desk-lane__empty">Nothing here.</p>')
    + '</section>';
}

function lanesFor(me) {
  return LANES.filter((lane) => lane.roles.includes(me.role));
}

/** The pending stories on show that the caller may approve, in lane order; never one open in the editor. */
export function approvable() {
  const me = view.me;
  if (!me || !me.role) return [];
  const open = view.editing ? view.editing.draftId : null;
  return lanesFor(me).flatMap((lane) => view.drafts.filter((d) => pending(d) && lane.has(d, me) && allowed(d, me).approve && d.draftId !== open));
}

function today() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

function renderNew() {
  const box = el('newStory');
  if (!view.creating) { swap(box, ''); box.hidden = true; return; }
  const buttons = '<button type="button" class="btn btn--primary btn--sm" data-act="submit-new">Submit to the desk</button>'
    + '<button type="button" class="btn btn--ghost btn--sm" data-act="cancel-new">Cancel</button>';
  swap(box, '<div class="card desk-new"><h3 class="desk-new__title">New story</h3>' + editorHtml('new', view.creating, buttons) + '</div>');
  box.hidden = false;
}

export function render() {
  const me = view.me || NOBODY;
  const now = Date.now();
  swap(el('lanes'), lanesFor(me).map((lane) => laneHtml(lane, view.drafts.filter((d) => lane.has(d, me)), me, now)).join(''));
  const n = Math.min(approvable().length, APPROVE_MANY_MAX);
  const all = el('approveAllBtn');
  all.hidden = !can(me.role, 'draft.approve');
  all.disabled = n === 0;
  all.textContent = n ? 'Approve all shown (' + n + ')' : 'Approve all shown';
  el('newStoryBtn').hidden = !can(me.role, 'draft.submit') || !!view.creating;
  renderNew();
}

/** Draws the queue on show again, as the status bar does when the last run fails or recovers; not under an open form. */
export function redraw() {
  if (view.me && !busy()) render();
}

/** True while leaving the page alone matters more than a fresh queue: an open editor, a new story, the dialog. */
export function busy() {
  const dialog = el('deskDialog');
  return !!view.editing || !!view.creating || !!(dialog && dialog.open);
}

/** Loads the queue (and, for owners and editors, who can hold a story), then renders. */
export async function load(ctx, { auto = false } = {}) {
  if (!ctx.me || !ctx.me.role) { clear(); return; }
  if (auto && busy()) return;
  const mine = ++loads;
  const gen = ctx.gen;
  const me = ctx.me;
  const [queue, people] = await Promise.all([
    ctx.call(FN.desk.queue),
    can(me.role, 'draft.assign') ? ctx.call(FN.members.assignable) : Promise.resolve(null),
  ]);
  if (mine !== loads || gen !== ctx.gen) return;
  if (!queue.ok) { say(explain(queue)); return; }
  view.me = me;
  view.drafts = Array.isArray(queue.drafts) ? queue.drafts : [];
  view.people = people && people.ok && Array.isArray(people.people) ? people.people : [];
  if (view.editing && !find(view.editing.draftId)) view.editing = null;
  render();
}

/** Forgets the queue and whoever it was read for, drops any load still on its way, and hides Approve all and New story. */
export function clear() {
  loads += 1;
  view.me = null;
  view.drafts = [];
  view.people = [];
  view.editing = null;
  view.creating = null;
  view.choices.clear();
  render();
}

async function reload() {
  await load(desk);
}

/** Sends one draft mutation, says how it went (unless the account changed meanwhile), and reloads the queue either way. */
async function mutate(name, args, okText, words = {}) {
  const tell = sayLater();
  const res = await desk.call(name, args);
  tell(res.ok ? (typeof okText === 'function' ? okText(res) : okText) : explain(res, words));
  await reload();
  if (res.ok && desk.changed) await desk.changed();
  return res;
}

const approvedText = (title) => (res) => 'Approved "' + title + '".'
  + (typeof res.publishAfter === 'number' ? ' It publishes after ' + clock(res.publishAfter) + '.' : '');

async function save(andApprove) {
  const ed = view.editing;
  if (!ed) return;
  const post = valuesToPost(ed.values);
  if (!validatePost(post, { mode: 'desk' }).ok) { say('Fix the problems listed under the form first.'); return; }
  const args = { draftId: ed.draftId, expectedRev: ed.rev, patch: post };
  const was = find(ed.draftId);
  const tell = sayLater();
  const res = await desk.call(andApprove ? FN.drafts.approve : FN.drafts.edit, args);
  if (res.ok) {
    view.editing = null;
    const back = was && was.status === 'approved' ? ' Editing took back its approval: approve it again to publish it.' : '';
    tell(andApprove ? approvedText(post.title)(res) : res.rev === ed.rev ? 'Nothing changed, so nothing was saved.' : 'Saved "' + post.title + '" as rev ' + res.rev + '.' + back);
  } else if (res.code === 'stale' && !res.retried) {
    tell('Someone changed this story while you were editing. Your text is still in the form: save again to replace their version, or cancel to see it.');
  } else {
    tell(explain(res));
  }
  await reload();
  if (res.code === 'stale' && view.editing) {
    const fresh = find(ed.draftId);
    if (fresh) view.editing.rev = fresh.rev;
    render();
  }
  if (res.ok && desk.changed) await desk.changed();
}

async function submitNew() {
  const post = valuesToPost(view.creating || {});
  if (!validatePost(post, { mode: 'desk' }).ok) { say('Fix the problems listed under the form first.'); return; }
  const tell = sayLater();
  const res = await desk.call(FN.drafts.submit, { post });
  if (res.ok) {
    view.creating = null;
    tell('Submitted "' + post.title + '" as ' + res.storyId + '. It waits on the desk for a reviewer.');
  } else {
    // queue-full here is the per-person cap on pending stories, not the access-request queue.
    const cap = Number.isInteger(res.max) ? String(res.max) : 'too many';
    tell(explain(res, { 'queue-full': 'You already have ' + cap + ' stories waiting on the desk. Submit this one once a reviewer decides one of them.' }));
  }
  await reload();
}

async function approveAll() {
  const shown = approvable();
  const items = shown.slice(0, APPROVE_MANY_MAX);
  if (!items.length) { say('Nothing on show is yours to approve right now.'); return; }
  const extra = shown.length - items.length;
  const tell = sayLater();
  const ok = await confirmDialog({
    title: 'Approve ' + items.length + (items.length === 1 ? ' story?' : ' stories?'),
    lead: 'Each one publishes by itself once the publish delay has passed, unless it is withdrawn first.'
      + (extra ? ' This approves the first ' + APPROVE_MANY_MAX + '; approve again for the other ' + extra + '.' : ''),
    items: items.map(titleOf),
    confirm: 'Approve ' + items.length,
  });
  if (!ok) return;
  const res = await desk.call(FN.drafts.approveMany, { items: items.map((d) => ({ draftId: d.draftId, expectedRev: d.rev })) });
  if (!res.ok) {
    tell(explain(res));
  } else {
    const results = Array.isArray(res.results) ? res.results : [];
    const refused = results.filter((r) => !r.ok);
    const byId = new Map(items.map((d) => [d.draftId, d]));
    tell('Approved ' + (results.length - refused.length) + ' of ' + items.length + '.'
      + refused.map((r) => ' "' + titleOf(byId.get(r.draftId)) + '": ' + explain({ ok: false, code: r.code })).join(''));
  }
  await reload();
  if (res.ok && desk.changed) await desk.changed();
}

async function onClick(e) {
  const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act]') : null;
  if (!btn || btn.tagName === 'SELECT') return;
  const act = btn.dataset.act;
  const draftId = btn.dataset.draft;
  const expectedRev = Number(btn.dataset.rev);
  const d = find(draftId);
  const args = { draftId, expectedRev };
  if (act === 'submit-new') return submitNew();
  if (act === 'cancel-new') { view.creating = null; render(); return; }
  if (!d) return;
  if (act === 'edit') { view.editing = { draftId, rev: expectedRev, values: postToValues(d.post) }; render(); return; }
  if (act === 'cancel-edit') { view.editing = null; render(); return; }
  if (act === 'save') return save(false);
  if (act === 'save-approve') return save(true);
  const title = titleOf(d);
  if (act === 'approve') return mutate(FN.drafts.approve, args, approvedText(title));
  if (act === 'take') return mutate(FN.drafts.take, args, 'You now hold "' + title + '".');
  if (act === 'withdraw') return mutate(FN.drafts.withdraw, args, 'Withdrew "' + title + '": it is pending again.');
  if (act === 'reopen') return mutate(FN.drafts.reopen, args, 'Reopened "' + title + '".');
  if (act === 'spike') return mutate(FN.drafts.spike, args, 'Spiked "' + title + '".');
  if (act === 'override') return mutate(FN.drafts.overrideLinks, args, 'Overrode the link check on "' + title + '".');
  if (act === 'recheck') return mutate(FN.drafts.recheckLinks, { draftId }, 'Checking the links on "' + title + '" again.');
  if (act === 'assign-go') return assign(d, expectedRev);
  return undefined;
}

/** Sends the Assign to pick for d, read from its select. */
function assign(d, expectedRev) {
  const select = Array.from(el('lanes').querySelectorAll('select[data-act="assign"]')).find((n) => n.dataset.draft === d.draftId);
  const assignee = select && select.value ? select.value : null;
  view.choices.delete(d.draftId);
  const to = assignee === null ? 'nobody' : view.me && assignee === view.me.subject ? 'you' : labelOf(assignee);
  if (assignee === d.assignee) { say('"' + titleOf(d) + '" is already with ' + to + '.'); return undefined; }
  return mutate(FN.drafts.assign, { draftId: d.draftId, expectedRev, assignee }, '"' + titleOf(d) + '" is now with ' + to + '.', ASSIGN_WORDS);
}

function onInput(e) {
  const t = e.target;
  const key = t && t.dataset ? t.dataset.form : null;
  const name = t && t.dataset ? t.dataset.field : null;
  if (!key || !name) return;
  const values = key === 'new' ? view.creating : view.editing && view.editing.draftId === key ? view.editing.values : null;
  if (!values) return;
  values[name] = t.value;
  refreshEditor(key === 'new' ? el('newStory') : el('lanes'), key, values);
}

/** A change on Assign to only remembers the pick (WCAG 3.2.2): the Assign button next to it sends it. */
function onChange(e) {
  const t = e.target;
  if (!t || !t.dataset || t.dataset.act !== 'assign') { onInput(e); return; }
  if (find(t.dataset.draft)) view.choices.set(t.dataset.draft, t.value);
}

function openNew() {
  const date = today();
  view.creating = { id: date + '-', date, kind: 'note', site: '', title: '', summary: '', body: '', links: '', tags: '' };
  render();
}

/** Binds the lanes' listeners to the page, once per boot. */
export function mount(ctx) {
  desk = ctx;
  clear();
  for (const id of ['lanes', 'newStory']) {
    el(id).addEventListener('click', onClick);
    el(id).addEventListener('input', onInput);
    el(id).addEventListener('change', onChange);
  }
  el('newStoryBtn').addEventListener('click', openNew);
  el('approveAllBtn').addEventListener('click', approveAll);
}
