// Plain node, no install. Run with: make validate
//
// The machine routes (docs/plans/2026-09-15-antenne-desk.md section 5): signature.ts against
// tests/sign-vectors.json and every way a signature can be wrong; the routes.ts pipeline through each
// status code; every /submit outcome and the /status projection over tests/support/fakedb.mjs; and
// last, http.ts and submit.ts wired end to end with convex/server and convex/_generated replaced by
// stand-ins, since neither exists without an install or a deployment.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { countWrites, createFakeDb } from './support/fakedb.mjs';
import * as access from '../convex/lib/access.ts';
import { approveCore, editCore, newDraft, queueCore, spikeCore, submitCore } from '../convex/lib/draftsCore.ts';
import { BODY_MAX_BYTES, MACHINE_PENDING_MAX, SIGNATURE_WINDOW_MS, SUBMIT_BATCH_MAX } from '../convex/lib/limits.ts';
import { contentHash, validatePost } from '../convex/lib/post.ts';
import { ROUTES, assertRoutes, machineRequest, utf8Length } from '../convex/lib/routes.ts';
import { SCOPE_PATHS, machineKeyIds, parseMachineKeys, scopeForPath, verifyRequest } from '../convex/lib/signature.ts';
import { ingestCore, meterCore, statusCore } from '../convex/lib/submitCore.ts';

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
const noComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ── Keys and signing ────────────────────────────────────────────────────────
const VECTORS = JSON.parse(read('tests/sign-vectors.json')).vectors;
const KEYS = Object.fromEntries(VECTORS.map((v) => [v.keyId, { scopes: v.scopes, secret: v.secret }]));
const MACHINE_KEYS = Object.entries(KEYS).map(([id, k]) => `${id}:${k.scopes.join('+')}:${k.secret}`).join(',');
const TS = 1789000000;
const NOW = TS * 1000;
const mac = (secret, text) => createHmac('sha256', Buffer.from(secret, 'base64')).update(text, 'utf8').digest('base64');
function signed(keyId, path, body, ts = TS, extra = {}) {
  const secret = KEYS[keyId]?.secret ?? KEYS.local.secret;
  return new Headers({ 'X-Antenne-Key': keyId, 'X-Antenne-Timestamp': String(ts), 'X-Antenne-Signature': mac(secret, `${keyId}.${ts}.${path}.${body}`), ...extra });
}

await section('convex/lib/signature.ts accepts every vector, and refuses a swapped path, another key, a stale or future timestamp', async () => {
  const keys = parseMachineKeys(MACHINE_KEYS);
  eq([...keys.keys()].sort(), ['ci', 'gh', 'local', 'watch'], 'the vectors hold four keys');
  for (const v of VECTORS) {
    const h = new Headers({ 'X-Antenne-Key': v.keyId, 'X-Antenne-Timestamp': v.timestamp, 'X-Antenne-Signature': v.signature });
    const at = Number(v.timestamp) * 1000;
    const got = await verifyRequest(h, v.path, v.body, keys, at);
    eq([got?.keyId, got?.scopes], [v.keyId, v.scopes], `${v.name}: accepted, as its key with its scopes`);
    const swap = v.path === '/status' ? '/submit' : '/status';
    const other = v.keyId === 'watch' ? 'local' : 'watch';
    const otherKey = new Headers({ 'X-Antenne-Key': other, 'X-Antenne-Timestamp': v.timestamp, 'X-Antenne-Signature': v.signature });
    const refusals = [
      await verifyRequest(h, swap, v.body, keys, at), await verifyRequest(otherKey, v.path, v.body, keys, at),
      await verifyRequest(h, v.path, `${v.body} `, keys, at), await verifyRequest(h, v.path, v.body, keys, at + SIGNATURE_WINDOW_MS + 1000),
      await verifyRequest(h, v.path, v.body, keys, at - SIGNATURE_WINDOW_MS - 1000),
    ];
    eq(refusals, [null, null, null, null, null], `${v.name}: a path swap, another key id, a changed body, stale and future are refused`);
    const edges = [await verifyRequest(h, v.path, v.body, keys, at + SIGNATURE_WINDOW_MS), await verifyRequest(h, v.path, v.body, keys, at - SIGNATURE_WINDOW_MS)];
    eq(edges.map((k) => k?.keyId), [v.keyId, v.keyId], `${v.name}: exactly ${SIGNATURE_WINDOW_MS} ms either way is still accepted`);
  }
  const v = VECTORS[0];
  const good = { 'X-Antenne-Key': v.keyId, 'X-Antenne-Timestamp': v.timestamp, 'X-Antenne-Signature': v.signature };
  const at = Number(v.timestamp) * 1000;
  for (const [what, over] of [['no key header', { 'X-Antenne-Key': '' }], ['a timestamp in milliseconds', { 'X-Antenne-Timestamp': `${v.timestamp}000` }],
    ['a signed timestamp with a plus sign', { 'X-Antenne-Timestamp': `+${v.timestamp}` }], ['a signature that is not base64', { 'X-Antenne-Signature': '%%%%' }],
    ['a signature without its padding', { 'X-Antenne-Signature': v.signature.replace(/=+$/, '') }]]) {
    eq(await verifyRequest(new Headers({ ...good, ...over }), v.path, v.body, keys, at), null, `${what} is refused`);
  }
  const rotated = parseMachineKeys(MACHINE_KEYS.replace(KEYS.local.secret, Buffer.alloc(32, 9).toString('base64')));
  eq(await verifyRequest(new Headers(good), v.path, v.body, rotated, at), null, 'the same key id with another secret refuses the old signature');
});

await section('MACHINE_KEYS: malformed entries are skipped, a twice-listed key id is dropped, unset is no keys', () => {
  const s32 = Buffer.alloc(32, 1).toString('base64');
  const parsed = (raw) => [...parseMachineKeys(raw).values()].map((k) => `${k.keyId}:${k.scopes.join('+')}:${k.secret.length}`);
  eq(parsed(` ok:submit+status:${s32} , a-2:publish:${Buffer.alloc(40, 2).toString('base64')}`), ['ok:submit+status:32', 'a-2:publish:40'], 'two good entries, trimmed');
  const bad = [`Upper:submit:${s32}`, `${'k'.repeat(33)}:submit:${s32}`, `k:admin:${s32}`, `k::${s32}`, `k:submit+submit:${s32}`, `k:submit+:${s32}`,
    `k:submit:${Buffer.alloc(31, 1).toString('base64')}`, 'k:submit:not*base64', `k:submit:${s32.replace(/=$/, '')}`, `k:submit:${s32}:x`, `k:submit`, ''];
  for (const entry of bad) eq(parsed(`${entry},ok:status:${s32}`), ['ok:status:32'], `skipped: ${JSON.stringify(entry.slice(0, 40))}`);
  eq(parsed(`k:submit:${s32},k:status:${s32},ok:status:${s32}`), ['ok:status:32'], 'a key id listed twice is dropped, both times');
  eq([parsed(undefined), parsed(null), parsed(''), parsed(' , ')], [[], [], [], []], 'unset, null, empty and blank give no keys');
  const noAtob = (fn) => { const saved = globalThis.atob; globalThis.atob = () => { throw new Error('atob'); }; try { return fn(); } catch { return 'needs atob'; } finally { globalThis.atob = saved; } };
  eq([...bad, `a-2:publish:${Buffer.alloc(40, 2).toString('base64')}`, `k:submit:${s32},k:status:${s32}`, `ok:submit:${s32}`].map((e) => [noAtob(() => machineKeyIds(`${e},ok:status:${s32}`)), [...parseMachineKeys(`${e},ok:status:${s32}`).keys()]]), [...bad.map(() => [['ok'], ['ok']]), [['a-2', 'ok'], ['a-2', 'ok']], [['ok'], ['ok']], [[], []]], 'machineKeyIds names the keys parseMachineKeys keeps, and decodes no secret, so a mutation can call it');
  eq(Object.entries(SCOPE_PATHS).flatMap(([s, paths]) => paths.map((p) => [p, scopeForPath(p) === s])).every(([, ok]) => ok), true, 'scopeForPath reads SCOPE_PATHS');
  eq([scopeForPath('/submit'), scopeForPath('/status'), scopeForPath('/publish/claim'), scopeForPath('/publish'), scopeForPath('/submit/')], ['submit', 'status', 'publish', null, null], 'section 5 paths map to their scope, nothing else does');
});

await section('signature.ts: crypto.subtle.verify alone decides, once per request whatever the key; a timestamp that is not plain seconds is refused', async () => {
  const [keys, body] = [parseMachineKeys(MACHINE_KEYS), '{"stories":[]}'];
  // A plain header source, not Headers, which would trim the spaces some of these timestamps carry.
  const from = (map) => ({ get: (name) => map[name] ?? null });
  const signedAs = (keyId, ts, sig = mac(KEYS[keyId]?.secret ?? KEYS.local.secret, `${keyId}.${ts}./submit.${body}`)) => from({ 'X-Antenne-Key': keyId, 'X-Antenne-Timestamp': ts, 'X-Antenne-Signature': sig });
  const real = crypto.subtle.verify;
  const [answers, cost] = [[], []];
  try {
    crypto.subtle.verify = function (...a) { const p = real.apply(this, a); answers.push(p); return p; };
    for (const [keyId, now] of [['local', NOW], ['nobody', NOW], ['local', NOW + SIGNATURE_WINDOW_MS + 1000]]) {
      const before = answers.length;
      const key = await verifyRequest(signedAs(keyId, String(TS)), '/submit', body, keys, now);
      cost.push([key?.keyId ?? null, answers.length - before, await answers.at(-1)]);
    }
    crypto.subtle.verify = async () => false;
    const vetoed = await verifyRequest(signedAs('local', String(TS)), '/submit', body, keys, NOW);
    crypto.subtle.verify = async () => true;
    const forced = await verifyRequest(signedAs('local', String(TS), mac(KEYS.watch.secret, 'other text')), '/submit', body, keys, NOW);
    eq([vetoed, forced?.keyId], [null, 'local'], "crypto.subtle.verify's answer is the whole comparison, with no string compare beside it");
  } finally { delete crypto.subtle.verify; }
  eq([crypto.subtle.verify === real, cost], [true, [['local', 1, true], [null, 1, false], [null, 1, true]]], 'a known key, an unknown key and a stale timestamp each cost exactly one crypto.subtle.verify');
  const src = noComments(read('convex/lib/signature.ts'));
  const compares = (s) => [...s.matchAll(/([\w$.\])]+)\s*[!=]==?\s*([\w$.'"`]+)/g)].filter(([, a, b]) => [a, b].some((x) => /sig|mac|digest|expected/i.test(x)) && ![a, b].some((x) => /^(null|undefined)$/.test(x)));
  eq([/crypto\.subtle\.verify\(/.test(src), /crypto\.subtle\.sign\(|timingSafeEqual/.test(src), compares(src).map((m) => m[0])], [true, false, []], 'signature.ts calls crypto.subtle.verify, never sign, and compares no signature or MAC with == or ===');
  eq([compares('if (computed === signature) ok();').length, compares('return btoa(x) !== sig;').length, compares('if (mac === null) return;').length], [1, 1, 0], 'that scan trips on a string compare of a MAC, not on a null check');
  eq((await verifyRequest(signedAs('local', String(TS)), '/submit', body, keys, NOW))?.keyId, 'local', 'the helper signs a plain timestamp that is accepted');
  const shapes = [`${TS}.0`, `${TS}.5`, '1.789e9', `0x${TS.toString(16)}`, ` ${TS}`, `${TS} `, `${TS}\n`, `000${TS}`];
  const shaped = await Promise.all(shapes.map((ts) => verifyRequest(signedAs('local', ts), '/submit', body, keys, NOW)));
  eq(shaped, shapes.map(() => null), 'signed as sent but not 1 to 12 ASCII digits: a decimal, an exponent, hex, a space, a newline, 13 digits are refused');
});

// ── The pipeline ────────────────────────────────────────────────────────────
const STORY = Object.freeze({
  id: '2026-09-15-antenne-desk', date: '2026-09-15', kind: 'launch', site: 'dispatch-site', title: 'The desk opens SECRET-TEXT',
  summary: 'Drafts go to a private queue SECRET-TEXT.', body: ['One paragraph SECRET-TEXT.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'],
});
const story = (slug, over = {}) => ({ ...STORY, id: `2026-09-15-${slug}`, ...over });
async function pipe({ method = 'POST', path = '/submit', key = 'local', body = JSON.stringify({ stories: [STORY] }), ts = TS, headers, env = { MACHINE_KEYS }, now = NOW, reply } = {}) {
  let reads = 0;
  const calls = [];
  const answer = await machineRequest(method, path, headers ?? signed(key, path, body, ts), async () => { reads += 1; return body; }, env, now, async (fn, args) => {
    calls.push({ fn, args });
    return reply ? reply(fn, args) : { ok: true, fn };
  });
  return { ...answer, reads, calls: calls.map((c) => c.fn), args: calls.map((c) => c.args) };
}
const brief = (r) => [r.status, r.body.code ?? 'ok', r.reads, r.calls];

await section('routes.ts: each status code, the body read once, and 401 alike for every way a signature fails', async () => {
  const ok = await pipe();
  eq(brief(ok), [200, 'ok', 1, ['submit:ingest']], '/submit: 200, one read, the ingest mutation');
  eq(ok.args[0], { keyId: 'local', scopes: ['submit', 'status'], path: '/submit', body: JSON.stringify({ stories: [STORY] }) }, 'the verified key and the signed text are handed on');
  eq(brief(await pipe({ path: '/status', key: 'watch', body: '{}' })), [200, 'ok', 1, ['submit:meter', 'submit:status']], '/status: metered, then the status query');
  eq(brief(await pipe({ path: '/nope' })), [404, 'not-found', 0, []], 'an unknown path is 404, read nothing');
  eq(brief(await pipe({ method: 'GET' })), [405, 'method', 0, []], 'GET is 405');
  for (const [what, raw] of [['unset', undefined], ['empty', ''], ['only malformed entries', 'x:submit:short,Y:status:abc']]) {
    eq(brief(await pipe({ env: { MACHINE_KEYS: raw } })), [503, 'not-configured', 0, []], `MACHINE_KEYS ${what}: 503 not-configured`);
  }
  eq(brief(await pipe({ headers: signed('local', '/submit', '{}', TS, { 'Content-Length': String(BODY_MAX_BYTES + 1) }) })), [413, 'too-large', 0, []], 'a declared length over the cap is 413 before any read');
  const big = JSON.stringify({ stories: [], pad: '€'.repeat(Math.ceil(BODY_MAX_BYTES / 3)) });
  eq([big.length < BODY_MAX_BYTES, utf8Length(big) > BODY_MAX_BYTES], [true, true], 'the fixture: fewer characters than the cap, more bytes');
  eq(brief(await pipe({ body: big })), [413, 'too-large', 1, []], 'a body over the cap in UTF-8 bytes is 413 after one read');
  eq(utf8Length('aé€\u{1F600}\ud800'), 1 + 2 + 3 + 4 + 3, 'utf8Length counts 1 to 4 bytes, and a lone surrogate as U+FFFD');
  const body = JSON.stringify({ stories: [STORY] });
  const unauthorized = [
    ['an unknown key', signed('nobody', '/submit', body)],
    ['a bad signature', new Headers({ 'X-Antenne-Key': 'local', 'X-Antenne-Timestamp': String(TS), 'X-Antenne-Signature': mac(KEYS.local.secret, 'something else') })],
    ['a stale timestamp', signed('local', '/submit', body, TS - SIGNATURE_WINDOW_MS / 1000 - 1)],
    ['a future timestamp', signed('local', '/submit', body, TS + SIGNATURE_WINDOW_MS / 1000 + 1)],
    ['a signature for /status sent to /submit', signed('local', '/status', body)],
    ['no signature header', new Headers({ 'X-Antenne-Key': 'local', 'X-Antenne-Timestamp': String(TS) })],
    ['no headers at all', new Headers()],
  ];
  const answers = [];
  for (const [what, headers] of unauthorized) {
    const r = await pipe({ headers, body });
    answers.push(JSON.stringify([r.status, r.body]));
    eq(brief(r), [401, 'unauthorized', 1, []], `${what}: 401 unauthorized, and nothing runs`);
  }
  eq(new Set(answers).size, 1, 'every 401 is the same status and the same body, so none says which check failed');
  eq(brief(await pipe({ key: 'watch' })), [403, 'scope', 1, []], 'a status key on /submit is 403 scope');
  eq(brief(await pipe({ path: '/status', key: 'gh', body: '{}' })), [403, 'scope', 1, []], 'a publish key on /status is 403 scope');
  const frozen = { MACHINE_KEYS, DESK_FROZEN: ' 1 ' };
  eq(brief(await pipe({ env: frozen })), [503, 'frozen', 1, []], 'DESK_FROZEN refuses /submit with 503 before ingest runs');
  eq(brief(await pipe({ env: frozen, path: '/status', key: 'watch', body: '{}' })), [200, 'ok', 1, ['submit:meter', 'submit:status']], 'and /status still reads');
  for (const [what, text] of [['not JSON', '{"stories": ['], ['a JSON array', '[]'], ['JSON null', 'null'], ['no stories', '{}'], ['stories not an array', '{"stories":{}}']]) {
    eq(brief(await pipe({ body: text })), [400, 'malformed', 1, []], `${what}: 400 malformed`);
  }
  eq(brief(await pipe({ body: JSON.stringify({ stories: Array(SUBMIT_BATCH_MAX + 1).fill(STORY) }) })), [400, 'too-many', 1, []], `${SUBMIT_BATCH_MAX + 1} stories: 400 too-many`);
  const limited = { ok: false, code: 'rate-limited', message: 'Too many.', retryAfterMs: 5 };
  const r429 = await pipe({ reply: () => limited });
  eq([r429.status, r429.body], [429, limited], 'a rate-limited ingest is 429 with its retry time');
  eq(brief(await pipe({ path: '/status', key: 'watch', body: '{}', reply: (fn) => (fn === 'submit:meter' ? limited : { ok: true }) })), [429, 'rate-limited', 1, ['submit:meter']], 'a metered route over its rate is 429, and the query never runs');
  eq(brief(await pipe({ reply: () => ({ ok: false, code: 'frozen', message: 'x' }) })), [503, 'frozen', 1, ['submit:ingest']], 'frozen from a core is 503');
  eq(brief(await pipe({ reply: () => ({ ok: false, code: 'forbidden', message: 'x' }) })), [403, 'scope', 1, ['submit:ingest']], 'forbidden from a core is 403 scope');
  eq(brief(await pipe({ reply: () => ({ ok: false, code: 'malformed', message: 'x' }) })), [400, 'malformed', 1, ['submit:ingest']], 'any other refusal is 400 with its code');
  const [logged, lines] = [console.error, []];
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  const thrown = await pipe({ reply: () => { throw new Error('SECRET-TEXT'); } }).finally(() => { console.error = logged; });
  eq([thrown.status, thrown.body.ok, thrown.body.code, JSON.stringify(thrown.body).includes('SECRET')], [500, false, 'internal', false], 'a function that throws is 500 internal, with no detail');
  eq([lines.length, lines.join('\n').split('\n').length, /submit:ingest/.test(lines.join('')), /SECRET/.test(lines.join(''))], [1, 1, true, false], 'and logged on one line, by function name, never its message or the story text it was handed');
  const rowOf = (path) => ROUTES.filter((r) => r.path === path).map((r) => [r.method, r.path, r.scope, r.fn, r.write, r.meter]);
  eq([rowOf('/submit'), rowOf('/status')], [[['POST', '/submit', 'submit', 'submit:ingest', true, false]], [['POST', '/status', 'status', 'submit:status', false, true]]], 'the /submit and /status rows (publish-bridge adds its own beside them)');
  const row = { ...ROUTES[0] };
  const trips = (rows) => { try { assertRoutes(rows); return false; } catch { return true; } };
  eq([trips(ROUTES), trips([{ ...row, scope: 'publish' }]), trips([{ ...row, method: 'GET' }]), trips([row, row]), trips([{ ...row, path: '/other' }])], [false, true, true, true, true], 'assertRoutes refuses a wrong scope, a GET, a path twice and a path no scope signs for');
});

// ── /submit over the fake database ──────────────────────────────────────────
const T0 = Date.UTC(2026, 8, 15, 12);
const OWNER = 'user_owner';
const REVIEWER = 'user_reviewer';
const ENV = Object.freeze({ DESK_OWNERS: OWNER });
const TABLES = ['members', 'accessRequests', 'drafts', 'draftEvents', 'publishRuns', 'publishedIds', 'settings', 'rateEvents'];
const LOCAL = access.machineCaller('local', ['submit', 'status']);
const byId = (db, id) => db.rows('drafts').find((d) => d.storyId === id);
async function world() {
  const db = countWrites(createFakeDb());
  for (const [subject, role] of [['user_editor', 'editor'], [REVIEWER, 'reviewer'], ['user_submitter', 'submitter']]) {
    await db.insert('members', { subject, role, label: role, email: null, grantedBy: OWNER, grantedAt: T0 });
  }
  db.resetWrites();
  return db;
}
async function seed(db, over = {}, post = STORY) {
  const p = validatePost(post, { mode: 'desk' }).post;
  const id = await db.insert('drafts', { ...newDraft({ post: p, hash: await contentHash(p), external: false, source: 'machine', submittedBy: 'key:local', assignee: null, now: T0 - 5000 }), ...over });
  db.resetWrites();
  return id;
}
const ingest = async (db, stories, caller = LOCAL, env = ENV, now = T0) => ingestCore(db, caller, { stories }, now, env);
const outcomes = (r) => r.result.outcomes.map((o) => o.outcome);
async function nothing(db, run, want, what) {
  db.resetWrites();
  const before = JSON.stringify(TABLES.map((t) => db.rows(t)));
  const r = await run();
  const result = r.result ?? r;
  eq([result.ok, result.code, db.writes(), JSON.stringify(TABLES.map((t) => db.rows(t))) === before], [false, want, 0, true], `${what}: ${want}, nothing written`);
}

await section('/submit: created, then unchanged, then updated with rev and machineRev bumped so a stale approve fails', async () => {
  const db = await world();
  await db.insert('settings', { key: 'desk', defaultAssignee: REVIEWER, publishDelayMs: 300000, updatedBy: OWNER, updatedAt: T0 });
  const first = await ingest(db, [STORY]);
  eq(first.result, { ok: true, outcomes: [{ id: STORY.id, outcome: 'created', problems: [] }] }, 'created');
  const d = byId(db, STORY.id);
  eq([d.status, d.source, d.submittedBy, d.rev, d.machineRev, d.humanTouched, d.assignee, d.external], ['pending', 'machine', 'key:local', 1, 1, false, REVIEWER, false], 'a pending machine draft by key:local, assigned to the eligible default');
  eq(first.intents, [{ kind: 'links', draftId: d._id }], 'a links intent for the new draft');
  eq(db.rows('draftEvents').map((e) => [e.action, e.actor, Object.keys(e.detail), JSON.stringify(e.detail).includes('SECRET')]), [['submit', 'key:local', ['rev', 'machineRev', 'contentHash', 'assignee'], false]], 'one submit event by key:local, revs, hash and assignee only');
  eq(db.rows('rateEvents').map((r) => r.bucket), ['key:local|machine.submit'], 'one machine.submit rate row for the key');
  db.resetWrites();
  const again = await ingest(db, [STORY], LOCAL, ENV, T0 + 1);
  eq([outcomes(again), again.intents, db.writes()], [['unchanged'], [], 1], 'the same story again is unchanged: only its rate row is written');
  const changed = await ingest(db, [{ ...STORY, summary: 'A new summary SECRET-TEXT.' }], LOCAL, ENV, T0 + 2);
  const u = byId(db, STORY.id);
  eq([outcomes(changed), u.rev, u.machineRev, u.humanTouched, u.post.summary, u.updatedAt], [['updated'], 2, 2, false, 'A new summary SECRET-TEXT.', T0 + 2], 'updated: post replaced, rev and machineRev bumped');
  const event = db.rows('draftEvents').at(-1);
  eq([changed.intents, event.action, event.detail.fields, Object.keys(event.detail), JSON.stringify(event).includes('SECRET')], [[{ kind: 'links', draftId: u._id }], 'machine-update', ['summary'], ['rev', 'machineRev', 'fields', 'contentHash'], false], 'a links intent and a machine-update event naming the field, never its text');
  const reviewer = await access.resolveCaller(db, REVIEWER, ENV);
  eq((await approveCore(db, reviewer, { draftId: u._id, expectedRev: 1 }, T0 + 3, ENV)).result.code, 'stale', 'an approve holding rev 1 from before the update is stale');
  eq((await approveCore(db, reviewer, { draftId: u._id, expectedRev: 2 }, T0 + 3, ENV)).result.ok, true, 'the current rev approves');
  eq(outcomes(await ingest(db, [{ ...STORY, summary: 'Late.' }], LOCAL, ENV, T0 + 4)), ['already-decided'], 'an approved story is already-decided');
});

await section('/submit: kept-human-edits, already-decided, published, invalid, and the default assignee only while eligible', async () => {
  const db = await world();
  const editor = await access.resolveCaller(db, 'user_editor', ENV);
  const id = await seed(db);
  await editCore(db, editor, { draftId: id, expectedRev: 1, patch: { title: 'Edited on the desk' } }, T0, ENV);
  eq(outcomes(await ingest(db, [STORY, { ...STORY, title: 'Other' }])), ['kept-human-edits', 'kept-human-edits'], 'a draft a person edited keeps their edits, same content or not');
  await submitCore(db, editor, { post: story('from-desk') }, T0, ENV);
  eq(outcomes(await ingest(db, [story('from-desk', { title: 'Machine' })])), ['kept-human-edits'], 'so does a draft submitted from the desk');
  await seed(db, { source: 'desk', submittedBy: 'user_editor' }, story('desk-untouched'));
  eq(outcomes(await ingest(db, [story('desk-untouched', { title: 'Machine' })])), ['kept-human-edits'], 'and a desk draft even with humanTouched false: only a machine draft is ever replaced');
  for (const status of ['approved', 'publishing', 'committed', 'live', 'spiked']) {
    await seed(db, { status }, story(status));
    eq(outcomes(await ingest(db, [story(status, { summary: 'Changed.' })])), ['already-decided'], `a ${status} draft is already-decided`);
  }
  await db.insert('publishedIds', { storyId: '2026-09-15-shipped', contentHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), at: T0 });
  eq(outcomes(await ingest(db, [story('shipped')])), ['published'], 'an id in publishedIds is published');
  const bad = await ingest(db, [story('x', { title: '' }), { ...STORY, id: 'The Secret Headline' }, story('far', { date: '2026-07-01', id: '2026-07-01-far' }), story('ext', { links: [{ label: 'Out', url: 'https://example.com/' }] })]);
  eq(bad.result.outcomes, [
    { id: '2026-09-15-x', outcome: 'invalid', problems: [{ field: 'title', code: 'required' }] },
    { id: null, outcome: 'invalid', problems: [{ field: 'id', code: 'format' }, { field: 'id', code: 'id-date' }] },
    { id: '2026-07-01-far', outcome: 'invalid', problems: [{ field: 'date', code: 'window' }] },
    { id: '2026-09-15-ext', outcome: 'invalid', problems: [{ field: 'links[0].url', code: 'host' }] },
  ], 'invalid with its problems; an id that is not an id is sent back as null');
  const late = Date.UTC(2026, 8, 14, 23, 30);
  eq(outcomes(await ingest(db, [story('tomorrow', { date: '2026-09-15', id: '2026-09-15-tomorrow' }), story('after', { date: '2026-09-16', id: '2026-09-16-after' })], LOCAL, ENV, late)), ['created', 'invalid'], "the window is the server's UTC date: at 23:30 on the 14th, the 15th is tomorrow and the 16th too far");
  const db2 = await world();
  await db2.insert('settings', { key: 'desk', defaultAssignee: 'user_submitter', publishDelayMs: 0, updatedBy: OWNER, updatedAt: T0 });
  await ingest(db2, [story('a')]);
  await db2.patch('settings', db2.rows('settings')[0]._id, { defaultAssignee: 'user_gone' });
  await ingest(db2, [story('b')]);
  eq([byId(db2, '2026-09-15-a').assignee, byId(db2, '2026-09-15-b').assignee], [null, null], 'a submitter, or someone with no role, is never assigned');
});

await section('/submit: a new url set drops the owner override and the checks of urls that left; the same set keeps both', async () => {
  const db = await world();
  const [A, B] = ['https://dispatch.neorgon.com/a.html', 'https://dispatch.neorgon.com/b.html'];
  const linked = (slug, urls, over = {}) => story(slug, { links: urls.map((url, i) => ({ label: `Link ${i}`, url })), ...over });
  const checked = [{ url: A, status: 404, blocking: true }, { url: B, status: 200, blocking: false }];
  await seed(db, { linkChecks: checked, linkOverride: OWNER }, linked('moved', [A, B]));
  await seed(db, { linkChecks: checked, linkOverride: OWNER }, linked('kept', [A, B]));
  eq(outcomes(await ingest(db, [linked('moved', [B]), linked('kept', [B, A], { summary: 'Changed.' })])), ['updated', 'updated'], 'both are machine updates');
  const [moved, kept] = [byId(db, '2026-09-15-moved'), byId(db, '2026-09-15-kept')];
  eq([moved.linkOverride, moved.linkChecks], [null, [checked[1]]], "urls changed: the override is cleared, so it never covers a new link, and A's blocking check leaves with A");
  eq([kept.linkOverride, kept.linkChecks], [OWNER, checked], 'the same urls in another order, new text: override and checks kept, as a desk edit keeps them');
  const editor = await access.resolveCaller(db, 'user_editor', ENV);
  for (const [slug, urls, twin] of [['edit-moved', [B], moved], ['edit-kept', [B, A], kept]]) {
    const id = await seed(db, { linkChecks: checked, linkOverride: OWNER }, linked(slug, [A, B]));
    await editCore(db, editor, { draftId: id, expectedRev: 1, patch: { links: linked(slug, urls).links } }, T0, ENV);
    eq([byId(db, `2026-09-15-${slug}`).linkOverride, byId(db, `2026-09-15-${slug}`).linkChecks], [twin.linkOverride, twin.linkChecks], `${slug}: a desk edit of the same links gives the same (draftsCore revise), so the two copies of the rule cannot drift`);
  }
});

await section(`/submit: ${MACHINE_PENDING_MAX} pending drafts of the machine keys, summed, answer queue-full; desk drafts never count; an update still lands`, async () => {
  const db = await world();
  for (let i = 0; i < MACHINE_PENDING_MAX - 1; i += 1) await seed(db, { submittedBy: i % 2 ? 'key:ci' : 'key:local' }, story(`m${i}`));
  for (let i = 0; i < 200; i += 1) await seed(db, { source: 'desk', humanTouched: true, submittedBy: 'user_editor' }, story(`d${i}`));
  eq(outcomes(await ingest(db, [story('n1'), story('n2'), story('m0', { summary: 'Changed.' })], LOCAL, { ...ENV, MACHINE_KEYS })), ['created', 'queue-full', 'updated'], `local and ci hold ${MACHINE_PENDING_MAX - 1} between them, beside 200 pending desk drafts: the ${MACHINE_PENDING_MAX}th is created, the next is queue-full, an update lands`);
  eq(outcomes(await ingest(db, [story('n3')], LOCAL, ENV)), ['created'], 'with MACHINE_KEYS unset only the caller\'s own pending drafts count, so its 21 leave room');
});

await section('/submit refusals write nothing: frozen, a human, a key without submit, a bad batch, the 61st call in an hour', async () => {
  const db = await world();
  await nothing(db, () => ingest(db, [STORY], LOCAL, { ...ENV, DESK_FROZEN: '1' }), 'frozen', 'DESK_FROZEN=1');
  await nothing(db, async () => ingest(db, [STORY], await access.resolveCaller(db, OWNER, ENV)), 'forbidden', 'an owner calling the machine core');
  await nothing(db, () => ingest(db, [STORY], access.machineCaller('watch', ['status', 'publish'])), 'forbidden', 'a key without the submit scope');
  await nothing(db, () => ingestCore(db, LOCAL, { stories: 'x' }, T0, ENV), 'malformed', 'stories that are not an array');
  await nothing(db, () => ingest(db, Array(SUBMIT_BATCH_MAX + 1).fill(STORY)), 'too-many', `${SUBMIT_BATCH_MAX + 1} stories`);
  for (let i = 0; i < 60; i += 1) await ingest(db, [], LOCAL, ENV, T0 + i);
  await nothing(db, () => ingest(db, [STORY], LOCAL, ENV, T0 + 60), 'rate-limited', 'the 61st call from one key in an hour');
  eq(outcomes(await ingest(db, [STORY], access.machineCaller('ci', ['submit']), ENV, T0 + 61)), ['created'], 'another key is not affected');
});

await section('a machine key never passes a human action, whatever its scopes', async () => {
  const db = await world();
  const all = access.machineCaller('root', ['submit', 'status', 'publish', 'admin']);
  eq(all.scopes, ['submit', 'status', 'publish'], 'machineCaller drops a scope it does not know');
  const human = Object.keys(access.PERMISSIONS);
  eq(human.filter((a) => access.authorize(all, a, ENV) === null), [], `none of the ${human.length} human actions`);
  const id = await seed(db);
  await nothing(db, () => submitCore(db, all, { post: story('m') }, T0, ENV), 'forbidden', 'drafts:submit');
  await nothing(db, () => editCore(db, all, { draftId: id, expectedRev: 1, patch: { title: 'x' } }, T0, ENV), 'forbidden', 'drafts:edit');
  await nothing(db, () => approveCore(db, all, { draftId: id, expectedRev: 1 }, T0, ENV), 'forbidden', 'drafts:approve');
  await nothing(db, () => spikeCore(db, all, { draftId: id, expectedRev: 1 }, T0, ENV), 'forbidden', 'drafts:spike');
  eq(await queueCore(db, all, {}, T0, ENV), { ok: true, drafts: [] }, 'desk:queue shows a machine nothing');
});

// ── /status and the meter ───────────────────────────────────────────────────
const TEXT_KEYS = ['title', 'summary', 'body', 'links', 'tags', 'post', 'label', 'url'];
function textKeys(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((v, i) => textKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [...(TEXT_KEYS.includes(k) ? [`${path}.${k}`] : []), ...textKeys(v, `${path}.${k}`)]);
}
const WATCH = access.machineCaller('watch', ['status']);

await section('/status: counts, ids and ages, the last run and the token expiry; never a title, summary, body, link or tag', async () => {
  const db = await world();
  const HOUR = 3600000;
  await seed(db, { status: 'approved', approvedAt: T0 - HOUR, assignee: REVIEWER, updatedAt: T0 - HOUR }, story('ap'));
  await seed(db, { status: 'publishing', claimedAt: T0 - 2 * HOUR, updatedAt: T0 - 2 * HOUR }, story('pu'));
  await seed(db, { status: 'committed', committedAt: T0 - 3 * HOUR, commitSha: 'c'.repeat(40), updatedAt: T0 - 3 * HOUR }, story('co'));
  await seed(db, {}, story('pe'));
  await seed(db, { status: 'live', updatedAt: T0 - 8 * 24 * HOUR }, story('old-live'));
  await seed(db, { status: 'live', updatedAt: T0 - HOUR }, story('new-live'));
  eq((await statusCore(db, WATCH, {}, T0, ENV)).lastRun, null, 'no run yet: lastRun is null');
  const run = { state: 'failed', trigger: 'approve', attempts: 5, followUp: false, runAt: T0, dispatchedAt: null, claimedAt: null, ghRunId: null, runUrl: null, commitSha: null, storyIds: ['a', 'b'], error: 'dispatch 401', createdAt: T0 - HOUR, updatedAt: T0 - 60000 };
  await db.insert('publishRuns', { ...run, state: 'done', createdAt: T0 - 2 * HOUR });
  const runId = await db.insert('publishRuns', run);
  const r = await statusCore(db, WATCH, {}, T0, { ...ENV, GITHUB_DISPATCH_TOKEN_EXPIRES: ' 2027-01-31 ' });
  eq(r.counts, { pending: 1, approved: 1, publishing: 1, committed: 1, live: 1, spiked: 0 }, 'a count for every status; live older than 7 days is left out');
  eq(r.queue, [
    { storyId: '2026-09-15-ap', status: 'approved', source: 'machine', assigned: true, ageMs: 5000, approvedAgeMs: HOUR, claimedAgeMs: null, committedAgeMs: null },
    { storyId: '2026-09-15-pu', status: 'publishing', source: 'machine', assigned: false, ageMs: 5000, approvedAgeMs: null, claimedAgeMs: 2 * HOUR, committedAgeMs: null },
    { storyId: '2026-09-15-co', status: 'committed', source: 'machine', assigned: false, ageMs: 5000, approvedAgeMs: null, claimedAgeMs: null, committedAgeMs: 3 * HOUR },
    { storyId: '2026-09-15-pe', status: 'pending', source: 'machine', assigned: false, ageMs: 5000, approvedAgeMs: null, claimedAgeMs: null, committedAgeMs: null },
  ], 'approved, publishing, committed, then pending, by id, state and age');
  eq(r.lastRun, { runId, state: 'failed', trigger: 'approve', attempts: 5, followUp: false, createdAt: T0 - HOUR, updatedAt: T0 - 60000, ageMs: HOUR, runUrl: null, commitSha: null, error: 'dispatch 401', stories: 2 }, 'lastRun is the newest run, its story ids counted, not listed');
  eq(r.tokenExpires, '2027-01-31', 'tokenExpires is GITHUB_DISPATCH_TOKEN_EXPIRES');
  eq([(await statusCore(db, WATCH, {}, T0, ENV)).tokenExpires, (await statusCore(db, WATCH, {}, T0, { GITHUB_DISPATCH_TOKEN_EXPIRES: 'soon' })).tokenExpires], [null, null], 'unset or not a date: null');
  eq([textKeys(r), JSON.stringify(r).includes('SECRET')], [[], false], 'no title, summary, body, links, tags, post, label or url key anywhere, and no story text');
  eq(textKeys({ a: [{ b: { title: 1 } }], links: [] }), ['$.a[0].b.title', '$.links'], 'the scan finds such a key at any depth');
  eq((await statusCore(db, WATCH, {}, T0, { ...ENV, DESK_FROZEN: '1' })).ok, true, 'DESK_FROZEN does not refuse a read');
  eq([(await statusCore(db, LOCAL, {}, T0, ENV)).ok, (await statusCore(db, access.machineCaller('gh', ['publish']), {}, T0, ENV)).code, (await statusCore(db, await access.resolveCaller(db, OWNER, ENV), {}, T0, ENV)).code], [true, 'forbidden', 'forbidden'], 'a key with status reads; a publish key or a person is refused');
  for (let i = 0; i < 220; i += 1) await seed(db, {}, story(`bulk${i}`));
  const many = await statusCore(db, WATCH, {}, T0, ENV);
  eq([many.counts.pending, many.queue.length, many.queue.slice(0, 3).map((q) => q.status)], [200, 200, ['approved', 'publishing', 'committed']], 'counts stop at 200, the queue holds 200, the decided stories first');
});

await section('the meter: 120 status calls an hour per key, recorded before the query; a refusal writes nothing', async () => {
  const db = await world();
  const oks = [];
  for (let i = 0; i < 120; i += 1) oks.push((await meterCore(db, WATCH, { path: '/status' }, T0 + i, ENV)).ok);
  eq([oks.every(Boolean), db.count('rateEvents')], [true, 120], '120 status calls in an hour, one rate row each');
  eq(db.rows('rateEvents').every((row) => row.bucket === 'key:watch|machine.status'), true, 'every row is key:watch|machine.status');
  await nothing(db, () => meterCore(db, WATCH, { path: '/status' }, T0 + 120, ENV), 'rate-limited', 'the 121st');
  await nothing(db, () => meterCore(db, WATCH, { path: '/submit' }, T0, ENV), 'forbidden', 'a key metering a route outside its scope');
  await nothing(db, () => meterCore(db, WATCH, { path: '/nope' }, T0, ENV), 'not-found', 'a path no scope signs for');
  eq((await meterCore(db, WATCH, { path: '/status' }, T0 + 3600000 + 1, ENV)).ok, true, 'an hour after the first, there is room again');
  const iced = await world();
  eq([(await meterCore(iced, WATCH, { path: '/status' }, T0, { ...ENV, DESK_FROZEN: '1' })).ok, iced.count('rateEvents')], [true, 1], 'DESK_FROZEN does not stop the meter, so /status keeps reading through a freeze');
});

// ── The wrappers: text, then wired end to end ───────────────────────────────
await section('http.ts, submit.ts and their libraries never read Authorization or call getUserIdentity; submit.ts drops the links intent on one line', () => {
  const files = ['convex/http.ts', 'convex/submit.ts', 'convex/lib/routes.ts', 'convex/lib/signature.ts', 'convex/lib/submitCore.ts'];
  const hits = (source) => [/getUserIdentity/.test(noComments(source)), /authorization/i.test(noComments(source))];
  for (const file of files) eq(hits(read(file)), [false, false], `${file}: neither, outside comments`);
  eq([hits('request.headers.get("Authorization")'), hits('await ctx.auth.getUserIdentity()'), hits('// getUserIdentity and Authorization')], [[false, true], [true, false], [false, false]], 'a read in a string or a call trips; a comment does not');
  // Until publish-bridge schedules the links intents, the one line that calls
  // ingestCore keeps only the result and says so; publish-bridge may rewrite it.
  const dropsIntents = (source) => {
    const lines = source.split('\n').filter((l) => /ingestCore\(/.test(noComments(l)));
    return lines.length === 1 && (!/const \{ result \} = await ingestCore\(/.test(lines[0]) || /\/\/.*publish-bridge/.test(lines[0]));
  };
  eq(dropsIntents(read('convex/submit.ts')), true, 'one line calls ingestCore, and if it drops the links intents it names publish-bridge');
  eq([dropsIntents('const { result } = await ingestCore(a);'), dropsIntents('const { result, intents } = await ingestCore(a);'), dropsIntents('ingestCore(a);\ningestCore(b);')], [false, true, false], 'a silent drop or a second call trips');
});

const STAND_INS = {
  'convex/server': 'export function httpRouter() { const routes = []; return { routes, route(spec) { routes.push(spec); } }; }',
  'convex/values': 'export const v = new Proxy({}, { get: (_, kind) => (...args) => ({ kind, args }) });',
  './_generated/server': 'const reg = (kind) => (def) => ({ ...def, kind }); export const httpAction = (fn) => ({ kind: "http", run: fn }); export const internalMutation = reg("mutation"); export const internalQuery = reg("query"); export const internalAction = reg("action"); export const mutation = reg("mutation"); export const query = reg("query"); export const action = reg("action");',
  './_generated/api': 'const ref = (p) => new Proxy({ name: p.join(":") }, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : k in t ? t[k] : ref([...p, k])) }); export const internal = ref([]);',
};
await section('convex/http.ts and convex/submit.ts wired end to end: a signed request lands, Authorization is never read', async () => {
  eq(typeof registerHooks, 'function', 'node:module registerHooks exists (Node 23.5 and later)');
  registerHooks({
    resolve(specifier, context, next) {
      const stand = STAND_INS[specifier];
      if (stand && (!specifier.startsWith('.') || /\/convex\/[^/]+\.ts$/.test(context.parentURL ?? ''))) return { url: `data:text/javascript,${encodeURIComponent(stand)}`, shortCircuit: true };
      return next(specifier, context);
    },
  });
  const router = (await import('../convex/http.ts')).default;
  const fns = await import('../convex/submit.ts');
  eq(router.routes.map((r) => [r.method, r.path, r.handler.kind]), ROUTES.map((r) => ['POST', r.path, 'http']), 'one POST route per row of ROUTES');
  eq([fns.ingest.kind, fns.status.kind, fns.meter.kind], ['mutation', 'query', 'mutation'], 'ingest and meter are internal mutations, status an internal query');
  const db = await world();
  const used = [];
  const auth = { getUserIdentity: async () => { used.push('getUserIdentity'); throw new Error('an HTTP action must not ask'); } };
  // Recorded only: publish-bridge's wrappers schedule links:check here.
  const scheduled = [];
  const scheduler = { runAfter: async (...a) => { scheduled.push(a); }, runAt: async (...a) => { scheduled.push(a); } };
  const runner = (kind) => async (ref, args) => {
    const fn = fns[ref.name.split(':')[1]];
    used.push(`${kind} ${ref.name}`);
    if (!ref.name.startsWith('submit:') || fn?.kind !== kind) throw new Error(`${ref.name} is not an internal ${kind}`);
    return fn.handler({ db, auth, scheduler }, args);
  };
  const ctx = { auth, runMutation: runner('mutation'), runQuery: runner('query') };
  const saved = { ...process.env };
  Object.assign(process.env, { MACHINE_KEYS, DESK_OWNERS: OWNER, DESK_FROZEN: '', GITHUB_DISPATCH_TOKEN_EXPIRES: '2027-01-31' });
  const today = new Date().toISOString().slice(0, 10);
  const send = (path, key, body, headers = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    const h = signed(key, path, body, ts, { Authorization: 'Bearer not-a-convex-token', ...headers });
    return router.routes.find((r) => r.path === path).handler.run(ctx, new Request(`https://happy-otter-123.convex.site${path}`, { method: 'POST', headers: h, body }));
  };
  try {
    const live = { ...STORY, id: `${today}-wired`, date: today };
    const res = await send('/submit', 'local', JSON.stringify({ stories: [live] }));
    eq([res.status, res.headers.get('content-type'), res.headers.get('cache-control'), await res.json()], [200, 'application/json; charset=utf-8', 'no-store', { ok: true, outcomes: [{ id: live.id, outcome: 'created', problems: [] }] }], 'a signed /submit is created through the real wrappers, answered no-store');
    eq([byId(db, live.id)?.submittedBy, byId(db, live.id)?.source], ['key:local', 'machine'], 'the draft is the verified key\'s');
    const st = await send('/status', 'watch', '{}');
    const body = await st.json();
    eq([st.status, body.counts.pending, body.tokenExpires, textKeys(body)], [200, 1, '2027-01-31', []], '/status answers through the query, with the env the wrapper read');
    eq(used, ['mutation submit:ingest', 'mutation submit:meter', 'query submit:status'], 'runMutation for ingest and meter, runQuery for status; getUserIdentity never');
    const narrow = { keyId: 'watch', scopes: ['status'], path: '/submit', body: JSON.stringify({ stories: [live] }) };
    const direct = { db, auth, scheduler };
    eq([(await fns.ingest.handler(direct, narrow)).code, (await fns.status.handler(direct, { ...narrow, scopes: ['submit'] })).code, (await fns.ingest.handler(direct, { ...narrow, scopes: ['submit'], body: '[]' })).code],
      ['forbidden', 'forbidden', 'malformed'], 'the wrappers act as exactly the scopes handed to them, and parse the body text themselves');
    await db.insert('settings', { key: 'desk', defaultAssignee: OWNER, publishDelayMs: 0, updatedBy: OWNER, updatedAt: 0 });
    const [owned, denied] = [{ ...live, id: `${today}-owned` }, { ...live, id: `${today}-denied` }];
    await send('/submit', 'local', JSON.stringify({ stories: [owned] }));
    await db.patch('settings', db.rows('settings')[0]._id, { defaultAssignee: REVIEWER });
    process.env.DESK_DENY = REVIEWER;
    await send('/submit', 'local', JSON.stringify({ stories: [denied] }));
    eq([byId(db, owned.id)?.assignee, byId(db, denied.id)?.assignee], [OWNER, null], 'the wrapper hands the core DESK_OWNERS and DESK_DENY: an owner default is assigned, a denied reviewer is not');
    process.env.DESK_FROZEN = '1';
    const ran = used.length;
    const frozen = await send('/submit', 'local', JSON.stringify({ stories: [live] }));
    eq([frozen.status, (await frozen.json()).code, used.length - ran], [503, 'frozen', 0], 'DESK_FROZEN from process.env: 503, and no function runs');
    const iced = await send('/status', 'watch', '{}');
    eq([iced.status, (await iced.json()).ok, used.slice(ran)], [200, true, ['mutation submit:meter', 'query submit:status']], 'while frozen, /status still answers 200 through the meter and the query');
    eq((await fns.ingest.handler(direct, { ...narrow, keyId: 'local', scopes: ['submit'] })).code, 'frozen', 'and submit:ingest, called directly, reads DESK_FROZEN itself');
    delete process.env.MACHINE_KEYS;
    eq((await send('/status', 'watch', '{}')).status, 503, 'MACHINE_KEYS unset: 503');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
