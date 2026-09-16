// ── State management ─────────────────────────────────────────
// Shared mutable state object. Embed mode (?embed=1) never touches
// storage: an embedded Dispatch shows the feed, not the visitor's
// read-state (same convention as proctor-site).

const STORAGE_KEY = 'dispatch-state';

const params = new URLSearchParams(location.search);
const embed = params.has('embed');

function embedLimit() {
  const n = parseInt(params.get('limit'), 10);
  if (Number.isNaN(n)) return 4;
  return Math.min(10, Math.max(1, n));
}

export const state = {
  posts: [],        // published posts, newest first (data.js normalizes)
  updated: null,    // the archive's own publish date, dates the edition line
  error: false,     // the stamped archive failed to parse
  filter: 'all',    // all | launch | feature | fix | note
  query: '',
  openId: null,     // id of the expanded story, one at a time
  embed,
  limit: embedLimit(),
  // ?brand=0 drops the embed's own masthead, for hosts whose chrome
  // already names the site (the hub's corner popup does).
  brand: params.get('brand') !== '0',
  lastSeen: null,   // newest post date already seen on a previous visit
  prevSeen: null,   // snapshot of lastSeen at load, drives the NEW badges
};

/** Load persisted prefs. Only lastSeen survives reloads; the chrome
    preference moved into the NeoKeys kit's fleet-wide neo_chrome cookie. */
export function loadSaved(s) {
  if (s.embed) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.lastSeen === 'string') s.lastSeen = saved.lastSeen;
  } catch { /* ignore corrupted data */ }
}

/** Persist current prefs to localStorage. */
export function save(s) {
  if (s.embed) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      lastSeen: s.lastSeen,
    }));
  } catch { /* quota exceeded or private browsing */ }
}
