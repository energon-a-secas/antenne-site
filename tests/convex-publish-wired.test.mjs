// Plain node, no install. Run with: make validate
//
// The publish bridge's wrappers (docs/plans/2026-09-15-antenne-desk.md sections 4.2, 4.3, 5 and 6.1):
// convex/publish.ts, links.ts, drafts.ts, submit.ts, http.ts and crons.ts run end to end over
// tests/support/fakedb.mjs, through stand-ins for convex/server and convex/_generated, since neither
// exists without an install or a deployment. Only what a wrapper does is checked here: the env it reads,
// the schedules it makes from a core's intents, and that the dispatch token reaches no row, log line or
// answer, plus one story's path through them (a conflict note cleared by the next claim) and the dry-run
// scenarios of the 2026-09-22 review end to end (a dry run after a failed run keeps publishing paused). The
// cores are tested in tests/convex-publish.test.mjs, which this file was split from for the 500-line cap.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createFakeDb } from './support/fakedb.mjs';
import { newDraft } from '../convex/lib/draftsCore.ts';
import * as L from '../convex/lib/limits.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import * as core from '../convex/lib/publishCore.ts';
import * as net from '../convex/lib/publishFetch.ts';

let [failed, checks] = [0, 0];
function eq(actual, expected, what) {
  checks += 1;
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) return true;
  failed += 1;
  console.error(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
  return false;
}
async function section(title, fn) {
  const before = [failed, checks];
  await fn();
  const n = checks - before[1];
  if (failed === before[0]) console.log(`ok   ${title} (${n} checks)`);
  else console.error(`FAIL ${title}: ${failed - before[0]} of ${n} checks`);
}

// The same fixtures as tests/convex-publish.test.mjs.
const [T0, MIN, SHA, MARK, TOKEN] = [Date.UTC(2026, 8, 15, 12), 60000, 'a'.repeat(40), 'SECRET-TEXT', 'dispatch-token-never-stored-5f1e9c'];
const [OWNER, EDITOR, REVIEWER, SUBMITTER] = ['user_owner', 'user_editor', 'user_reviewer', 'user_submitter'];
const world = () => Object.assign(createFakeDb(), { normalizeId: (table, id) => (typeof id === 'string' && id.startsWith(`${table}:`) ? id : null) });
async function people(db) {
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  return db;
}
const POST = (slug, over = {}) => ({
  id: `2026-09-15-${slug}`, date: '2026-09-15', kind: 'feature', site: 'dispatch-site', title: `Title ${slug} ${MARK}`, summary: `A summary ${MARK}.`,
  body: [`A paragraph ${MARK}.`], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'], ...over,
});
const TODAY = () => new Date().toISOString().slice(0, 10);
const fresh = (slug) => ({ ...POST(slug), id: `${TODAY()}-${slug}`, date: TODAY() });
async function draft(db, slug, fields = {}, over = {}) {
  const [post, status] = [validatePost(POST(slug, over), { mode: 'desk' }).post, fields.status ?? 'pending'];
  const hash = await contentHash(post);
  return db.insert('drafts', { ...newDraft({ post, hash, external: false, source: 'desk', submittedBy: SUBMITTER, assignee: null, now: T0 - 10 * MIN }), approvedHash: status === 'pending' ? null : hash, ...fields });
}
const due = (at = T0 - MIN) => ({ status: 'approved', approvedBy: EDITOR, approvedAt: at, publishAfter: at, updatedAt: at });
const run = (db, state, extra = {}) => db.insert('publishRuns', core.runRow('approve', T0 - 30 * MIN, T0 - 30 * MIN, { state, ...extra }));
const get = (db, id) => db.rows(id.split(':')[0]).find((r) => r._id === id);
const reply = (status, body = null) => ({ status, json: async () => { if (body === null) throw new SyntaxError('no body'); return body; }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const VECTORS = JSON.parse(readFileSync(new URL('./sign-vectors.json', import.meta.url), 'utf8')).vectors;
const KEYS = Object.fromEntries(VECTORS.map((v) => [v.keyId, { scopes: v.scopes, secret: v.secret }]));
const MACHINE_KEYS = Object.entries(KEYS).map(([id, k]) => `${id}:${k.scopes.join('+')}:${k.secret}`).join(',');
const signed = (keyId, path, body, ts) => new Headers({ 'X-Antenne-Key': keyId, 'X-Antenne-Timestamp': String(ts), 'X-Antenne-Signature': createHmac('sha256', Buffer.from(KEYS[keyId].secret, 'base64')).update(`${keyId}.${ts}.${path}.${body}`).digest('base64') });

// ── Stand-ins, the modules, and a ctx ───────────────────────────────────────
const STAND_INS = {
  'convex/server': 'export function httpRouter() { const routes = []; return { routes, route(spec) { routes.push(spec); } }; } export function cronJobs() { const jobs = []; const add = (kind) => (name, schedule, ref, args) => { jobs.push({ kind, name, schedule, fn: ref.name, args }); }; return { jobs, interval: add("interval"), daily: add("daily"), hourly: add("hourly"), cron: add("cron") }; }',
  'convex/values': 'export const v = new Proxy({}, { get: (_, kind) => (...args) => ({ kind, args }) });',
  './_generated/server': 'const reg = (kind) => (def) => ({ ...def, kind }); export const httpAction = (fn) => ({ kind: "http", run: fn }); export const internalMutation = reg("mutation"); export const internalQuery = reg("query"); export const internalAction = reg("action"); export const mutation = reg("mutation"); export const query = reg("query"); export const action = reg("action");',
  './_generated/api': 'const ref = (p) => new Proxy({ name: p.join(":") }, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : k in t ? t[k] : ref([...p, k])) }); export const internal = ref([]);',
};
registerHooks({
  resolve(specifier, context, next) {
    const stand = STAND_INS[specifier];
    if (stand && (!specifier.startsWith('.') || /\/convex\/[^/]+\.ts$/.test(context.parentURL ?? ''))) return { url: `data:text/javascript,${encodeURIComponent(stand)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const mods = { publish: await import('../convex/publish.ts'), links: await import('../convex/links.ts'), drafts: await import('../convex/drafts.ts'), submit: await import('../convex/submit.ts') };
const crons = (await import('../convex/crons.ts')).default;
const router = (await import('../convex/http.ts')).default;

/** A ctx over db: the scheduler records each call; runQuery and runMutation record the name and run that handler. */
function harness(db, subject = EDITOR) {
  const h = { db, subject, scheduled: [], ran: [] };
  const fn = (ref) => mods[ref.name.split(':')[0]][ref.name.split(':')[1]];
  const call = async (ref, a) => { h.ran.push(ref.name); return fn(ref).handler(h.ctx, a); };
  h.ctx = {
    db, runQuery: call, runMutation: call,
    auth: { getUserIdentity: async () => (h.subject === null ? null : { subject: h.subject }) },
    scheduler: { runAfter: async (ms, ref, args) => { h.scheduled.push(['after', ms, ref.name, args]); }, runAt: async (at, ref, args) => { h.scheduled.push(['at', at, ref.name, args]); } },
  };
  return h;
}
const BASE_ENV = { DESK_OWNERS: OWNER, DESK_FROZEN: '', DESK_DENY: '', GITHUB_DISPATCH_TOKEN: TOKEN, GITHUB_DISPATCH_TOKEN_EXPIRES: '2026-10-01', MACHINE_KEYS };
/** Runs fn with BASE_ENV and over in process.env; the env, fetch and the console are restored after. */
async function withEnv(over, fn) {
  const [saved, realFetch, log, err] = [{ ...process.env }, globalThis.fetch, console.log, console.error];
  Object.assign(process.env, BASE_ENV, over);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    [console.log, console.error] = [log, err];
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const machine = (h, name, body) => mods.publish[name].handler(h.ctx, { keyId: 'gh', scopes: ['publish'], path: `/publish/${name}`, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── End to end ──────────────────────────────────────────────────────────────
await section('wired: approvals schedule publish:dispatch at publishAfter, /submit and recheck schedule links:check, the crons', () => withEnv({}, async () => {
  eq(crons.jobs.map((j) => [j.kind, j.fn, j.schedule]), [['interval', 'publish:reconcile', { minutes: 10 }], ['interval', 'publish:checkLive', { minutes: 10 }], ['daily', 'publish:sweep', { hourUTC: 4, minuteUTC: 41 }]], 'reconcile and checkLive every 10 minutes, sweep daily');
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
  eq(sorted(Object.fromEntries(Object.entries(mods.publish).map(([k, f]) => [k, f.kind]))), sorted({ status: 'query', now: 'mutation', retry: 'mutation', claim: 'mutation', conflict: 'mutation', pushed: 'mutation', built: 'mutation', release: 'mutation', dispatch: 'action', beginDispatch: 'mutation', dispatchResult: 'mutation', verifyCommit: 'action', recordCommit: 'mutation', checkLive: 'action', liveWanted: 'query', recordLive: 'mutation', reconcile: 'mutation', sweep: 'mutation' }), 'publish.ts exports these, as these kinds');
  const h = harness(await people(world()));
  const { db, ctx, scheduled } = h;
  const logged = [];
  console.log = console.error = (...a) => logged.push(a.join(' '));
  const [a, b] = [await draft(db, 'wa'), await draft(db, 'wb')];
  const ok = await mods.drafts.approve.handler(ctx, { draftId: a, expectedRev: 1 });
  const runId = db.rows('publishRuns')[0]._id;
  eq([ok.ok, scheduled.at(-1)], [true, ['at', ok.publishAfter, 'publish:dispatch', { runId }]], 'approve: one queued run, dispatch scheduled with runAt at publishAfter');
  await mods.drafts.approveMany.handler(ctx, { items: [{ draftId: b, expectedRev: 1 }] });
  eq([db.count('publishRuns'), get(db, runId).followUp], [1, true], 'approveMany during it: the same run, followUp');
  await mods.drafts.recheckLinks.handler(ctx, { draftId: a });
  eq(scheduled.at(-1), ['after', 0, 'links:check', { draftId: a }], 'recheckLinks schedules links:check');
  const story = fresh('wired');
  await mods.submit.ingest.handler(ctx, { keyId: 'local', scopes: ['submit'], path: '/submit', body: JSON.stringify({ stories: [story] }) });
  const created = db.rows('drafts').find((d) => d.storyId === story.id)._id;
  eq(scheduled.at(-1), ['after', 0, 'links:check', { draftId: created }], '/submit: each created draft gets links:check');
  h.subject = OWNER;
  eq((await mods.publish.status.handler(ctx, {})).tokenWarning, true, 'publish:status reads GITHUB_DISPATCH_TOKEN_EXPIRES from the env');
  const [sent, answers, outs] = [[], [reply(500), null, reply(401), reply(204)], []];
  globalThis.fetch = async (url, init) => { sent.push([url, init.headers.Authorization]); const next = answers.shift(); if (next === null) throw new Error(`socket hang up, ${init.headers.Authorization}`); return next; };
  for (let i = 0; i < 4; i++) outs.push(await mods.publish.dispatch.handler(ctx, { runId }));
  eq([outs, get(db, runId).state, get(db, runId).attempts, sent.every(([u, hd]) => u === net.DISPATCH_URL && hd === `Bearer ${TOKEN}`)], [['failed', 'failed', 'failed', 'dispatched'], 'dispatched', 3, true], 'dispatch: 500, a throw and 401 each spend an attempt; 204 dispatches');
  eq([JSON.stringify(Object.keys(db.schema).map((t) => db.rows(t))).includes(TOKEN), logged.join('\n').includes(TOKEN), JSON.stringify(outs).includes(TOKEN)], [false, false, false], 'the dispatch token is in no stored row, no log line and no return value');
  await db.patch(runId, { state: 'done' });
  const probe = await run(db, 'queued', { runAt: T0 });
  [process.env.DESK_FROZEN, sent.length] = ['1', 0];
  eq([await mods.publish.dispatch.handler(ctx, { runId: probe }), sent.length, get(db, probe).state], ['frozen', 0, 'queued'], 'frozen: dispatch sends nothing and changes nothing');
  process.env.DESK_FROZEN = '';
  await db.patch(probe, { state: 'pushed', commitSha: SHA });
  const held = await draft(db, 'wv', { ...due(), status: 'publishing', claimRun: probe, claimedAt: T0 });
  globalThis.fetch = async (url) => (url === net.rawArchiveUrl(SHA) ? reply(200, JSON.stringify({ posts: [get(db, held).post] })) : reply(404));
  eq([await mods.publish.verifyCommit.handler(ctx, { runId: probe, sha: SHA }), get(db, held).status, db.rows('publishedIds').map((r) => r.storyId)], ['read', 'committed', ['2026-09-15-wv']], 'verifyCommit reads the file at the sha: committed, publishedIds resynced');
  globalThis.fetch = async (url) => (url === net.LIVE_URL ? reply(200, JSON.stringify({ posts: [get(db, held).post] })) : reply(404));
  eq([await mods.publish.checkLive.handler(ctx, {}), get(db, held).status, await mods.publish.checkLive.handler(ctx, {})], ['read', 'live', 'nothing committed'], 'checkLive: committed to live, then no read with nothing committed');
  globalThis.fetch = async (url) => reply(url.includes('gone') ? 404 : 200);
  const d404 = await draft(db, 'w404', {}, { links: [{ label: 'Gone', url: 'https://gone.neorgon.com/x' }] });
  eq([await mods.links.check.handler(ctx, { draftId: a }), await mods.links.check.handler(ctx, { draftId: d404 })], ['checked', 'checked'], 'links:check runs for an approved and a pending draft');
  eq([get(db, a).linkChecks, get(db, d404).linkChecks], [[{ url: 'https://dispatch.neorgon.com/desk.html', status: 200, blocking: false }], [{ url: 'https://gone.neorgon.com/x', status: 404, blocking: true }]], 'links:record stores each check; a neorgon 404 blocks');
  const body = JSON.stringify({ runId: null, ghRunId: '5', runUrl: null });
  const answer = await router.routes.find((r) => r.path === '/publish/claim').handler.run(ctx, new Request('https://happy-otter-123.convex.site/publish/claim', { method: 'POST', headers: signed('gh', '/publish/claim', body, Math.floor(Date.now() / 1000)), body }));
  eq([answer.status, await answer.json(), get(db, probe).followUp], [200, { ok: true, runId: null, stories: [] }, true], 'http.ts: a signed /publish/claim reaches publish:claim; with a run active it only sets followUp');
}));

await section('http.ts: each signed /publish/* path runs its own publish function', () => withEnv({}, async () => {
  const h = harness(world());
  const bodies = { claim: { runId: null }, conflict: { runId: 'publishRuns:9', storyIds: [] }, pushed: { runId: 'publishRuns:9', sha: SHA, noChange: true }, built: { runId: 'publishRuns:9', sha: SHA, pagesStatus: 'built' }, release: { runId: 'publishRuns:9', reason: 'dry-run' } };
  for (const [name, doc] of Object.entries(bodies)) {
    const [path, text, before] = [`/publish/${name}`, JSON.stringify(doc), h.ran.length];
    const answer = await router.routes.find((r) => r.path === path).handler.run(h.ctx, new Request(`https://happy-otter-123.convex.site${path}`, { method: 'POST', headers: signed('gh', path, text, Math.floor(Date.now() / 1000)), body: text }));
    eq([answer.status, h.ran.slice(before)], [name === 'claim' ? 200 : 404, [`publish:${name}`]], `${path}: publish:${name} ran, and only it (an unknown run is 404)`);
  }
}));

await section('a claim clears the conflict note: a story sent back, approved again and published carries no "Sent back by publishing"', () => withEnv({}, async () => {
  const h = harness(await people(world()), EDITOR);
  const { db, ctx } = h;
  const d = await draft(db, 'resent', due());
  const storyId = get(db, d).storyId;
  const first = await machine(h, 'claim', { runId: null, ghRunId: '5', runUrl: null });
  await machine(h, 'conflict', { runId: first.runId, storyIds: [storyId] });
  eq([first.stories.map((x) => x.storyId), get(db, d).status, get(db, d).note], [[storyId], 'pending', 'conflict'], 'claimed, then sent back: pending, noted');
  await db.patch(first.runId, { state: 'done' });
  const approved = await mods.drafts.approve.handler(ctx, { draftId: d, expectedRev: get(db, d).rev });
  eq([approved.ok, get(db, d).note], [true, 'conflict'], 'approved again: the note stays until a run takes the story');
  await db.patch(d, { publishAfter: Date.now() - 1 });
  const kept = await draft(db, 'kept-note', { ...due(), note: 'an owner note' });
  const runId = db.rows('publishRuns').at(-1)._id;
  const second = await machine(h, 'claim', { runId, ghRunId: '6', runUrl: null });
  eq([second.stories.map((x) => x.storyId).sort(), get(db, d).status, get(db, d).note, get(db, kept).note], [[storyId, get(db, kept).storyId].sort(), 'publishing', null, 'an owner note'], 'claimed again: the conflict note is gone, any other note stays');
  await machine(h, 'pushed', { runId, sha: SHA, noChange: false });
  const archive = [d, kept].map((id) => ({ storyId: get(db, id).storyId, contentHash: get(db, id).approvedHash }));
  await mods.publish.recordCommit.handler(ctx, { runId, sha: SHA, stories: archive, complete: true });
  await mods.publish.recordLive.handler(ctx, { stories: archive });
  eq([get(db, d).status, get(db, d).note], ['live', null], 'committed, then live, with no send-back chip');
}));

// ── follow(): every intent a publish core returns becomes a schedule ────────
await section('publish.ts follow(): now, retry and reconcile dispatch at runAt; pushed and reconcile ask for verifyCommit; finished runs dispatch their follow-up', () => withEnv({}, async () => {
  const h = harness(await people(world()), OWNER);
  const { db, ctx, scheduled } = h;
  const now = await mods.publish.now.handler(ctx, {});
  eq([now.ok, scheduled], [true, [['at', get(db, now.runId).runAt, 'publish:dispatch', { runId: now.runId }]]], 'publish:now: runAt at the run\'s runAt, not runAfter');
  eq([(await mods.publish.now.handler(ctx, {})).runId, get(db, now.runId).followUp, scheduled.length], [now.runId, true, 1], 'publish:now during it: followUp, nothing scheduled twice');
  await db.patch(now.runId, { state: 'failed' });
  const retry = await mods.publish.retry.handler(ctx, {});
  eq(scheduled.at(-1), ['at', get(db, retry.runId).runAt, 'publish:dispatch', { runId: retry.runId }], 'publish:retry: a new run, dispatched at its runAt');
  const before = Date.now();
  await mods.publish.reconcile.handler(ctx, {});
  const [kind, at, name, args] = scheduled.at(-1);
  eq([kind, at >= before && at <= Date.now(), name, args, scheduled.length], ['at', true, 'publish:dispatch', { runId: retry.runId }, 3], 'reconcile: a queued run past its runAt is dispatched at now');
  await db.patch(retry.runId, { state: 'pushed', commitSha: SHA, updatedAt: Date.now() });
  await mods.publish.reconcile.handler(ctx, {});
  eq(scheduled.at(-1), ['after', 0, 'publish:verifyCommit', { runId: retry.runId, sha: SHA }], 'reconcile: a pushed run asks for verifyCommit now');
  await db.patch(retry.runId, { state: 'done' });
  const c = await run(db, 'claimed', { followUp: true });
  eq([await machine(h, 'pushed', { runId: c, sha: SHA, noChange: false }), scheduled.at(-1)], [{ ok: true }, ['after', 0, 'publish:verifyCommit', { runId: c, sha: SHA }]], '/publish/pushed: verifyCommit now, with the run and the sha');
  eq((await machine(h, 'pushed', 'not json')).code, 'malformed', 'a route body that is not JSON is malformed');
  await machine(h, 'built', { runId: c, sha: SHA, pagesStatus: 'built' });
  let next = db.rows('publishRuns').at(-1);
  eq([get(db, c).state, next.trigger, scheduled.at(-1)], ['done', 'reconcile', ['at', next.runAt, 'publish:dispatch', { runId: next._id }]], '/publish/built: done, and the follow-up dispatched at its runAt');
  await db.patch(next._id, { state: 'done' });
  const [sent, spent] = [[], await run(db, 'queued', { attempts: L.RUN_MAX_ATTEMPTS, followUp: true, runAt: T0 })];
  globalThis.fetch = async (url) => { sent.push(url); return reply(500); };
  eq([await mods.publish.dispatch.handler(ctx, { runId: spent }), sent.length, get(db, spent).state], ['failed', 0, 'failed'], 'dispatch of a run out of attempts: failed, no request');
  next = db.rows('publishRuns').at(-1);
  eq(scheduled.at(-1), ['at', next.runAt, 'publish:dispatch', { runId: next._id }], 'beginDispatch: the failed run\'s follow-up is dispatched');
  await db.patch(next._id, { state: 'done' });
  const last = await run(db, 'queued', { attempts: L.RUN_MAX_ATTEMPTS - 1, followUp: true, runAt: T0 });
  eq([await mods.publish.dispatch.handler(ctx, { runId: last }), sent.length, get(db, last).error], ['failed', 1, 'dispatch 500'], 'a 500 on the last attempt fails the run');
  next = db.rows('publishRuns').at(-1);
  eq([next._id !== last, scheduled.at(-1)], [true, ['at', next.runAt, 'publish:dispatch', { runId: next._id }]], 'dispatchResult: its follow-up is dispatched');
  await db.patch(next._id, { state: 'built', commitSha: SHA, followUp: true });
  const held = await draft(db, 'follow', { ...due(), status: 'publishing', claimRun: next._id, claimedAt: T0 });
  globalThis.fetch = async () => reply(200, JSON.stringify({ posts: [get(db, held).post] }));
  await mods.publish.verifyCommit.handler(ctx, { runId: next._id, sha: SHA });
  const after = db.rows('publishRuns').at(-1);
  eq([get(db, next._id).state, get(db, held).status, scheduled.at(-1)], ['done', 'committed', ['at', after.runAt, 'publish:dispatch', { runId: after._id }]], 'recordCommit: the last story committed on a built run, done, and its follow-up dispatched');
}));

await section('submit.ts hands MACHINE_KEYS to /submit: every configured key\'s pending drafts count toward the cap, not only the caller\'s', () => withEnv({}, async () => {
  const h = harness(world());
  for (let i = 0; i < L.MACHINE_PENDING_MAX; i++) await draft(h.db, `ci-${i}`, { source: 'machine', humanTouched: false, submittedBy: 'key:ci' });
  const ingest = async () => (await mods.submit.ingest.handler(h.ctx, { keyId: 'local', scopes: ['submit'], path: '/submit', body: JSON.stringify({ stories: [fresh('one-more')] }) })).outcomes.map((o) => o.outcome);
  eq(await ingest(), ['queue-full'], `the ci key holds ${L.MACHINE_PENDING_MAX}: a story from the local key is queue-full`);
  process.env.MACHINE_KEYS = MACHINE_KEYS.split(',').filter((e) => !e.startsWith('ci:')).join(',');
  eq(await ingest(), ['created'], 'with ci no longer configured, its drafts stop counting');
}));

// ── Dry runs (the review decision of 2026-09-22) ────────────────────────────
const lastRun = async (h) => [(await mods.publish.status.handler(h.ctx, {})).lastRun?.runId ?? null, (await mods.submit.status.handler(h.ctx, { keyId: 'watch', scopes: ['status'], path: '/status', body: '{}' })).lastRun?.runId ?? null];
const dispatches = (h) => h.scheduled.filter((x) => x[2] === 'publish:dispatch').length;
await section('a dry run after a failed run: its run is trigger dryrun; done, failed or gone stale, reconcile stays paused, lastRun is the failed run, Retry works', () => withEnv({}, async () => {
  for (const ending of ['dry-run', 'merge', 'stale']) {
    const h = harness(await people(world()), OWNER);
    const { db, ctx } = h;
    const failed = await run(db, 'failed', { error: 'dispatch 401' });
    const d = await draft(db, `dry-${ending}`, due());
    eq([(await mods.publish.reconcile.handler(ctx, {})).acted, db.count('publishRuns')], [[], 1], `${ending}: before, the failed run pauses reconcile`);
    const claimed = await machine(h, 'claim', { runId: null, ghRunId: '8', runUrl: null, dryRun: true });
    const dry = get(db, claimed.runId);
    eq([claimed.stories.map((x) => x.storyId), dry.trigger, dry.state, get(db, d).status], [[get(db, d).storyId], 'dryrun', 'claimed', 'publishing'], `${ending}: the dry run claims the due story into a run with trigger dryrun`);
    if (ending === 'stale') await db.patch(dry._id, { claimedAt: Date.now() - L.CLAIM_STALE_MS - 1 });
    else await machine(h, 'release', { runId: dry._id, reason: ending });
    const acted = (await mods.publish.reconcile.handler(ctx, {})).acted;
    eq([get(db, dry._id).state, get(db, d).status, db.count('publishRuns'), dispatches(h)], [ending === 'dry-run' ? 'done' : 'failed', 'approved', 2, 0], `${ending}: the dry run's run ends ${ending === 'dry-run' ? 'done' : 'failed'} and is never queued; the story is approved; no run is dispatched`);
    eq([acted.includes('queued'), (await mods.publish.reconcile.handler(ctx, {})).acted, await lastRun(h)], [false, [], [failed, failed]], `${ending}: reconcile queues nothing, and publish:status and /status name the failed run`);
    const retry = await mods.publish.retry.handler(ctx, {});
    eq([retry.ok ? get(db, retry.runId).trigger : retry.code, dispatches(h), await lastRun(h)], ['retry', 1, [retry.runId, retry.runId]], `${ending}: Retry still works, and its run is the last run`);
  }
}));

await section('a dry run is not a trigger: during an active run it takes nothing and sets no followUp; after a good run its released story is published as usual', () => withEnv({}, async () => {
  const h = harness(await people(world()), OWNER);
  const { db, ctx } = h;
  const active = await run(db, 'dispatched', { dispatchedAt: Date.now() });
  const d = await draft(db, 'waiting', due());
  eq([await machine(h, 'claim', { runId: null, dryRun: true }), get(db, active).followUp, get(db, d).status], [{ ok: true, runId: null, stories: [] }, false, 'approved'], 'a dry run during an active run: nothing taken, no followUp');
  await db.patch(active, { state: 'done' });
  const claimed = await machine(h, 'claim', { runId: null, dryRun: true });
  await machine(h, 'release', { runId: claimed.runId, reason: 'dry-run' });
  const acted = (await mods.publish.reconcile.handler(ctx, {})).acted;
  const next = db.rows('publishRuns').at(-1);
  eq([acted, next.trigger, dispatches(h), await lastRun(h)], [['queued'], 'reconcile', 1, [next._id, next._id]], 'the last real run was done: reconcile queues a real run for the released story, as it would have without the dry run');
  const text = (doc) => JSON.stringify(doc);
  const answers = [];
  for (const dryRun of [true, false, 'yes', 1, null]) {
    const body = text({ runId: null, ...(dryRun === null ? { dryRun: null } : { dryRun }) });
    const reply = await router.routes.find((r) => r.path === '/publish/claim').handler.run(ctx, new Request('https://happy-otter-123.convex.site/publish/claim', { method: 'POST', headers: signed('gh', '/publish/claim', body, Math.floor(Date.now() / 1000)), body }));
    answers.push([reply.status, (await reply.json()).code ?? 'ok']);
  }
  eq(answers, [[200, 'ok'], [200, 'ok'], [400, 'malformed'], [400, 'malformed'], [400, 'malformed']], 'http.ts: dryRun true or false passes; any other value is 400 malformed');
  const runs = db.count('publishRuns');
  eq([(await machine(h, 'claim', { runId: null, dryRun: 'yes' })).problems, db.count('publishRuns')], [[{ field: 'dryRun', code: 'format' }], runs], 'and publish:claim itself answers invalid for it, writing no run');
}));

// ── The env each wrapper reads ──────────────────────────────────────────────
await section('publish.ts reads DESK_DENY and DESK_FROZEN: a denied owner cannot publish and reads nothing; frozen refuses now and retry', () => withEnv({ DESK_DENY: OWNER }, async () => {
  const h = harness(await people(world()), OWNER);
  await run(h.db, 'failed', { error: 'dispatch 401' });
  const [now, retry, status] = [await mods.publish.now.handler(h.ctx, {}), await mods.publish.retry.handler(h.ctx, {}), await mods.publish.status.handler(h.ctx, {})];
  eq([now.code, retry.code, status, h.scheduled, h.db.count('publishRuns')], ['not-member', 'not-member', { ok: true, lastRun: null, counts: null, tokenExpires: null, tokenWarning: false }, [], 1], 'an owner listed in DESK_DENY: not-member for now and retry, empty status, nothing scheduled');
  process.env.DESK_DENY = '';
  eq((await mods.publish.status.handler(h.ctx, {})).lastRun.error, 'dispatch 401', 'the same owner, not denied, reads the last run');
  process.env.DESK_FROZEN = '1';
  eq([(await mods.publish.now.handler(h.ctx, {})).code, (await mods.publish.retry.handler(h.ctx, {})).code, h.scheduled, h.db.count('publishRuns')], ['frozen', 'frozen', [], 1], 'DESK_FROZEN=1: now and retry answer frozen, nothing queued');
}));

await section('links.ts reads DESK_FROZEN: while frozen links:check sends nothing and records nothing', () => withEnv({ DESK_FROZEN: '1' }, async () => {
  const h = harness(world());
  const [d, sent] = [await draft(h.db, 'frozen-links'), []];
  globalThis.fetch = async (url) => { sent.push(url); return reply(404); };
  eq([await mods.links.check.handler(h.ctx, { draftId: d }), sent, get(h.db, d).linkChecks], ['skipped', [], null], 'frozen: skipped, no request, nothing recorded');
  eq((await mods.links.record.handler(h.ctx, { draftId: d, checks: [] })).code, 'frozen', 'links:record refuses while frozen');
  process.env.DESK_FROZEN = '';
  eq([await mods.links.check.handler(h.ctx, { draftId: d }), sent], ['checked', ['https://dispatch.neorgon.com/desk.html']], 'unfrozen: the draft\'s link is checked');
}));

await section('sweep: a full batch schedules another pass, a short one does not, and frozen deletes nothing', () => withEnv({}, async () => {
  const h = harness(world());
  for (let i = 0; i < core.SWEEP_BATCH + 1; i++) await h.db.insert('rateEvents', { bucket: 'x|draft.write', at: Date.now() - 40 * 24 * 60 * MIN });
  eq([(await mods.publish.sweep.handler(h.ctx, {})).deleted.rateEvents, h.scheduled], [core.SWEEP_BATCH, [['after', 0, 'publish:sweep', {}]]], `${core.SWEEP_BATCH} deleted, and another pass scheduled`);
  process.env.DESK_FROZEN = '1';
  eq([(await mods.publish.sweep.handler(h.ctx, {})).code, h.db.count('rateEvents'), h.scheduled.length], ['frozen', 1, 1], 'frozen: nothing deleted, nothing scheduled');
  process.env.DESK_FROZEN = '';
  eq([(await mods.publish.sweep.handler(h.ctx, {})).deleted.rateEvents, h.db.count('rateEvents'), h.scheduled.length], [1, 0, 1], 'the rest in a short pass, and no further one');
}));

await section('drafts.ts: a desk submit and an edit that changes the link urls schedule links:check; a text edit, an unchanged or a refused one does not', () => withEnv({}, async () => {
  const h = harness(await people(world()), SUBMITTER);
  const post = fresh('desk-links');
  const out = await mods.drafts.submit.handler(h.ctx, { post });
  eq([out.ok, h.scheduled], [true, [['after', 0, 'links:check', { draftId: out.draftId }]]], 'submit: the new draft gets links:check');
  const edited = await mods.drafts.edit.handler(h.ctx, { draftId: out.draftId, expectedRev: 1, patch: { links: [{ label: 'Hub', url: 'https://neorgon.com/' }] } });
  eq([edited.rev, h.scheduled.length, h.scheduled.at(-1)], [2, 2, ['after', 0, 'links:check', { draftId: out.draftId }]], 'an edit that changes the url set: checked again');
  const text = await mods.drafts.edit.handler(h.ctx, { draftId: out.draftId, expectedRev: 2, patch: { title: 'A new title', links: [{ label: 'The hub', url: 'https://neorgon.com/' }] } });
  eq([text.rev, h.scheduled.length], [3, 2], 'an edit of the title and a link label, the same url set: saved, no check');
  eq([(await mods.drafts.edit.handler(h.ctx, { draftId: out.draftId, expectedRev: 3, patch: { links: [] } })).rev, h.scheduled.at(-1), h.scheduled.length], [4, ['after', 0, 'links:check', { draftId: out.draftId }], 3], 'removing the last url changes the set: checked');
  eq([(await mods.drafts.edit.handler(h.ctx, { draftId: out.draftId, expectedRev: 4, patch: {} })).rev, h.scheduled.length], [4, 3], 'an edit that changes nothing: no check');
  eq([(await mods.drafts.edit.handler(h.ctx, { draftId: out.draftId, expectedRev: 1, patch: { links: [] } })).code, h.scheduled.length], ['stale', 3], 'a stale edit: no check');
  eq([(await mods.drafts.submit.handler(h.ctx, { post })).code, h.scheduled.length], ['duplicate-id', 3], 'a refused submit: no check');
}));

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
