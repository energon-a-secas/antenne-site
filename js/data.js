// ── Post loading ─────────────────────────────────────────────
// The feed's normalizePost is js/schema.js in read mode: today's lenient
// rules (drop a post without an id, title, date and kind; filter bad links
// and empty strings), so a visitor never loses a story the stricter modes
// would accept. The desk and the publishing checks use the stricter modes.

import { KINDS, validatePost } from './schema.js';

export { KINDS };

export const KIND_LABELS = {
  launch: 'Launch',
  feature: 'Feature',
  fix: 'Fix',
  note: 'Note',
};

/**
 * Coerce one raw post into the canonical shape, or return null if it
 * is missing the required fields (id, title, valid date, valid kind).
 */
export function normalizePost(raw) {
  return validatePost(raw, { mode: 'read' }).post;
}

/** Normalize a whole document: drop invalid posts, sort newest first. */
export function normalizeDoc(doc) {
  const raw = doc && Array.isArray(doc.posts) ? doc.posts : [];
  const posts = raw.map(normalizePost).filter(Boolean);
  posts.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1)));
  return posts;
}

/**
 * Read the archive stamped into index.html by scripts/build-feed.py. Throws
 * when the stamp is missing or unparseable, and the caller says the edition was
 * published broken: nothing here is recoverable at runtime, and a reload will
 * not help.
 *
 * Synchronous on purpose (queue #43). This used to fetch data/posts.json, so
 * the first render waited a network round trip and the visitor's own context
 * landed on a page they were already reading: 30 NEW markers appearing in cards
 * that had painted, the edition line changing its date, a #p= story opening and
 * scrolling under them. The bytes are the same either way (the stamped cards are
 * this same content as markup), one request fewer, and no await between parsing
 * the page and rendering it.
 *
 * data/posts.json stays the source: the desk writes it, make feed stamps it in,
 * and make check fails while the two disagree.
 */
export function loadArchive() {
  const el = document.getElementById('archive');
  if (!el) throw new Error('index.html carries no archive stamp; run make feed');
  const doc = JSON.parse(el.textContent);
  return {
    posts: normalizeDoc(doc),
    // The date the archive was published, which is what the edition line says.
    // scripts/build-feed.py stamps the same field, so the line never changes
    // after load. It used to be re-stamped as the visitor's own today, which is
    // both a late swap and a claim the feed cannot support.
    updated: doc && typeof doc.updated === 'string' ? doc.updated : null,
  };
}
