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

/** Fetch the published feed. Throws on network or HTTP failure. */
export async function loadPosts() {
  const res = await fetch('data/posts.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('posts.json ' + res.status);
  return normalizeDoc(await res.json());
}
