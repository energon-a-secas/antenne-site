// ── Antenne desk: entry ──────────────────────────────────────
// Reads the Convex deployment desk.html names; empty means not set up, and the
// desk loads nothing more (no Auth Kit, no client, no call). Otherwise it starts
// the Auth Kit, asks desk:me on each sign-in change and renders signed out, no
// role or member. Every call goes through authedCall, never bindConvex. Refreshes
// on focus and every 60 s while visible, once per return to the tab. A new
// account, or another caller or role, clears every panel (a new account the notice
// too); a failed desk:me only hides them, so unsaved work survives a dropped link.

import { FN, authedCall, convexUrlFrom, explain, kindOf, loadClient } from './desk-api.js';
import { el, forgetNotices, renderGate } from './desk-ui.js';
import * as lanes from './desk-lanes.js';
import * as people from './desk-people.js';
import * as publish from './desk-publish.js';

const REFRESH_MS = 60000;
const ASKING_MS = 10000; // a desk:me unanswered for longer no longer holds an auto refresh back

/** Starts the desk on the page. Returns stop(), or null when it connects nowhere. */
export function boot({ doc = document, win = window } = {}) {
  let url;
  try { url = convexUrlFrom(doc); } catch (err) {
    console.error('Antenne desk:', err.message);
    renderGate({ state: 'misconfigured' });
    return null;
  }
  if (!url) { renderGate({ state: 'not-set-up' }); return null; }

  const desk = { me: null, gen: 0, label: '', call: null, runFailed: false, refresh: () => refresh(false),
    changed: () => publish.load(desk), redraw: () => lanes.redraw() };
  let [kit, signedIn, user, asking] = [null, false, undefined, null];
  for (const panel of [lanes, people, publish]) panel.mount(desk);

  const forget = (account) => {
    desk.me = null;
    if (el('deskDialog').open) el('deskDialog').close(); // a confirm asked of the last caller settles as Cancel
    for (const panel of [lanes, people, publish]) panel.clear();
    if (account) forgetNotices();
  };

  async function refresh(auto) {
    if (!desk.call) return;
    if (auto && asking && Date.now() - asking.at < ASKING_MS) return; // the desk:me on its way answers this one too
    const gen = ++desk.gen;
    asking = { gen, at: Date.now() };
    const me = await desk.call(FN.desk.me);
    if (asking && asking.gen === gen) asking = null;
    if (gen !== desk.gen) return;
    if (!me.ok) { renderGate({ state: 'error', text: explain(me) }); return; }
    if (desk.me && (desk.me.subject !== me.subject || desk.me.role !== me.role)) forget(desk.me.subject !== me.subject);
    desk.me = me;
    const state = !me.signedIn ? (signedIn ? 'unverified' : 'signed-out') : me.role ? 'member' : 'no-role';
    renderGate({ state, me });
    // Each panel clears itself for a caller its role does not cover, and asks nothing.
    await Promise.all([people.load(desk, { auto }), lanes.load(desk, { auto }), publish.load(desk)]);
  }

  const onBanner = (e) => {
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act="sign-in"]') : null;
    if (btn && kit) kit.requireSignIn({ reason: 'Sign in to review Antenne stories.' });
  };
  const onFocus = () => { if (kit) refresh(true); };
  const onVisible = () => { if (doc.visibilityState === 'visible') onFocus(); };
  el('deskBanner').addEventListener('click', onBanner);
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(onVisible, REFRESH_MS);

  import('./neorgon-auth.js').then(({ NeoAuth }) => {
    const call = authedCall(() => loadClient(url), NeoAuth);
    desk.call = async (name, args = {}) => {
      const res = await call(kindOf(name), name, args)
        .catch((err) => { console.error('Antenne desk: ' + name + ' failed.', err && err.message); return null; });
      return res && typeof res === 'object' ? res : { ok: false, code: 'unreachable' };
    };
    NeoAuth.start({ siteName: 'Antenne Desk' });
    NeoAuth.onChange((snap) => {
      [kit, signedIn] = [NeoAuth, !!(snap && snap.signedIn)];
      const next = (snap && snap.userId) || null;
      if (next !== user) { user = next; forget(true); renderGate({ state: 'loading' }); }
      desk.label = snap && typeof snap.label === 'string' ? snap.label : '';
      refresh(false);
    });
  }, (err) => {
    console.error('Antenne desk: the sign-in kit did not load.', err && err.message);
    renderGate({ state: 'error', text: 'The sign-in kit did not load. Check your connection and reload the page.' });
  });

  return function stop() {
    clearInterval(timer);
    el('deskBanner').removeEventListener('click', onBanner);
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisible);
  };
}

boot();
