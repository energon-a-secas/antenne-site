// ── Desk logic ───────────────────────────────────────────────
// Loads drafts from data/drafts/ (gitignored: only exists on the
// machine that drafted them), overlays local edits + verdicts from
// localStorage, and publishes approved stories into data/posts.json.

import { normalizePost, normalizeDoc } from './data.js';
import { renderDesk } from './desk-ui.js';
import { showToast } from './utils.js';

const OVERLAY_KEY = 'dispatch-desk';

export const desk = {
  manifestOk: false,
  publishedOk: false, // false = posts.json failed to load; publishing must stay off
  drafts: [],       // { file, raw }
  published: [],    // normalized published posts
  // { [draftId]: { status: 'approved'|'rejected', edits: {} } }
  // Null prototype: draft ids come from semi-trusted JSON, and a draft named
  // "__proto__" must become an own key, not a write to Object.prototype.
  overlay: Object.create(null),
};

export function loadOverlay() {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (raw) desk.overlay = Object.assign(Object.create(null), JSON.parse(raw) || {});
  } catch { desk.overlay = Object.create(null); }
}

export function saveOverlay() {
  try { localStorage.setItem(OVERLAY_KEY, JSON.stringify(desk.overlay)); }
  catch { /* quota exceeded or private browsing */ }
}

export function resetOverlay() {
  desk.overlay = Object.create(null);
  try { localStorage.removeItem(OVERLAY_KEY); } catch { /* ignore */ }
}

/** One key per draft, shared by every overlay reader and writer. */
export function draftId(d) {
  return (d.raw && typeof d.raw.id === 'string' && d.raw.id) || d.file;
}

/** The draft as it would publish: raw + local edits, normalized (or null). */
export function effectivePost(d) {
  const o = desk.overlay[draftId(d)];
  const merged = Object.assign({}, d.raw, o && o.edits ? o.edits : {});
  return normalizePost(merged);
}

export function verdict(d) {
  const o = desk.overlay[draftId(d)];
  const s = o && o.status;
  // Whitelist: the value round-trips through localStorage and lands in both a
  // class attribute and element text, so only known statuses pass.
  return s === 'approved' || s === 'rejected' ? s : 'draft';
}

export function setVerdict(d, status) {
  const id = draftId(d);
  const o = desk.overlay[id] || (desk.overlay[id] = {});
  o.status = o.status === status ? undefined : status;
  saveOverlay();
}

export function setEdit(d, field, value) {
  const id = draftId(d);
  const o = desk.overlay[id] || (desk.overlay[id] = {});
  (o.edits || (o.edits = {}))[field] = value;
  saveOverlay();
}

export function approvedPosts() {
  return desk.drafts
    .filter((d) => verdict(d) === 'approved')
    .map(effectivePost)
    .filter(Boolean);
}

/** published + approved drafts, deduped by id, newest first. */
export function buildDoc() {
  const byId = new Map();
  desk.published.forEach((p) => byId.set(p.id, p));
  approvedPosts().forEach((p) => byId.set(p.id, p));
  const posts = Array.from(byId.values());
  posts.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1)));
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    version: 1,
    site: 'dispatch',
    updated: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
    posts,
  };
}

export function docJson() {
  return JSON.stringify(buildDoc(), null, 2) + '\n';
}

// The one place the archive path is written, so the dialog, both toasts and the
// operator all name the same file. The only path the feed reads.
export const PUBLISH_TARGET = 'data/posts.json';
const PUBLISH_NAME = 'posts.json';

// A suggestedName may not contain a directory separator, so the name cannot say
// where the file belongs and the picker opens wherever it last was. On
// 2026-09-11 that was the repo ROOT: twelve approved stories were saved over a
// stale tracked posts.json nothing reads, and nothing went live until they were
// copied into data/ by hand. `id` is the lever that fixes it, because a browser
// remembers a directory per id, so the second publish onward opens where the
// first one saved. `startIn` cannot help: it takes a well-known directory name
// (documents, downloads) or a handle we would have to have stored already, and
// the repo is neither. Keep it alphanumeric and short; a browser rejects an
// id it does not like by throwing instead of saving.
const PUBLISH_PICKER_ID = 'dispatchArchive';

/**
 * Write the archive via the File System Access API; fall back to a download.
 *
 * Neither the id nor the wording can PREVENT a save to the wrong place, so
 * scripts/build-feed.py --check fails on a posts.json at the repo root. This
 * end makes the right place easy and says the path out loud; that end catches
 * the miss before it can be committed.
 */
export async function publish() {
  const json = docJson();
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        id: PUBLISH_PICKER_ID,
        suggestedName: PUBLISH_NAME,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      // The picker lets the operator rename, and "posts (1).json" in the right
      // directory is as dead as posts.json in the wrong one. The directory is
      // not ours to read; the name is, so say when it is wrong.
      const saved = (handle && handle.name) || PUBLISH_NAME;
      showToast(saved === PUBLISH_NAME
        ? `Saved. It only counts as ${PUBLISH_TARGET}: check that, then make feed, review the diff, commit.`
        : `Saved as ${saved}, and only ${PUBLISH_TARGET} is read. Rename it there, then make feed.`, 8000);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled the picker
    }
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = PUBLISH_NAME;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${PUBLISH_NAME}. Move it to ${PUBLISH_TARGET}, then make feed.`, 8000);
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ' ' + res.status);
  return res.json();
}

async function loadAll() {
  // A load failure must NOT look like an empty archive: buildDoc() merges
  // published + approved, so publishing over a failed load would silently
  // discard every already-published story. publishedOk gates the publish UI.
  try {
    desk.published = normalizeDoc(await fetchJson('data/posts.json'));
    desk.publishedOk = true;
  } catch {
    desk.publishedOk = false;
    desk.published = [];
  }

  try {
    const manifest = await fetchJson('data/drafts/index.json');
    const files = Array.isArray(manifest.drafts) ? manifest.drafts : [];
    const loaded = await Promise.all(files.map(async (file) => {
      try { return { file, raw: await fetchJson('data/drafts/' + file) }; }
      catch { return null; }
    }));
    desk.drafts = loaded.filter(Boolean);
    desk.manifestOk = true;
  } catch {
    desk.manifestOk = false;
    desk.drafts = [];
  }
}

async function init() {
  loadOverlay();
  await loadAll();
  renderDesk();
}

init();
