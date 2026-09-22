// ── Desk publishing: the status bar ──────────────────────────
// publish:status for owners, editors and reviewers: the last run's state,
// what started it, a link to the GitHub run, what went wrong in words, the
// counts on their way out, and a warning while the dispatch token nears its
// expiry. Owners and editors also get "Publish now", and "Retry" once the last
// run failed (publish:retry refuses anything else). A submitter has no
// publish.read, so the bar is never asked for. Whether the last run failed is
// kept on the desk (runFailed) for the lanes, which then word a due approval
// as waiting for Retry: reconcile queues nothing for it meanwhile.

import { FN, explain } from './desk-api.js';
import { agoHtml, can, el, sayLater, swap } from './desk-ui.js';
import { escHtml } from './utils.js';

export const RUN_STATE_TEXT = Object.freeze({
  queued: 'Queued',
  dispatched: 'Dispatched to GitHub',
  claimed: 'Claimed by the workflow',
  pushed: 'Pushed, waiting for the Pages build',
  built: 'Built, being verified',
  done: 'Done',
  failed: 'Failed',
});

export const TRIGGER_TEXT = Object.freeze({
  approve: 'an approval',
  now: 'Publish now',
  retry: 'Retry',
  push: 'a push to main or a manual run', // claimCore records push for any claim that names no run
  reconcile: 'the reconcile pass',
});

// The stage words scripts/publish-approved.py releases with ("error" is its catch-all, worded apart below).
const STAGE_TEXT = Object.freeze({
  claim: 'claim check', conflict: 'conflict report', merge: 'merge', build: 'feed build', check: 'feed check',
  'diff-guard': 'diff guard', 'bot-id': 'bot identity', commit: 'commit', push: 'push', pushed: 'push report', git: 'git',
  'dry-run': 'dry run',
});

const FIXED_ERRORS = Object.freeze({
  'dispatch timeout': 'GitHub did not answer the dispatch in time.',
  'dispatch network': 'The dispatch could not reach GitHub.',
  'dispatch no-token': 'No dispatch token is set: an owner sets GITHUB_DISPATCH_TOKEN on the deployment.',
  'dispatch stale': 'The workflow was dispatched but never claimed its stories within 20 minutes.',
  'claim stale': 'The workflow claimed its stories but did not push within 30 minutes, so they went back to approved.',
  'verify stale': 'The push landed but was never verified against the commit.',
  'built stale': 'Every story reached the commit, but the Pages build never reported back.',
  'dispatch unknown': 'The dispatch to GitHub failed in a way the backend did not recognise.',
  attempts: 'The run used up its attempts.',
});

/** The run's stored error (always a short ASCII code, publish-bridge) as a sentence. */
export function errorText(error) {
  const e = typeof error === 'string' ? error : '';
  let m = /^dispatch (\d{3})$/.exec(e);
  if (m) {
    const s = Number(m[1]);
    if (s === 401 || s === 403) return 'GitHub refused the dispatch token (' + s + '): it was revoked, it expired, or it lacks Actions read and write.';
    if (s === 404) return 'GitHub could not find the publish workflow or the repository (404).';
    if (s === 422) return 'GitHub refused the dispatch request (422): a bad ref or bad inputs.';
    return 'GitHub answered the dispatch with status ' + s + '.';
  }
  if (Object.prototype.hasOwnProperty.call(FIXED_ERRORS, e)) return FIXED_ERRORS[e];
  m = /^released ([a-z][a-z0-9-]{0,39})$/.exec(e); // REASON_RE in convex/lib/publishMachine.ts
  if (m && m[1] === 'error') return 'The workflow hit an unexpected error before pushing, and released its stories back to approved.';
  if (m) return 'The workflow failed at its ' + (STAGE_TEXT[m[1]] || m[1]) + ' step before pushing, and released its stories back to approved.';
  m = /^verify ([a-z0-9-]+)$/.exec(e);
  if (m) return 'The pushed commit\'s data/posts.json could not be read (' + m[1] + ').';
  return 'The run failed (' + (e.slice(0, 80) || 'no reason recorded') + ').';
}

/** Only a GitHub Actions run page is linked; anything else stays text. */
export const RUN_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

function todayUtc(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** A YYYY-MM-DD that is a real calendar day, as the watchdog reads tokenExpires (2026-02-30 is not). */
export function realDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === value;
}

// Stage 7 alone: without ANTENNE_RENEW=1 the wizard runs on to stage 12, and stage 8 exits once the App key
// was deleted as stage 9 offers (plan section 10, the review decisions of 2026-09-22, F36).
export const RENEW_COMMAND = 'ANTENNE_RENEW=1 scripts/setup-antenne.sh 7';

export function tokenText(expires, now) {
  if (!realDay(expires)) {
    return 'The GitHub dispatch token has no readable expiry date, so nothing warns before it stops working: '
      + 'an owner sets GITHUB_DISPATCH_TOKEN_EXPIRES next to it, as YYYY-MM-DD (' + RENEW_COMMAND + ').';
  }
  if (expires < todayUtc(now)) {
    return 'The GitHub dispatch token expired on ' + expires + ': approvals will not publish until an owner rotates it (' + RENEW_COMMAND + ').';
  }
  return 'The GitHub dispatch token expires on ' + expires + ': an owner should rotate it before then (' + RENEW_COMMAND + ').';
}

const COUNTS = [['approved', 'approved'], ['publishing', 'publishing'], ['committed', 'committed'], ['live', 'live this week']];
const TONE = Object.freeze({ done: 'ok', failed: 'bad' });

/** The bar for one publish:status answer, as markup (every value escaped). */
export function statusHtml(status, role, now = Date.now()) {
  const run = status && status.lastRun && typeof status.lastRun === 'object' ? status.lastRun : null;
  let html = '<div class="desk-status__run">';
  if (run) {
    const n = Number.isInteger(run.stories) ? run.stories : 0;
    html += '<span class="desk-chip desk-chip--' + (TONE[run.state] || 'warn') + '" data-run-state="' + escHtml(run.state) + '">'
      + escHtml(RUN_STATE_TEXT[run.state] || 'Unknown state') + '</span>'
      + '<span>Last run ' + agoHtml(typeof run.createdAt === 'number' ? run.createdAt : now - run.ageMs, now) + ', started by ' + escHtml(TRIGGER_TEXT[run.trigger] || 'an unknown trigger')
      + ', ' + n + (n === 1 ? ' story' : ' stories')
      + (Number.isInteger(run.attempts) && run.attempts > 1 ? ', attempt ' + run.attempts : '')
      + (run.followUp === true ? ', another run follows' : '') + '.</span>'
      + (typeof run.runUrl === 'string' && RUN_URL_RE.test(run.runUrl)
        ? '<a href="' + escHtml(run.runUrl) + '" target="_blank" rel="noopener noreferrer">Open the workflow run</a>' : '');
  } else {
    html += '<span>No publish run yet.</span>';
  }
  html += '</div>';
  if (run && run.state === 'failed') html += '<p class="desk-status__error">' + escHtml(errorText(run.error)) + '</p>';
  else if (run && typeof run.error === 'string' && run.error) html += '<p class="desk-status__warn">' + escHtml('Earlier attempt: ' + errorText(run.error)) + '</p>';
  // Near or past the expiry, everyone who reads the bar; with no readable expiry (the watchdog's seventh
  // condition), the owners and editors who can have it set.
  const tokenLine = status && (status.tokenWarning === true || (can(role, 'publish.trigger') && !realDay(status.tokenExpires)));
  if (tokenLine) html += '<p class="desk-status__warn" data-token-warning>' + escHtml(tokenText(status.tokenExpires, now)) + '</p>';
  const counts = status && status.counts && typeof status.counts === 'object' ? status.counts : null;
  if (counts) {
    html += '<p class="desk-status__counts">' + COUNTS.map(([k, label]) => (Number.isInteger(counts[k]) ? counts[k] : 0) + ' ' + label).join(', ') + '</p>';
  }
  if (can(role, 'publish.trigger')) {
    html += '<div class="toolbar">'
      + '<button type="button" class="btn btn--primary btn--sm" data-act="publish-now">Publish now</button>'
      + (run && run.state === 'failed' ? '<button type="button" class="btn btn--secondary btn--sm" data-act="retry">Retry</button>' : '')
      + '</div>';
  }
  return html;
}

let desk = null;
let loads = 0;

/**
 * Asks publish:status (publish.read roles only) and renders the bar. An answer
 * is drawn only if no later load has started (loads) and the desk has not
 * moved on to another desk:me since (gen), for the role it was asked as.
 */
export async function load(ctx) {
  if (!ctx.me || !can(ctx.me.role, 'publish.read')) { clear(ctx); return; }
  const mine = ++loads;
  const gen = ctx.gen;
  const role = ctx.me.role;
  const res = await ctx.call(FN.publish.status);
  if (mine !== loads || gen !== ctx.gen) return;
  swap(el('publishBar'), res.ok ? statusHtml(res, role) : '<p>' + escHtml(explain(res)) + '</p>');
  if (res.ok) runFailed(ctx, !!(res.lastRun && res.lastRun.state === 'failed'));
}

/** Empties the bar and drops any load still on its way. */
export function clear(ctx = desk) {
  loads += 1;
  swap(el('publishBar'), '');
  if (ctx) runFailed(ctx, false);
}

function runFailed(ctx, failed) {
  if (ctx.runFailed === failed) return;
  ctx.runFailed = failed;
  if (typeof ctx.redraw === 'function') ctx.redraw();
}

async function onClick(e) {
  const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act]') : null;
  if (!btn) return;
  const act = btn.dataset.act;
  if (act !== 'publish-now' && act !== 'retry') return;
  const tell = sayLater();
  const res = await desk.call(act === 'retry' ? FN.publish.retry : FN.publish.now, {});
  if (res.ok) tell(act === 'retry' ? 'Retry requested: a new run starts now.' : 'Publish requested: due approvals go out now, and the bar follows the run.');
  else tell(explain(res, { status: 'Only a failed run can be retried, and the last run did not fail.' }));
  await load(desk);
}

/** Binds the bar's listener to the page, once per boot. */
export function mount(ctx) {
  desk = ctx;
  el('publishBar').addEventListener('click', onClick);
}
