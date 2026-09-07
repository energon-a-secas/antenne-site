/**
 * NeoKeys — core registry, typing guard, and dispatch.
 *
 * This directory is written to be lifted into packages/neorgon-ui/keys/ as-is:
 * nothing in it imports site code, and every DOM assumption it makes is about
 * the header/footer kits, which every site already has.
 *
 * The registry is the point. A shortcut declared as data can be listed in a
 * help overlay, checked for collisions, and remapped by the visitor. A shortcut
 * written as `if (e.key === 'x')` can do none of those, which is why eight
 * sites converged on `/` for search and not one of them can tell you so.
 */

/* Kit-owned. A site that registers one of these is refused, loudly. Escape is
   deliberately NOT here: most sites already bind it to close their own layers,
   so reserving it would either break them or be a rule nobody keeps. Escape is
   conventional — the meaning is fixed, the handler stays the site's. */
export const RESERVED = Object.freeze({
  '?': 'Show the shortcut sheet',
  h: 'Hide or show the header and footer',
  g: 'Jump to another Neorgon site',
});

/* Registered by a site, but the meaning is fixed fleet-wide. The kit does not
   implement these; it checks that nobody uses the key to mean something else. */
export const CONVENTIONAL = Object.freeze({
  '/': 'Focus the primary search or filter',
  s: 'Share or copy link',
  e: 'Export or download',
  r: 'Reset, reroll, or regenerate',
  '[': 'Previous in a series',
  ']': 'Next in a series',
});

const PREFS_KEY = 'neokeys-prefs';

const state = {
  entries: [],        // { id, key, defaultKey, label, hint, run, group, owner }
  enabled: true,
  prefs: { disabled: false, remaps: {} },
  listening: false,
  onChange: [],
};

/* ── Preferences (WCAG 2.1.4) ─────────────────────────────────────────
   SC 2.1.4 Character Key Shortcuts is a Level A criterion: a single-key
   shortcut must be switchable off, remappable, or active only on focus.
   We do all three. Stored per site rather than fleet-wide, because a remap
   is about one site's keys, unlike the chrome preference. */
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) state.prefs = { disabled: false, remaps: {}, ...JSON.parse(raw) };
  } catch { /* private mode, or a corrupt value — defaults are fine */ }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* not fatal */ }
}

function notify() { state.onChange.forEach((fn) => fn()); }

/** Subscribe to registry or preference changes (the overlay redraws on these). */
export function onChange(fn) { state.onChange.push(fn); }

/* ── The typing guard ─────────────────────────────────────────────────
   The most important code here, and the part the original Sortie write-up
   left out of its "four lines that matter". Sortie has no rich text and got
   away with checking three tag names; the sites this is aimed at (cardforge,
   json-studio, slides, character-sheet) are full of editors, and a bare `h`
   firing mid-word is the fastest way to get the whole system switched off.

   Four things get past a three-tag check, and all four were confirmed firing
   before they were fixed rather than guessed at:
     · contentEditable, the case everyone forgets
     · an <input> inside a shadow root, where e.target reports the host
     · role="textbox" and friends on a plain div
     · an IME mid-composition, where the keys belong to the candidate window */

/* ARIA roles that mean "text goes in here" even when the element is a plain
   div. Custom editors and comboboxes reach for these constantly. */
const TYPING_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/* Sites can widen the guard for a surface the kit cannot recognise, such as
   CodeMirror or ProseMirror, which render into elements that are neither an
   input nor contenteditable at the point the key lands. */
let extraTypingSelector = '';
export function setTypingSelector(sel) { extraTypingSelector = sel || ''; }

export function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;

  /* An explicit opt-out wins over everything. A site marks its editor's root
     once and every key inside it is text, whatever the markup looks like. */
  if (el.closest?.('[data-neo-keys="off"]')) return true;
  if (extraTypingSelector && el.closest?.(extraTypingSelector)) return true;

  if (el.isContentEditable) return true;

  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  const role = el.getAttribute?.('role');
  return !!role && TYPING_ROLES.has(role);
}

/**
 * The element the key actually landed on.
 *
 * `e.target` is retargeted at a shadow boundary: an <input> inside a shadow
 * root reports the HOST element, which is usually a plain div, so a guard
 * reading e.target concludes nobody is typing and fires the shortcut into a
 * live text field. composedPath()[0] is the real node. This was a confirmed
 * hole, not a theoretical one.
 */
export function realTarget(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
  return (path && path[0]) || e.target;
}

/** Normalize a KeyboardEvent to the registry's key form. */
export function keyOf(e) {
  if (e.key === 'Escape') return 'escape';
  return e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
}

/** The key a given entry answers to right now, honouring any visitor remap. */
export function activeKey(entry) {
  return state.prefs.remaps[entry.id] || entry.key;
}

/* ── Registration ─────────────────────────────────────────────────────
   Collisions are the reason the registry exists, so they are reported rather
   than resolved. Returning the rejected entries (instead of throwing) lets a
   site register a batch and still boot. */
export function register(defs, owner = 'site') {
  const accepted = [];
  const rejected = [];

  for (const def of Array.isArray(defs) ? defs : [defs]) {
    const key = String(def.key || '').toLowerCase();
    const id = def.id || `${owner}:${key}`;

    if (!key) {
      rejected.push({ def, reason: 'no key' });
      continue;
    }
    if (owner !== 'kit' && key in RESERVED) {
      rejected.push({ def, reason: `"${key}" is fleet-reserved (${RESERVED[key]})` });
      warn(`refused to register "${key}": reserved by NeoKeys for ${RESERVED[key]}`);
      continue;
    }
    const clash = state.entries.find((x) => x.key === key);
    if (clash) {
      rejected.push({ def, reason: `"${key}" already bound to "${clash.label}"` });
      warn(`"${key}" is already bound to "${clash.label}", so the later registration is ignored`);
      continue;
    }
    if (owner !== 'kit' && key in CONVENTIONAL) {
      /* Not refused. The convention is about meaning, and only a human can
         judge whether "Export" is what this site's E does. */
      warn(`"${key}" is a fleet convention meaning "${CONVENTIONAL[key]}". Make sure that is what it does here`);
    }

    const entry = {
      id,
      key,
      defaultKey: key,
      label: def.label || key.toUpperCase(),
      hint: def.hint || '',
      run: typeof def.run === 'function' ? def.run : () => {},
      group: def.group || (owner === 'kit' ? 'Fleet' : 'This page'),
      owner,
    };
    state.entries.push(entry);
    accepted.push(entry);
  }

  notify();
  return { accepted, rejected };
}

function warn(msg) {
  /* Loud in the console on purpose. A silently shadowed shortcut is the exact
     failure this registry exists to make impossible to ship unnoticed. */
  console.warn(`[NeoKeys] ${msg}`);
}

/** Every registered shortcut, kit entries first, for the ? sheet. */
export function list() {
  const rank = (e) => (e.owner === 'kit' ? 0 : 1);
  return [...state.entries].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

export function isDisabled() { return state.prefs.disabled; }

export function setDisabled(off) {
  state.prefs.disabled = !!off;
  savePrefs();
  notify();
}

/** Remap one entry. Passing null restores its default key. */
export function remap(id, key) {
  const entry = state.entries.find((x) => x.id === id);
  if (!entry) return { ok: false, reason: 'no such shortcut' };

  if (key === null) {
    delete state.prefs.remaps[id];
    savePrefs();
    notify();
    return { ok: true };
  }

  const k = String(key).toLowerCase();
  if (k.length !== 1) return { ok: false, reason: 'single characters only' };
  const taken = state.entries.find((x) => x.id !== id && activeKey(x) === k);
  if (taken) return { ok: false, reason: `"${k}" is taken by ${taken.label}` };

  state.prefs.remaps[id] = k;
  savePrefs();
  notify();
  return { ok: true };
}

export function resetRemaps() {
  state.prefs.remaps = {};
  savePrefs();
  notify();
}

export function remaps() { return { ...state.prefs.remaps }; }

/* ── Dispatch ─────────────────────────────────────────────────────────
   Returns a verdict rather than a boolean so the site's playground can show
   why a key did or did not fire. The kit ignores the verdict; the tutorial
   is built on it. */
export function classify(e) {
  if (state.prefs.disabled) return { fired: false, reason: 'shortcuts-off' };
  if (e.metaKey || e.ctrlKey || e.altKey) return { fired: false, reason: 'modifier' };

  /* An IME is mid-composition. Every keystroke belongs to the candidate
     window, not to us. keyCode 229 is the legacy signal browsers still send
     for a composing key, and it is checked because isComposing is absent on
     some older WebKit paths. Without this, a Japanese or Chinese visitor
     typing over any non-input surface triggers shortcuts with each keystroke. */
  if (e.isComposing || e.keyCode === 229) return { fired: false, reason: 'composing' };

  if (isTypingTarget(realTarget(e))) return { fired: false, reason: 'typing' };

  const key = keyOf(e);
  const entry = state.entries.find((x) => activeKey(x) === key);
  if (!entry) return { fired: false, reason: 'unbound', key };
  return { fired: true, reason: 'bound', key, entry };
}

function onKeydown(e) {
  const verdict = classify(e);
  state.lastVerdict = verdict;
  state.onKey?.(verdict, e);
  if (!verdict.fired) return;

  /* Run first, cancel second. The order is the whole contract: an entry that
     returns false declines, and a declined key keeps its native effect.
     Cancelling before the run made declining impossible, because the default
     was already gone by the time the entry could look at anything: Space on a
     focused button never activated it, Space on a long page never scrolled,
     and a site that wanted one key passed through had to bolt a capture-phase
     listener in front of the kit to stop the event ever arriving (rappel-site
     still carries one). Every other return value, undefined included, cancels,
     so nothing that was written before this existed changes behaviour.

     run() is given the event so an entry can decide from the real target
     rather than guessing from site state. */
  const declined = verdict.entry.run(e) === false;
  if (!declined) e.preventDefault();
}

/** Install the single document listener. Idempotent. */
export function listen(onKey) {
  if (onKey) state.onKey = onKey;
  if (state.listening) return;
  loadPrefs();
  document.addEventListener('keydown', onKeydown);
  state.listening = true;
}
