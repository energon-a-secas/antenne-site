// ── Shared utilities ─────────────────────────────────────────
// Small, pure helper functions used across multiple modules.

/** Cached element lookup by ID. */
const _els = {};
export function $(id) {
  return _els[id] || (_els[id] = document.getElementById(id));
}

/** Escape HTML special characters. */
export function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Show a temporary toast notification. Pass a longer ms for toasts that
    carry an instruction rather than a confirmation. */
let _toastTimer = null;
export function showToast(msg, ms = 2000) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    // role=status implies aria-live=polite; the region must exist before the
    // text lands or screen readers never announce it.
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  requestAnimationFrame(() => {
    el.textContent = msg;
    el.classList.add('visible');
  });
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
}

/** Simple debounce. */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-25" → "Aug 25, 2026". Parsed by hand: `new Date('YYYY-MM-DD')`
    is UTC midnight and shifts a day in western timezones. */
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return SHORT_MONTHS[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
}

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "2026-08-25" → "August 25, 2026", or null for anything that names no real
    calendar day, so a caller can say what it says about a broken date rather
    than printing "February 30, 2026".

    A round trip through Date.UTC, not the schema's dayNumber: that one is a
    frozen export contract shared with convex/lib/post.ts and this is display.
    The two agree on which strings are real days, which is what matters, because
    scripts/build-feed.py stamps this same line at publish time through its own
    day_number and a disagreement would show as the date changing after load. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const [y, mo, d] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d) return null;
  return LONG_MONTHS[mo - 1] + ' ' + d + ', ' + y;
}
