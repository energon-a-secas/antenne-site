// ── Entry point ──────────────────────────────────────────────
// Wires the modules together. Keep under 50 lines.

import { state, loadSaved, save } from './state.js';
import { loadArchive } from './data.js';
import { render } from './render.js';
import { bindEvents, openFromHash } from './events.js';
import { init as initKeys } from './neokeys/index.js';

// Synchronous from parse to paint (queue #43): the archive is stamped into the
// page, so there is no fetch and no await before render, and nothing the
// visitor sees changes after they see it.
function init() {
  loadSaved(state);
  if (state.embed) document.body.classList.add('is-embed');

  try {
    const archive = loadArchive();
    state.posts = archive.posts;
    state.updated = archive.updated;
  } catch {
    state.error = true;
  }

  // NEW badges compare against the previous visit, then the visit itself
  // becomes the new watermark.
  state.prevSeen = state.lastSeen;
  render(state);

  if (state.embed) return;
  bindEvents(state);
  // The embed never reaches here, so H stays dead inside host pages.
  // 'full' keeps the pre-kit behaviour: this feed hid its footer too.
  initKeys({ chromeToggle: 'full' });
  openFromHash(state);
  // Watermark only moves forward: a retracted story must not regress it
  // and re-flag everything as NEW on the next visit.
  const newest = state.posts.length ? state.posts[0].date : null;
  if (newest && (!state.lastSeen || newest > state.lastSeen)) {
    state.lastSeen = newest;
    save(state);
  }
}

init();
