// ── Desk rendering: story cards, the editor, the page state ──
// Everything the desk writes into the page goes through escHtml (markup) or
// textContent (plain text), including what the server sends back: a story's
// title is somebody's input. Nothing here calls the backend; js/desk-lanes.js,
// js/desk-people.js and js/desk-publish.js do, and render through these.

import { renderCard } from './render.js';
import { KINDS, KIND_LABELS, normalizePost } from './data.js';
import { validatePost } from './schema.js';
import { problemText } from './desk-api.js';
import { escHtml } from './utils.js';

/** Uncached, unlike utils.js $(): the desk re-renders whole regions. */
export const el = (id) => document.getElementById(id);

// ── Field parsers (the old desk's, kept) ─────────────────────
const bodyToText = (body) => (Array.isArray(body) ? body.join('\n\n') : '');
const textToBody = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const linksToText = (links) => (Array.isArray(links)
  ? links.map((l) => (l && l.label) + ' | ' + (l && l.url)).join('\n') : '');
const textToLinks = (text) => text.split('\n').map((line) => {
  const i = line.indexOf('|');
  if (i === -1) return null;
  return { label: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
}).filter((l) => l && l.label && l.url);
const tagsToText = (tags) => (Array.isArray(tags) ? tags.join(', ') : '');
const textToTags = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);

export const PARSERS = Object.freeze({
  id: (v) => v.trim(),
  title: (v) => v,
  date: (v) => v.trim(),
  kind: (v) => v,
  site: (v) => (v.trim() ? v.trim() : null),
  summary: (v) => v,
  body: textToBody,
  links: textToLinks,
  tags: textToTags,
});

const FIELDS = Object.keys(PARSERS);

/** A post as the editor's text values. */
export function postToValues(post) {
  const p = post && typeof post === 'object' ? post : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    id: str(p.id), date: str(p.date), kind: str(p.kind) || 'note', site: str(p.site),
    title: str(p.title), summary: str(p.summary), body: bodyToText(p.body), links: linksToText(p.links), tags: tagsToText(p.tags),
  };
}

/** The editor's text values as a raw post, each field through its parser. */
export function valuesToPost(values) {
  const post = {};
  for (const f of FIELDS) post[f] = PARSERS[f](String(values[f] == null ? '' : values[f]));
  return post;
}

// ── Roles: the server's permission table, mirrored for the controls ─────
// The server decides; this only keeps the desk from offering what it will
// refuse. tests/desk-api.test.mjs compares it with convex/lib/access.ts.
const ANY = ['owner', 'editor', 'reviewer', 'submitter'];
const REVIEWERS_UP = ['owner', 'editor', 'reviewer'];
const EDITORS_UP = ['owner', 'editor'];
export const PERMISSIONS = Object.freeze({
  'queue.read': ANY, 'draft.submit': ANY, 'draft.edit': ANY, 'draft.approve': REVIEWERS_UP, 'draft.spike': ANY,
  'draft.withdraw': REVIEWERS_UP, 'draft.reopen': EDITORS_UP, 'draft.assign': EDITORS_UP, 'draft.take': REVIEWERS_UP,
  'draft.overrideLinks': ['owner'], 'members.manage': ['owner'], 'settings.read': EDITORS_UP, 'settings.manage': ['owner'],
  'publish.read': REVIEWERS_UP, 'publish.trigger': EDITORS_UP, 'access.request': [],
});

export function can(role, action) {
  return typeof role === 'string' && Array.isArray(PERMISSIONS[action]) && PERMISSIONS[action].includes(role);
}

export const ROLE_TEXT = Object.freeze({ owner: 'an owner', editor: 'an editor', reviewer: 'a reviewer', submitter: 'a submitter' });

/** What each role does here, for the banner. */
const ROLE_DOES = Object.freeze({
  owner: 'You are an owner: you approve and publish stories, and manage people and settings.',
  editor: 'You are an editor: you approve, assign and publish stories.',
  reviewer: 'You are a reviewer: you approve the stories you hold, or that nobody holds yet.',
  submitter: 'You are a submitter: you submit stories and can change them until a reviewer decides.',
});

// ── Story cards ──────────────────────────────────────────────
const STATUS_TEXT = Object.freeze({
  pending: 'Pending', approved: 'Approved', publishing: 'Publishing', committed: 'Committed', live: 'Live', spiked: 'Spiked',
});

/** The draft as it would read on the feed, or why it cannot yet. */
export function previewHtml(raw) {
  const post = normalizePost(raw);
  if (!post) {
    return '<div class="feed-empty card">Not publishable yet: a story needs an id, a title, '
      + 'a YYYY-MM-DD date and a valid kind.</div>';
  }
  return renderCard(post, { open: true });
}

/** The desk-mode problems of a raw post, as a list; empty when there are none. */
export function problemsHtml(raw) {
  const { problems } = validatePost(raw, { mode: 'desk' });
  if (!problems.length) return '';
  return '<ul class="draft__problems" aria-label="Problems to fix">'
    + problems.map((p) => '<li>' + escHtml(problemText(p)) + '</li>').join('') + '</ul>';
}

/** True when a link check blocks approval and no owner has overridden it (draftsCore linksBlocked). */
export function linksBlocked(d) {
  return d.linkOverride === null && Array.isArray(d.linkChecks) && d.linkChecks.some((c) => !!c && c.blocking === true);
}

function linkChip(check) {
  if (!check || typeof check !== 'object') return '';
  const s = check.status;
  const text = typeof s === 'number' ? 'answers ' + s
    : s === 'timeout' ? 'timed out' : s === 'dns' ? 'name does not resolve' : s === 'network' ? 'unreachable' : 'unchecked';
  const tone = check.blocking === true ? 'bad' : typeof s === 'number' && s >= 200 && s < 400 ? 'ok' : 'warn';
  return '<span class="desk-chip desk-chip--' + tone + '" title="' + escHtml(check.url) + '">'
    + escHtml(shortUrl(check.url)) + ' ' + escHtml(text) + (check.blocking === true ? ', blocks approval' : '') + '</span>';
}

function shortUrl(url) {
  const s = typeof url === 'string' ? url.replace(/^https:\/\//, '') : '';
  return s.length > 48 ? s.slice(0, 45) + '...' : s;
}

/** The flags on a card: outside links, a note, the link checks and any override. */
export function flagsHtml(d) {
  const chips = [];
  if (d.external === true) chips.push('<span class="desk-chip desk-chip--warn">Links outside neorgon.com: an editor or an owner approves</span>');
  if (d.note === 'conflict') {
    chips.push('<span class="desk-chip desk-chip--bad">Sent back by publishing: the archive holds a different story under this id, or the story changed after approval</span>');
  } else if (typeof d.note === 'string' && d.note) {
    chips.push('<span class="desk-chip">Note: ' + escHtml(d.note) + '</span>');
  }
  if (Array.isArray(d.linkChecks)) chips.push(...d.linkChecks.map(linkChip));
  if (typeof d.linkOverride === 'string') chips.push('<span class="desk-chip">Link check overridden by an owner</span>');
  const shown = chips.filter(Boolean);
  return shown.length ? '<div class="draft__chips">' + shown.join('') + '</div>' : '';
}

/**
 * One story. `parts`: who (plain text); when, actions and editor (markup built
 * by the caller from escaped pieces, when with agoHtml or untilHtml for a time).
 */
export function draftCard(d, parts = {}) {
  const status = Object.prototype.hasOwnProperty.call(STATUS_TEXT, d.status) ? d.status : 'unknown';
  const id = escHtml(d.draftId);
  return '<article class="card draft draft--' + status + '" data-draft="' + id + '">'
    + '<div class="draft__meta">'
    + '<span class="draft__status">' + escHtml(STATUS_TEXT[status] || 'Unknown') + '</span>'
    + '<code class="post__site">' + escHtml(d.storyId) + '</code>'
    + '<span class="draft__rev">rev ' + escHtml(d.rev) + '</span>'
    + (parts.who ? '<span class="draft__who">' + escHtml(parts.who) + '</span>' : '')
    + '<span class="draft__source">' + (d.source === 'machine' ? 'from the drafter' : 'from the desk') + '</span>'
    + '</div>'
    + flagsHtml(d)
    + (parts.editor ? '' : problemsHtml(d.post))
    + (parts.when ? '<p class="draft__when">' + parts.when + '</p>' : '')
    + (parts.note ? '<p class="draft__note">' + escHtml(parts.note) + '</p>' : '')
    + (parts.actions ? '<div class="toolbar draft__actions">' + parts.actions + '</div>' : '')
    + (parts.editor || '')
    + '<div class="draft__preview"><p class="draft__preview-label">Preview</p>'
    + '<div data-preview="' + id + '">' + previewHtml(d.post) + '</div></div>'
    + '</article>';
}

/** A button carrying its action and the draft and rev it was drawn for. */
export function actButton(act, label, d, style = 'secondary') {
  return '<button type="button" class="btn btn--' + style + ' btn--sm" data-act="' + escHtml(act) + '" data-draft="'
    + escHtml(d.draftId) + '" data-rev="' + escHtml(d.rev) + '">' + escHtml(label) + '</button>';
}

// ── The editor (a draft being edited, or a new story) ────────
function field(key, name, label, control, wide) {
  return '<div class="draft__field' + (wide ? ' draft__field--wide' : '') + '">'
    + '<label for="f-' + key + '-' + name + '">' + label + '</label>' + control + '</div>';
}

/** The form for one story. `key` is a draftId, or "new"; `buttons` is escaped markup. */
export function editorHtml(key, values, buttons) {
  const k = escHtml(key);
  const attr = (n) => 'id="f-' + k + '-' + n + '" data-form="' + k + '" data-field="' + n + '"';
  const input = (n, type = 'text', extra = '') => '<input type="' + type + '" ' + attr(n) + ' value="' + escHtml(values[n]) + '"' + extra + '>';
  const area = (n) => '<textarea ' + attr(n) + '>' + escHtml(values[n]) + '</textarea>';
  const post = valuesToPost(values);
  return '<div class="draft__editor" data-editor="' + k + '">'
    + '<div class="draft__grid">'
    + field(k, 'title', 'Title', input('title'), true)
    + field(k, 'id', 'Id (starts with the date)', input('id', 'text', ' spellcheck="false"'))
    + field(k, 'date', 'Date', input('date', 'date'))
    + field(k, 'kind', 'Kind', '<select ' + attr('kind') + '>' + KINDS.map((kind) => '<option value="' + kind + '"'
      + (values.kind === kind ? ' selected' : '') + '>' + KIND_LABELS[kind] + '</option>').join('') + '</select>')
    + field(k, 'site', 'Site (blank means fleet-wide)', input('site', 'text', ' placeholder="floorplan-site"'))
    + field(k, 'tags', 'Tags (comma separated)', input('tags'))
    + field(k, 'summary', 'Summary', area('summary'), true)
    + field(k, 'body', 'Body (a blank line between paragraphs)', area('body'), true)
    + field(k, 'links', 'Links (one per line: Label | https://url)', area('links'), true)
    + '</div>'
    + '<div data-problems="' + k + '">' + problemsHtml(post) + '</div>'
    + '<div class="toolbar draft__actions">' + buttons + '</div>'
    + (key === 'new' ? '<div class="draft__preview"><p class="draft__preview-label">Preview</p><div data-preview="new">'
      + previewHtml(post) + '</div></div>' : '')
    + '</div>';
}

/** After a keystroke: the edited field into values, then the preview and problems for that form. */
export function refreshEditor(root, key, values) {
  const post = valuesToPost(values);
  const k = String(key).replace(/["\\]/g, '\\$&');
  const preview = root.querySelector('[data-preview="' + k + '"]');
  if (preview) preview.innerHTML = previewHtml(post);
  const problems = root.querySelector('[data-problems="' + k + '"]');
  if (problems) problems.innerHTML = problemsHtml(post);
}

// ── Time ─────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

/** "14:05" in the reader's time zone. */
export function clock(ms) {
  const t = new Date(ms);
  return pad(t.getHours()) + ':' + pad(t.getMinutes());
}

/** "3 min ago", "2 h ago", "4 days ago". */
export function ago(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}

const untilText = (ms) => 'in ' + Math.max(1, Math.ceil(Number(ms) / 60000)) + ' min';

/** How long ago `at` (ms) was, as markup that stampTimes keeps current in place. */
export const agoHtml = (at, now = Date.now()) => '<span data-ago="' + Math.round(at) + '">' + escHtml(ago(now - at)) + '</span>';

/** How long until `at` (ms), "in 5 min", as markup that stampTimes keeps current in place. */
export const untilHtml = (at, now = Date.now()) => '<span data-until="' + Math.round(at) + '">' + escHtml(untilText(at - now)) + '</span>';

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

/** Brings every agoHtml and untilHtml time under root up to now, changing nothing else. */
export function stampTimes(root, now = Date.now()) {
  for (const n of Array.from(root.querySelectorAll('[data-ago]'))) setText(n, ago(now - Number(n.dataset.ago)));
  for (const n of Array.from(root.querySelectorAll('[data-until]'))) setText(n, untilText(Number(n.dataset.until) - now));
}

// ── Redrawing a region without losing the reader's place ─────
// The lanes, the status bar, the banner and the People panel are redrawn on
// every refresh, and one runs on focus and every 60 s. swap() leaves a region's
// nodes alone when its markup is what it already shows, apart from the times,
// which stampTimes() moves on in place, so a refresh that changed nothing keeps
// a keyboard user's focus and a screen reader's place. When the markup did
// change and focus was inside, focus goes to the same control in the new markup
// (same tag, data-act, draft, subject, form field, name and id), else to that
// story's card, else to the region: never out to the page body.
const drawn = new WeakMap();
const TIME_RE = /(<span data-(?:ago|until)="-?\d+">)[^<]*(<\/span>)/g;
const KEY_ATTRS = ['data-act', 'data-draft', 'data-subject', 'data-form', 'data-field', 'name', 'id'];
const keyOf = (n) => n.tagName + KEY_ATTRS.map((a) => '|' + (n.getAttribute(a) || '')).join('');
const FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Writes html into region, unless it already shows it. Every desk region write goes through here. */
export function swap(region, html) {
  if (!region) return;
  const same = html.replace(TIME_RE, '$1$2');
  if (drawn.get(region) === same) { stampTimes(region); return; }
  const active = document.activeElement;
  const inside = !!active && active !== region && typeof region.contains === 'function' && region.contains(active);
  const key = inside ? keyOf(active) : '';
  const card = inside && typeof active.closest === 'function' ? active.closest('[data-draft]') : null;
  const cardId = card ? card.getAttribute('data-draft') : null;
  region.innerHTML = html;
  drawn.set(region, same);
  if (inside) refocus(region, key, cardId);
}

function refocus(region, key, cardId) {
  const nodes = Array.from(region.querySelectorAll('*'));
  const target = nodes.find((n) => keyOf(n) === key)
    || (cardId === null ? null : nodes.find((n) => n.tagName === 'ARTICLE' && n.getAttribute('data-draft') === cardId))
    || region;
  if (!FOCUSABLE.has(target.tagName) && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

// ── The page state ───────────────────────────────────────────
const GATES = Object.freeze({
  loading: { text: 'Loading the desk.' },
  'not-set-up': {
    text: 'The desk backend is not set up yet. Stories cannot be submitted or approved here until the owner runs '
      + 'scripts/setup-antenne.sh, which creates the Convex deployment and writes its address into this page.',
  },
  misconfigured: {
    text: 'This page names a desk backend that is not a Convex deployment URL, so the desk connects nowhere. '
      + 'The neo-convex-url meta in desk.html needs fixing.',
  },
  'signed-out': {
    text: 'Sign in with your Neorgon account to use the desk. Only accounts an owner has granted a desk role see stories.',
    button: 'Sign in',
  },
  unverified: {
    text: 'You are signed in, but the desk backend did not accept your session. Reload the page; if it keeps happening, '
      + 'the Clerk convex token template needs checking.',
  },
  'no-role': { text: 'Your account holds no desk role yet. Request access below, and an owner can grant you one.' },
  member: { text: '' },
  error: { text: '' },
});

/** Which sections a state shows. */
const SHOWN = Object.freeze({
  accountSection: ['no-role', 'member'],
  lanesSection: ['member'],
  publishSection: ['member'],
  peopleSection: ['member'],
});

/**
 * Renders the banner for one of the page states and shows the sections that
 * state has. `me` is desk:me's answer; `text` replaces the banner copy (for
 * member and error).
 */
export function renderGate({ state, me = null, text = '' }) {
  const gate = GATES[state] || GATES.error;
  const banner = el('deskBanner');
  let copy = text || gate.text;
  if (state === 'member' && me) {
    copy = (ROLE_DOES[me.role] || 'You hold a desk role.')
      + (me.frozen ? ' The desk is frozen: reading works, but changes are paused.' : '');
  }
  if (banner) {
    banner.dataset.state = state;
    swap(banner, '<p>' + escHtml(copy) + '</p>'
      + (gate.button ? '<p><button type="button" class="btn btn--primary btn--sm" data-act="sign-in">' + escHtml(gate.button) + '</button></p>' : ''));
  }
  for (const [id, states] of Object.entries(SHOWN)) {
    const section = el(id);
    if (!section) continue;
    let shown = states.includes(state);
    if (id === 'publishSection') shown = shown && !!me && can(me.role, 'publish.read');
    if (id === 'peopleSection') shown = shown && !!me && can(me.role, 'members.manage');
    section.hidden = !shown;
  }
}

/** One line for the result of the last action, as plain text. */
export function say(text) {
  const notice = el('deskNotice');
  if (notice) notice.textContent = text || '';
}

// A notice belongs to the account whose action it reports. forgetNotices(), on
// an account change, empties the line and silences every sayLater() promised
// before it, so an answer for the last account never speaks under the next.
let account = 0;

/** Empties the notice line, and drops every notice still on its way. */
export function forgetNotices() {
  account += 1;
  say('');
}

/** say(), for an action starting now: silent if the account has changed by the time it reports. */
export function sayLater() {
  const at = account;
  return (text) => { if (at === account) say(text); };
}

// ── The confirm dialog (native <dialog id="deskDialog">) ─────

/**
 * Opens the dialog with a title, a lead line and a list of items (all plain
 * text), and resolves true on confirm, false on cancel, Escape or close.
 */
export function confirmDialog({ title, lead = '', items = [], confirm = 'Confirm' }) {
  const dialog = el('deskDialog');
  el('deskDialogTitle').textContent = title;
  el('deskDialogLead').textContent = lead;
  el('deskDialogList').innerHTML = items.map((item) => '<li>' + escHtml(item) + '</li>').join('');
  el('deskDialogList').hidden = !items.length;
  const yes = el('deskDialogConfirm');
  const no = el('deskDialogCancel');
  yes.textContent = confirm;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      dialog.removeEventListener('close', onNo);
      if (dialog.open) dialog.close();
      resolve(ok);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    dialog.addEventListener('close', onNo);
    dialog.showModal();
  });
}
