// Plain node, no install. Run with: make validate
//
// Review F17 (the 2026-11-03 amendment to docs/plans/2026-09-15-antenne-desk.md section 10): a signed
// request replayed inside the signature window. The request digest convex/lib/signature.ts derives and
// convex/lib/routes.ts hands on, including a signature respelled in base64; the replay store of
// convex/lib/replay.ts over tests/support/fakedb.mjs, with /submit and both kinds of /publish/claim run
// through it; and the ghRunId each /publish/* call after the claim must carry. The wrappers wired end to
// end, a replay answered 409 through convex/http.ts among them, are in tests/convex-publish-wired.test.mjs.

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { newDraft } from '../convex/lib/draftsCore.ts';
import * as L from '../convex/lib/limits.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import * as core from '../convex/lib/publishCore.ts';
import * as mach from '../convex/lib/publishMachine.ts';
import { DIGEST_RE, once, recordRequest, refuseIfReplayed } from '../convex/lib/replay.ts';
import { machineRequest } from '../convex/lib/routes.ts';
import { parseMachineKeys, requestDigest, verifyRequest } from '../convex/lib/signature.ts';
import { ingestCore } from '../convex/lib/submitCore.ts';

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
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ── Fixtures, as tests/convex-publish.test.mjs and tests/convex-submit.test.mjs have them ──
const VECTORS = JSON.parse(read('tests/sign-vectors.json')).vectors;
const KEYS = Object.fromEntries(VECTORS.map((v) => [v.keyId, { scopes: v.scopes, secret: v.secret }]));
const MACHINE_KEYS = Object.entries(KEYS).map(([id, k]) => `${id}:${k.scopes.join('+')}:${k.secret}`).join(',');
const [T0, MIN, SHA, MARK] = [Date.UTC(2026, 8, 15, 12), 60000, 'a'.repeat(40), 'SECRET-TEXT'];
const TS = Math.floor(T0 / 1000);
const mac = (keyId, text) => createHmac('sha256', Buffer.from(KEYS[keyId].secret, 'base64')).update(text, 'utf8').digest('base64');
const headersOf = (keyId, ts, signature) => new Headers({ 'X-Antenne-Key': keyId, 'X-Antenne-Timestamp': String(ts), 'X-Antenne-Signature': signature });
const signed = (keyId, path, body, ts = TS) => headersOf(keyId, ts, mac(keyId, `${keyId}.${ts}.${path}.${body}`));
/** The same signature bytes spelled another way: the last character before the padding with its unused low bits flipped. */
function respelled(signature) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const at = signature.indexOf('=') - 1;
  return signature.slice(0, at) + ALPHABET[ALPHABET.indexOf(signature[at]) ^ 1] + signature.slice(at + 1);
}
const ENV = Object.freeze({ DESK_OWNERS: 'user_owner', GITHUB_DISPATCH_TOKEN_EXPIRES: '2027-01-31' });
const GH = access.machineCaller('gh', ['publish']);
const LOCAL = access.machineCaller('local', ['submit', 'status']);
const world = () => countWrites(Object.assign(createFakeDb(), { normalizeId: (table, id) => (typeof id === 'string' && id.startsWith(`${table}:`) ? id : null) }));
const get = (db, id) => db.rows(id.split(':')[0]).find((r) => r._id === id);
const snap = (db) => JSON.stringify(Object.keys(db.schema).map((t) => db.rows(t)));
const POST = (slug, over = {}) => ({
  id: `2026-09-15-${slug}`, date: '2026-09-15', kind: 'feature', site: 'dispatch-site', title: `Title ${slug} ${MARK}`, summary: `A summary ${MARK}.`,
  body: [`A paragraph ${MARK}.`], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'], ...over,
});
async function due(db, slug, at = T0 - MIN) {
  const post = validatePost(POST(slug), { mode: 'desk' }).post;
  const hash = await contentHash(post);
  return db.insert('drafts', { ...newDraft({ post, hash, external: false, source: 'desk', submittedBy: 'user_submitter', assignee: null, now: at - 10 * MIN }), approvedHash: hash, status: 'approved', approvedBy: 'user_editor', approvedAt: at, publishAfter: at, updatedAt: at });
}
let n = 0;
const digest = () => (n += 1).toString(16).padStart(64, '0');
/** Runs fn, then says whether it was refused with code and wrote nothing at all. */
async function refused(db, fn, code, what) {
  const [before, writes] = [snap(db), db.writes()];
  const out = await fn(db);
  eq([out.result.ok, out.result.code, db.writes() - writes, snap(db) === before], [false, code, 0, true], `${what}: ${code}, nothing written`);
  return out.result;
}

// ── The digest ──────────────────────────────────────────────────────────────
await section('signature.ts requestDigest: one value per signed request, the same for the same request however its signature is spelled', async () => {
  const body = JSON.stringify({ stories: [] });
  const h = signed('local', '/submit', body);
  const want = createHash('sha256').update(`local.${TS}.${Buffer.from(h.get('X-Antenne-Signature'), 'base64').toString('hex')}`).digest('hex');
  eq([await requestDigest(h), await requestDigest(signed('local', '/submit', body))], [want, want], 'SHA-256 of keyId.timestamp.signature bytes, and the same again for the same request signed again');
  const others = [signed('local', '/submit', `${body} `), signed('local', '/submit', body, TS + 1), signed('local', '/status', body), signed('ci', '/submit', body)];
  eq(new Set([want, ...(await Promise.all(others.map(requestDigest)))]).size, 5, 'another body, another second, another path or another key is another digest');
  const sig = h.get('X-Antenne-Signature');
  const other = respelled(sig);
  const keys = parseMachineKeys(MACHINE_KEYS);
  eq([other !== sig, (await verifyRequest(headersOf('local', TS, other), '/submit', body, keys, T0))?.keyId], [true, 'local'], 'the fixture: a signature respelled in its unused bits still verifies');
  eq(await requestDigest(headersOf('local', TS, other)), want, 'and gives the same digest, so a respelled replay is still a replay');
  eq([await requestDigest(headersOf('local', TS, 'not base64!')), DIGEST_RE.test(want)], [null, true], 'a signature that does not decode has no digest; a digest is 64 lowercase hex');
  const handed = [];
  const run = async (fn, args) => { handed.push(args.digest); return { ok: true }; };
  await machineRequest('POST', '/submit', h, async () => body, { MACHINE_KEYS }, T0, run);
  await machineRequest('POST', '/submit', headersOf('local', TS, other), async () => body, { MACHINE_KEYS }, T0, run);
  await machineRequest('POST', '/publish/release', signed('gh', '/publish/release', '{"runId":"r","reason":"x"}'), async () => '{"runId":"r","reason":"x"}', { MACHINE_KEYS }, T0, run);
  eq([handed[0], handed[1], handed[2] !== want && DIGEST_RE.test(handed[2])], [want, want, true], 'routes.ts hands each function the digest of the request it verified, the same for a respelled replay');
  const answer = await machineRequest('POST', '/submit', h, async () => body, { MACHINE_KEYS }, T0, async () => ({ ok: false, code: 'replayed', message: 'x' }));
  eq([answer.status, answer.body.code], [409, 'replayed'], 'a replayed refusal is 409');
});

// ── The store ───────────────────────────────────────────────────────────────
await section('replay.ts once(): answered once, recorded only when ok, refused before the core runs, forgotten after REPLAY_KEEP_MS', async () => {
  eq(L.REPLAY_KEEP_MS >= 2 * L.SIGNATURE_WINDOW_MS, true, 'kept for at least the two windows a timestamp verifies across');
  const db = world();
  let ran = 0;
  const ok = async () => { ran += 1; return { result: { ok: true }, intents: [] }; };
  for (const [what, bad] of [['no digest', undefined], ['a digest of 63 characters', '0'.repeat(63)], ['uppercase hex', 'A'.repeat(64)]]) {
    eq([(await refused(db, (x) => once(x, bad, T0, ok), 'invalid', what)).problems, ran], [[{ field: 'digest', code: 'format' }], 0], `${what}: the core never runs`);
  }
  const d = digest();
  eq([(await once(db, d, T0, ok)).result.ok, ran, db.rows('seenRequests').map((r) => [r.digest, r.at])], [true, 1, [[d, T0]]], 'the first time: the core runs, and the request is recorded');
  await refused(db, (x) => once(x, d, T0 + 1, ok), 'replayed', 'the same digest again');
  await refused(db, (x) => once(x, d, T0 + L.REPLAY_KEEP_MS, ok), 'replayed', 'the same digest at exactly REPLAY_KEEP_MS');
  eq([ran, (await once(db, d, T0 + L.REPLAY_KEEP_MS + 1, ok)).result.ok, ran], [1, true, 2], 'a millisecond later it is a new request (its timestamp no longer verifies by then)');
  const no = digest();
  eq([(await once(db, no, T0, async () => ({ result: { ok: false, code: 'status' }, intents: [] }))).result.code, db.rows('seenRequests').some((r) => r.digest === no)], ['status', false], 'a refusal from the core records nothing');
  eq((await once(db, no, T0, ok)).result.ok, true, 'so the same request, once it can be answered, is answered');
  const aged = world();
  for (let i = 0; i < L.REPLAY_PRUNE_MAX + 5; i++) await recordRequest(aged, digest(), T0);
  await recordRequest(aged, digest(), T0 + L.REPLAY_KEEP_MS + 1);
  eq(aged.count('seenRequests'), 6, `a record deletes at most ${L.REPLAY_PRUNE_MAX} aged rows`);
  await recordRequest(aged, digest(), T0 + L.REPLAY_KEEP_MS + 2);
  eq([aged.count('seenRequests'), await refuseIfReplayed(aged, digest(), T0)], [2, null], 'the next one takes the rest; a digest never seen is not refused');
});

await section('/submit through once(): a replay is refused with no draft changed and no quota spent; it cannot put back older machine text', async () => {
  const db = world();
  const [v1, v2] = [POST('machine-story'), POST('machine-story', { summary: `A newer summary ${MARK}.` })];
  const [d1, d2] = [digest(), digest()];
  const send = (x, d, post) => once(x, d, T0, () => ingestCore(x, LOCAL, { stories: [post] }, T0, ENV));
  eq((await send(db, d1, v1)).result.outcomes[0].outcome, 'created', 'the first request creates the draft');
  eq((await send(db, d2, v2)).result.outcomes[0].outcome, 'updated', 'a newer request updates it');
  const rates = db.count('rateEvents');
  await refused(db, (x) => send(x, d1, v1), 'replayed', 'the first request replayed');
  eq([db.rows('drafts')[0].post.summary, db.rows('drafts')[0].machineRev, db.count('rateEvents')], [v2.summary, 2, rates], 'the draft keeps the newer text and its machineRev, and the key\'s hourly quota is untouched');
});

await section('claims through once(): a replayed claim that names no run takes nothing; a replayed named claim cannot retake a requeued run', async () => {
  const db = world();
  const empty = { runId: null, ghRunId: '41', runUrl: null };
  const d = digest();
  eq((await once(db, d, T0, () => mach.claimCore(db, GH, empty, T0, ENV))).result, { ok: true, runId: null, stories: [] }, 'nothing due: no run, and the request is recorded all the same');
  const story = await due(db, 'came-due', T0 + MIN);
  const replay = await refused(db, (x) => once(x, d, T0 + 2 * MIN, () => mach.claimCore(x, GH, empty, T0 + 2 * MIN, ENV)), 'replayed', 'that claim replayed once a story is due');
  eq([JSON.stringify(replay).includes(MARK), db.count('publishRuns'), get(db, story).status], [false, 0, 'approved'], 'no story text answered, no run created, the story still approved for the next real run');
  const { runId } = await core.queueRun(db, 'approve', T0, T0);
  const [claim5, release5] = [digest(), digest()];
  const named = (x, ghRunId, at) => mach.claimCore(x, GH, { runId, ghRunId, runUrl: null }, at, ENV);
  eq((await once(db, claim5, T0 + 3 * MIN, () => named(db, '5', T0 + 3 * MIN))).result.stories.length, 1, 'GH run 5 claims the named run');
  await once(db, release5, T0 + 4 * MIN, () => mach.releaseCore(db, GH, { runId, ghRunId: '5', reason: 'build' }, T0 + 4 * MIN, ENV));
  eq([get(db, runId).state, get(db, runId).attempts, get(db, story).status], ['queued', 1, 'approved'], 'it fails before its push and releases: the run is requeued');
  await refused(db, (x) => once(x, claim5, T0 + 5 * MIN, () => named(x, '5', T0 + 5 * MIN)), 'replayed', 'GH run 5\'s claim replayed against the requeued run');
  await refused(db, (x) => once(x, release5, T0 + 5 * MIN, () => mach.releaseCore(x, GH, { runId, ghRunId: '5', reason: 'build' }, T0 + 5 * MIN, ENV)), 'replayed', 'and its release replayed, which would spend an attempt');
  eq([(await once(db, digest(), T0 + 6 * MIN, () => named(db, '6', T0 + 6 * MIN))).result.stories.length, get(db, runId).ghRunId, get(db, runId).attempts], [1, '6', 1], 'GH run 6, dispatched by reconcile, claims it as usual');
});

// ── ghRunId: the workflow run that claimed ──────────────────────────────────
await section('conflict, pushed, built and release: only from the workflow run whose claim the run recorded', async () => {
  const cases = [['conflictCore', 'claimed', { storyIds: [] }], ['pushedCore', 'claimed', { sha: SHA, noChange: false }], ['builtCore', 'pushed', { sha: SHA, pagesStatus: 'built' }], ['releaseCore', 'claimed', { reason: 'build' }]];
  for (const [name, state, args] of cases) {
    const db = world();
    const runId = await db.insert('publishRuns', core.runRow('approve', T0, T0, { state, ghRunId: '42', commitSha: SHA }));
    const call = (ghRunId) => (x) => mach[name](x, GH, { runId, ...args, ...(ghRunId === undefined ? {} : { ghRunId }) }, T0, ENV);
    const other = await refused(db, call('41'), 'status', `${name} from GH run 41 for a run GH run 42 claimed`);
    eq([other.message, other.state], ['Another workflow run holds this claim.', state], `${name}: the refusal says why`);
    await refused(db, call(undefined), 'status', `${name} with no ghRunId, as a request from before F17`);
    await refused(db, call(null), 'status', `${name} with ghRunId null`);
    eq((await refused(db, call('4x'), 'invalid', `${name} with a ghRunId that is not digits`)).problems.at(-1), { field: 'ghRunId', code: 'format' }, `${name}: invalid names the field`);
    eq((await mach[name](db, GH, { runId, ...args, ghRunId: '42' }, T0, ENV)).result.ok, true, `${name} from GH run 42 is answered`);
    const local = world();
    const unbound = await local.insert('publishRuns', core.runRow('push', T0, T0, { state, commitSha: SHA }));
    await refused(local, (x) => mach[name](x, GH, { runId: unbound, ...args, ghRunId: '42' }, T0, ENV), 'status', `${name}: a local run's claim recorded no GH run, so a GH run's call is refused`);
    eq((await mach[name](local, GH, { runId: unbound, ...args, ghRunId: null }, T0, ENV)).result.ok, true, `${name}: and its own call, with ghRunId null, is answered`);
  }
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
