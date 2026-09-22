// Plain node, no install. Run with: make validate
//
// js/desk-publish.js, the desk's publishing status bar (docs/plans/2026-09-15-antenne-desk.md
// section 7, and the run states and error codes publish-bridge stores).
//
// This file used to test the old desk's showSaveFilePicker publish (queue #64):
// where the browser saved data/posts.json, and what the toast said about it.
// Section 7 deleted that publish, so its cases left with it. Publishing is now
// a GitHub workflow Convex dispatches, and what the desk owes the reader is
// the state of the last run, a link to it, what went wrong in words, a warning
// before the dispatch token expires, "Publish now" and "Retry" for owners
// and editors only, and never a late answer drawn over a newer one.
//
// The answers come from the real publish:status, publish:now and publish:retry
// cores over tests/support/fakedb.mjs, so the bar is tested against the shape
// the server actually returns.

import { readFileSync } from 'node:fs';
import { fire, installDom, loadPage, parseHtml } from './support/fakedom.mjs';
import { createFakeDb } from './support/fakedb.mjs';
import { resolveCaller } from '../convex/lib/access.ts';
import { publishNowCore, publishRetryCore, publishStatusCore, runRow } from '../convex/lib/publishCore.ts';

installDom();
loadPage(readFileSync(new URL('../desk.html', import.meta.url), 'utf8'));
const P = await import('../js/desk-publish.js');

let [failed, checks] = [0, 0];
function eq(actual, expected, what) {
  checks += 1;
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) { console.log(`ok   ${what}`); return; }
  failed += 1;
  console.error(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
}
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

const DAY = 86400000;
const NOW = Date.now();
const [OWNER, EDITOR, REVIEWER, SUBMITTER] = ['user_owner', 'user_editor', 'user_reviewer', 'user_submitter'];
const RUN_URL = 'https://github.com/energon-a-secas/dispatch-site/actions/runs/123456/attempts/2';
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function world({ run = null, expires = iso(NOW + 200 * DAY) } = {}) {
  const db = Object.assign(createFakeDb(), { normalizeId: (t, id) => (typeof id === 'string' && id.startsWith(`${t}:`) ? id : null) });
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) {
    await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: NOW });
  }
  if (run) await db.insert('publishRuns', runRow(run.trigger || 'approve', NOW - 20 * 60000, NOW - 20 * 60000, run));
  const env = { DESK_OWNERS: OWNER, GITHUB_DISPATCH_TOKEN_EXPIRES: expires };
  const calls = [];
  const answer = async (subject, name) => {
    const caller = await resolveCaller(db, subject, env);
    if (name === 'publish:status') return publishStatusCore(db, caller, {}, Date.now(), env);
    const core = name === 'publish:now' ? publishNowCore : publishRetryCore;
    return (await core(db, caller, {}, Date.now(), env)).result;
  };
  /** A desk as desk.js hands it to the module: me, and call(name, args). */
  const desk = (subject, role) => ({
    me: { signedIn: true, subject, role },
    gen: 0,
    call: async (name, args = {}) => { calls.push([name, args]); return JSON.parse(JSON.stringify(await answer(subject, name))); },
  });
  return { db, calls, desk, status: (subject) => answer(subject, 'publish:status') };
}
const tree = (html) => parseHtml(html);
const buttons = (html) => tree(html).querySelectorAll('[data-act]').map((b) => b.dataset.act);

console.log('desk publishing status bar');

// ── The last run: its state, what started it, the link ──────────────────────
{
  const w = await world({ run: { state: 'dispatched', trigger: 'approve', runUrl: RUN_URL, storyIds: ['a', 'b'], attempts: 2, followUp: true } });
  const t = tree(P.statusHtml(await w.status(EDITOR), 'editor', NOW));
  eq(t.querySelector('[data-run-state]').textContent, 'Dispatched to GitHub', 'the last run state, in words');
  eq(t.querySelector('.desk-status__run').textContent.includes('Last run 20 min ago, started by an approval, 2 stories, attempt 2, another run follows'), true, 'its age, what started it, its stories, its attempt and the follow-up');
  eq(t.querySelector('a').getAttribute('href'), RUN_URL, 'and a link to the workflow run');
  const pushed = await world({ run: { state: 'done', trigger: 'push' } });
  eq(tree(P.statusHtml(await pushed.status(EDITOR), 'editor', NOW)).textContent.includes('started by a push to main or a manual run,'), true, 'a run no dispatch named (a push, make publish-now, the Actions tab) is not called a push alone');
  eq([t.querySelector('a').getAttribute('target'), t.querySelector('a').getAttribute('rel')], ['_blank', 'noopener noreferrer'], 'opened apart from the desk');
  for (const bad of ['javascript:alert(1)', 'https://github.com.evil.example/a/b/actions/runs/1', 'https://github.com/a/b/actions/runs/1/../../../x', 'http://github.com/a/b/actions/runs/1']) {
    const w2 = await world({ run: { state: 'failed', runUrl: bad, error: 'attempts' } });
    eq(tree(P.statusHtml(await w2.status(OWNER), 'owner', NOW)).querySelector('a'), null, `a run URL that is not a GitHub Actions run is not linked: ${bad}`);
  }
  const none = tree(P.statusHtml(await (await world()).status(OWNER), 'owner', NOW));
  eq([none.textContent.includes('No publish run yet.'), none.querySelector('[data-run-state]')], [true, null], 'before the first run, it says there has been none');
  const counts = tree(P.statusHtml({ ok: true, lastRun: null, counts: { approved: 3, publishing: 1, committed: 2, live: 7 }, tokenWarning: false }, 'reviewer', NOW));
  eq(counts.querySelector('.desk-status__counts').textContent, '3 approved, 1 publishing, 2 committed, 7 live this week', 'the counts on their way out');
}

// ── What went wrong, in words ───────────────────────────────────────────────
{
  const CODES = ['dispatch 401', 'dispatch 403', 'dispatch 404', 'dispatch 422', 'dispatch 502', 'dispatch timeout', 'dispatch network',
    'dispatch no-token', 'dispatch stale', 'dispatch unknown', 'claim stale', 'released diff-guard', 'released push', 'released step2',
    'released pushed', 'released error', 'released claim', 'verify 404', 'verify format', 'verify stale', 'built stale', 'attempts'];
  const said = CODES.map(P.errorText);
  eq(said.filter((s) => !/^[A-Z][^<>]*\.$/.test(s)), [], 'each stored error code becomes a sentence');
  eq(new Set(said).size, CODES.length, 'and no two read the same');
  eq(P.errorText('dispatch 401').includes('revoked, it expired, or it lacks Actions read and write'), true, 'a refused token says why that happens');
  eq(P.errorText('released diff-guard'), 'The workflow failed at its diff guard step before pushing, and released its stories back to approved.', 'a release names its stage');
  eq(['released step2', 'built stale', 'dispatch unknown'].map(P.errorText).filter((t) => t.startsWith('The run failed (')), [], 'every error publish-bridge stores has its own words, digits in a release reason included');
  eq([P.errorText('released pushed'), P.errorText('released error')], ['The workflow failed at its push report step before pushing, and released its stories back to approved.',
    'The workflow hit an unexpected error before pushing, and released its stories back to approved.'], "publish-approved.py's failed no-change report and its catch-all are named as what they are");
  const w = await world({ run: { state: 'failed', error: '<img src=x onerror=alert(1)>' } });
  const html = P.statusHtml(await w.status(OWNER), 'owner', NOW);
  eq([tree(html).querySelectorAll('img').length, html.includes('&lt;img src=x onerror=alert(1)&gt;')], [0, true], 'an error that is not a known code stays text');
  const w2 = await world({ run: { state: 'dispatched', error: 'dispatch timeout' } });
  eq(tree(P.statusHtml(await w2.status(OWNER), 'owner', NOW)).querySelector('.desk-status__warn').textContent, 'Earlier attempt: GitHub did not answer the dispatch in time.', 'a run still going shows its last error as a warning, not a failure');
}

// ── The token warning ───────────────────────────────────────────────────────
{
  // tokenExpires null (unset or not YYYY-MM-DD) or not a real day: the watchdog's seventh condition, token-unknown.
  for (const expires of [null, '2026/10/01', '2026-02-30']) {
    const w = await world({ expires });
    const line = async (subject, role) => tree(P.statusHtml(await w.status(subject), role, NOW)).querySelector('[data-token-warning]');
    const [owner, editor] = [await line(OWNER, 'owner'), await line(EDITOR, 'editor')];
    eq([owner && owner.textContent, editor && editor.textContent].map((t) => typeof t === 'string' && t.startsWith('The GitHub dispatch token has no readable expiry date')), [true, true], `an expiry the watchdog calls unknown (${expires}) is said to owners and editors`);
  }
  eq(tree(P.statusHtml(await (await world({ expires: null })).status(REVIEWER), 'reviewer', NOW)).querySelector('[data-token-warning]'), null, 'a reviewer, who cannot have it set, is not told');
  eq([P.realDay('2026-10-01'), P.realDay('2026-02-30'), P.realDay('2026/10/01'), P.realDay(null)], [true, false, false, false], 'a real calendar day, as the watchdog reads one');
}
{
  const soon = iso(NOW + 12 * DAY);
  const w = await world({ expires: soon });
  const status = await w.status(OWNER);
  const warn = tree(P.statusHtml(status, 'owner', NOW)).querySelector('[data-token-warning]');
  eq([status.tokenWarning, warn && warn.textContent], [true, `The GitHub dispatch token expires on ${soon}: an owner should rotate it before then (ANTENNE_RENEW=1 scripts/setup-antenne.sh 7).`], 'within 30 days of its expiry, the bar warns with the date');
  // F36: scripts/setup-antenne.sh 7 alone runs stages 7 to 12, and stage 8 exits once the App key is gone.
  const sentences = [null, iso(NOW - 3 * DAY), soon].map((expires) => P.tokenText(expires, NOW));
  eq([P.RENEW_COMMAND, sentences.map((t) => t.endsWith('(ANTENNE_RENEW=1 scripts/setup-antenne.sh 7).')), sentences.some((t) => /stage 7|setup-antenne\.sh 7\)/.test(t.replace('ANTENNE_RENEW=1 scripts/setup-antenne.sh 7)', '')))],
    ['ANTENNE_RENEW=1 scripts/setup-antenne.sh 7', [true, true, true], false], 'every token sentence names the renewal that stops after stage 7, and none the run that goes on to stage 12');
  const gone = iso(NOW - 3 * DAY);
  const w2 = await world({ expires: gone });
  eq(tree(P.statusHtml(await w2.status(OWNER), 'owner', NOW)).querySelector('[data-token-warning]').textContent.startsWith(`The GitHub dispatch token expired on ${gone}`), true, 'past it, the bar says it expired');
  eq(tree(P.statusHtml(await (await world()).status(OWNER), 'owner', NOW)).querySelector('[data-token-warning]'), null, 'and far from it, nothing');
}

// ── Publish now and Retry: owner and editor only; Retry only after a failure ──
{
  const failedRun = { state: 'failed', error: 'dispatch 401' };
  for (const [subject, role, expected] of [[OWNER, 'owner', ['publish-now', 'retry']], [EDITOR, 'editor', ['publish-now', 'retry']], [REVIEWER, 'reviewer', []]]) {
    const w = await world({ run: failedRun });
    eq(buttons(P.statusHtml(await w.status(subject), role, NOW)), expected, `after a failed run, ${role}: ${expected.join(' and ') || 'no buttons'}`);
  }
  const w = await world({ run: { state: 'done' } });
  eq(buttons(P.statusHtml(await w.status(EDITOR), 'editor', NOW)), ['publish-now'], 'after a run that did not fail, Publish now and no Retry');
  eq((await w.status(SUBMITTER)).code, 'forbidden', 'a submitter has no publish.read on the server');
}

// ── On the page: load, the buttons, and what the desk says ──────────────────
{
  const say = () => document.getElementById('deskNotice').textContent;
  const bar = () => document.getElementById('publishBar');
  const w = await world({ run: { state: 'failed', error: 'claim stale' } });
  const desk = w.desk(EDITOR, 'editor');
  P.mount(desk);
  await P.load(desk);
  eq(w.calls, [['publish:status', {}]], 'load asks publish:status once');
  eq(bar().querySelector('.desk-status__error').textContent, P.errorText('claim stale'), 'and renders the failure in words');
  fire(bar().querySelector('[data-act="retry"]'), 'click');
  await settle();
  eq(w.calls.map((c) => c[0]), ['publish:status', 'publish:retry', 'publish:status'], 'Retry sends publish:retry, then reloads the bar');
  eq([w.calls[1][1], say(), w.db.rows('publishRuns').length], [{}, 'Retry requested: a new run starts now.', 2], 'with no arguments, and a new run exists');
  eq(bar().querySelector('[data-act="retry"]'), null, 'the new run has not failed, so Retry is gone');

  const stale = await world({ run: { state: 'failed', error: 'attempts' } });
  const other = stale.desk(OWNER, 'owner');
  P.mount(other);
  await P.load(other);
  await publishRetryCore(stale.db, await resolveCaller(stale.db, OWNER, { DESK_OWNERS: OWNER }), {}, Date.now(), { DESK_OWNERS: OWNER });
  fire(bar().querySelector('[data-act="retry"]'), 'click');
  await settle();
  eq(say(), 'Only a failed run can be retried, and the last run did not fail.', 'a Retry someone else already sent is refused with status, and worded for a run');
  fire(bar().querySelector('[data-act="publish-now"]'), 'click');
  await settle();
  eq([stale.calls.slice(-2).map((c) => c[0]), say()], [['publish:now', 'publish:status'], 'Publish requested: due approvals go out now, and the bar follows the run.'], 'Publish now sends publish:now and reloads');

  const reviewer = (await world({ run: { state: 'failed' } })).desk(REVIEWER, 'reviewer');
  P.mount(reviewer);
  await P.load(reviewer);
  eq(bar().querySelectorAll('[data-act]').length, 0, 'a reviewer reads the bar and gets no buttons');
  const sub = await world();
  await P.load(sub.desk(SUBMITTER, 'submitter'));
  eq([sub.calls, bar().innerHTML], [[], ''], 'a submitter is never asked about, and the bar is empty');
}

// ── Late answers: a bar is drawn only from the newest load, for the caller it was asked as ──
{
  const bar = () => document.getElementById('publishBar');
  /** Holds the first answer desk.call gives until the returned function is called. */
  const holdFirst = (desk) => {
    const call = desk.call;
    let open = null;
    desk.call = async (name, args) => { const res = await call(name, args); if (open === null) await new Promise((r) => { open = r; }); return res; };
    return () => open();
  };
  const w = await world({ run: { state: 'failed', error: 'attempts' } });
  const desk = w.desk(EDITOR, 'editor');
  const release = holdFirst(desk);
  const older = P.load(desk);
  await settle();
  await publishRetryCore(w.db, await resolveCaller(w.db, OWNER, { DESK_OWNERS: OWNER }), {}, Date.now(), { DESK_OWNERS: OWNER });
  await P.load(desk);
  release();
  await older;
  eq(bar().querySelector('[data-run-state]').dataset.runState, 'queued', 'an older answer that lands after a newer one is dropped');
  const w2 = await world({ run: { state: 'failed', error: 'attempts' } });
  const gone = w2.desk(EDITOR, 'editor');
  const release2 = holdFirst(gone);
  const late = P.load(gone);
  await settle();
  Object.assign(gone, { gen: 1, me: { signedIn: true, subject: EDITOR, role: null } });
  await P.load(gone);
  release2();
  await late;
  eq(bar().innerHTML, '', 'an answer asked for before the desk moved on (the role went) draws nothing');
  const w3 = await world({ run: { state: 'failed', error: 'attempts' } });
  const same = w3.desk(EDITOR, 'editor');
  const release3 = holdFirst(same);
  const cut = P.load(same);
  await settle();
  same.me = { signedIn: true, subject: EDITOR, role: null };
  await P.load(same);
  release3();
  await cut;
  eq(bar().innerHTML, '', 'nor one cut short by a load that cleared the bar, even with gen unchanged');
  const w4 = await world({ run: { state: 'failed', error: 'attempts' } });
  const lanes = { ...w4.desk(EDITOR, 'editor'), redraws: 0 };
  lanes.redraw = () => { lanes.redraws += 1; };
  await P.load(lanes);
  await P.load(lanes);
  eq([lanes.runFailed, lanes.redraws], [true, 1], 'a failed last run is kept on the desk for the lanes, which redraw once when that changes');
}

console.log(failed ? `\ndesk publish: ${failed} of ${checks} checks failed` : `\ndesk publish: all ${checks} checks pass`);
process.exit(failed ? 1 : 0);
