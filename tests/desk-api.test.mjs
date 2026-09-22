// Plain node, no install. Run with: make validate
//
// js/desk-api.js, the desk's whole Convex surface (docs/plans/2026-09-15-antenne-desk.md
// sections 4.2, 4.3 and 7): the function names against what convex/*.ts
// exports, the page's deployment URL (empty means "not set up", malformed
// throws), the pinned client loader, authedCall (vitrina's, copied), the
// permission mirror against convex/lib/access.ts, the sentence for every
// refusal, and the fleet rules on the desk's own files.

import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as A from '../js/desk-api.js';
import { PERMISSIONS as MIRROR } from '../js/desk-ui.js';
import { PERMISSIONS } from '../convex/lib/access.ts';

let [failed, checks] = [0, 0];
function eq(actual, expected, what) {
  checks += 1;
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === e) { console.log(`ok   ${what}`); return; }
  failed += 1;
  console.error(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
}
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const settled = (p) => p.then((v) => v, (err) => `threw: ${err.message}`);
const rejection = (p) => p.then(() => 'resolved', (err) => err.message);

// ── FN against what convex/ exports, and against section 4.3 ────────────────
const CONVEX = new URL('../convex/', import.meta.url);
const exported = { query: [], mutation: [], other: [] };
for (const name of readdirSync(CONVEX).filter((file) => file.endsWith('.ts')).sort()) {
  const module = name.slice(0, -3);
  for (const m of readFileSync(new URL(name, CONVEX), 'utf8').matchAll(/^export const (\w+) = (\w+)\(/gm)) {
    (m[2] === 'query' || m[2] === 'mutation' ? exported[m[2]] : exported.other).push(`${module}:${m[1]}`);
  }
}
const named = Object.values(A.FN).flatMap((group) => Object.values(group));
const SECTION_4_3 = [
  'desk:me', 'desk:queue', 'drafts:submit', 'drafts:edit', 'drafts:approve', 'drafts:approveMany', 'drafts:withdraw',
  'drafts:reopen', 'drafts:take', 'drafts:overrideLinks', 'drafts:spike', 'drafts:assign', 'drafts:recheckLinks',
  'members:list', 'members:assignable', 'members:grant', 'members:revoke', 'members:requestAccess', 'members:dismissRequest',
  'settings:get', 'settings:update', 'publish:status', 'publish:now', 'publish:retry',
];
eq(exported.query.length + exported.mutation.length >= 24 && exported.other.length >= 10, true, 'the scan of convex/*.ts found the public functions and the internal ones');
eq(named.slice().sort(), [...exported.query, ...exported.mutation].sort(), 'FN names every public function, exactly as convex/*.ts exports it');
eq(named.slice().sort(), SECTION_4_3.slice().sort(), 'and that is section 4.3, publish:* included');
eq(named.filter((fn) => exported.other.includes(fn)), [], 'no internal function (publish:claim, links:check, submit:ingest) is named');
eq(A.QUERIES.slice().sort(), exported.query.slice().sort(), 'QUERIES is exactly the exported queries');
eq(named.map((n) => A.kindOf(n) === (exported.query.includes(n) ? 'query' : 'mutation')).every(Boolean), true, 'kindOf routes every name the way convex/ registers it');
eq(Object.isFrozen(A.FN) && Object.values(A.FN).every(Object.isFrozen) && Object.isFrozen(A.QUERIES), true, 'the names cannot be reassigned at runtime');

// ── convexUrlFrom ───────────────────────────────────────────────────────────
const doc = (metas) => ({
  querySelector: (selector) => {
    const name = (/meta\[name="([^"]+)"\]/.exec(selector) || [])[1];
    return Object.prototype.hasOwnProperty.call(metas, name)
      ? { getAttribute: (attr) => (attr === 'content' ? metas[name] : null) } : null;
  },
});
const PROD = 'https://happy-otter-123.convex.cloud';
eq(A.convexUrlFrom(doc({})), null, 'no meta: no backend');
eq(A.convexUrlFrom(doc({ 'neo-convex-url': '' })), null, 'an EMPTY meta is "not set up", which is how desk.html ships');
eq(A.convexUrlFrom(doc({ 'neo-convex-url': null })), null, 'and so is a meta with no content attribute');
eq(A.convexUrlFrom(doc({ 'neo-convex-url': PROD })), PROD, 'a cloud deployment URL is read as written');
for (const bad of [' ', 'http://happy-otter-123.convex.cloud', `${PROD}/`, 'https://happy-otter-123.convex.site', ` ${PROD}`,
  'https://Happy-otter-123.convex.cloud', 'https://evil.example.com/?x=happy-otter-123.convex.cloud']) {
  eq(throws(() => A.convexUrlFrom(doc({ 'neo-convex-url': bad }))), true, `a non-empty malformed meta throws: ${JSON.stringify(bad)}`);
}
eq(A.convexUrlFrom(null), null, 'no document at all is no backend, not an error');
const deskMeta = /<meta name="neo-convex-url" content="([^"]*)">/.exec(read('desk.html'));
eq(deskMeta && deskMeta[1], '', 'desk.html ships the meta empty, so the committed desk reads as "not set up"');

// ── loadClient: the pinned build, cached, and a failed load retried ─────────
let mode = 'ok';
const resolved = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== A.CLIENT_URL) return next(specifier, context);
    resolved.push(specifier);
    if (mode === 'fail') throw new Error('offline');
    const source = 'globalThis.__made = globalThis.__made || []; export class ConvexHttpClient { constructor(url) { this.url = url; globalThis.__made.push(url); } }';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
eq(await rejection(A.loadClient('https://example.com')), 'loadClient needs a Convex cloud deployment URL', 'a URL that is not a Convex deployment is refused');
eq(resolved, [], 'before anything is imported, since the URL decides where a token goes');
mode = 'fail';
eq(await rejection(A.loadClient(PROD)), 'offline', 'a failed load rejects');
mode = 'ok';
const first = await A.loadClient(PROD);
const second = await A.loadClient(PROD);
eq([first.url, first === second, globalThis.__made], [PROD, true, [PROD]], 'and is not cached: the next call loads, once, and later calls share that client');
eq(resolved.every((s) => s === 'https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm'), true, 'the client comes from jsDelivr convex@1.45.0, the pinned version');

// ── authedCall, as vitrina tests it ─────────────────────────────────────────
function fakeKit({ cached = 'cached-token', fresh = 'fresh-token', session = true } = {}) {
  const log = [];
  return {
    log,
    convexToken: async () => { log.push(['convexToken']); if (cached instanceof Error) throw cached; return cached; },
    state: { clerk: session ? { session: { getToken: async (options) => { log.push(['getToken', options]); return fresh; } } } : null },
  };
}
function fakeClient(answers) {
  const log = [];
  let i = 0;
  const next = async (kind, name) => { log.push([kind, name]); const a = answers[i++]; if (a instanceof Error) throw a; return a; };
  return { log, setAuth: (t) => log.push(['setAuth', t]), clearAuth: () => log.push(['clearAuth']), query: (n) => next('query', n), mutation: (n) => next('mutation', n) };
}
let kit = fakeKit();
let client = fakeClient([{ ok: true }]);
eq(await settled(A.authedCall(async () => client, kit)('query', 'desk:me', {})), { ok: true }, 'a request resolves its answer');
eq([client.log, kit.log], [[['setAuth', 'cached-token'], ['query', 'desk:me']], [['convexToken']]], 'with the kit token set before it, queries included');
kit = fakeKit();
client = fakeClient([new Error('401'), { ok: true, rev: 2 }]);
eq(await settled(A.authedCall(async () => client, kit)('mutation', 'drafts:approve', {})), { ok: true, rev: 2, retried: true }, 'a request that throws is retried once, and a retried write says so');
eq(kit.log.filter((e) => e[0] === 'getToken'), [['getToken', { template: 'convex', skipCache: true }]], 'minted once, from the convex template, past the cache');
kit = fakeKit();
client = fakeClient([new Error('first'), new Error('second')]);
eq(await rejection(A.authedCall(async () => client, kit)('query', 'desk:me', {})), 'second', 'a second failure throws to the caller');
kit = fakeKit({ cached: null });
client = fakeClient([{ ok: true }]);
await settled(A.authedCall(async () => client, kit)('query', 'desk:me', {}));
eq(client.log, [['clearAuth'], ['query', 'desk:me']], 'with no token the client drops any it held rather than sending a stale one');
kit = fakeKit({ session: false });
client = fakeClient([new Error('offline')]);
eq([await rejection(A.authedCall(async () => client, kit)('query', 'desk:me', {})), client.log.length], ['offline', 2], 'with no session to mint from, the first failure throws, unretried');
const switching = { state: { userId: 'u1', clerk: { session: { id: 's2', user: { id: 'u2' }, getToken: async () => 'tok' } } }, convexToken: async () => 'tok' };
client = fakeClient([{ ok: true }]);
eq([await settled(A.authedCall(async () => client, switching)('mutation', 'drafts:approve', {})), client.log], ['threw: the signed-in account changed before this request went out', []],
  "a request made while the kit's session is somebody other than its userId never goes out");
eq([A.holderOf(switching), A.holderOf({ state: { userId: 'u1', clerk: { session: { id: 's1', user: { id: 'u1' } } } } })], [null, 'u1|s1'], 'holderOf names the user and the session, or null between two people');

// One client per deployment is shared by every call. This one dispatches as ConvexHttpClient 1.45.0 does
// (dist/esm/browser/http_client.js): a query, or a mutation with skipQueue, reads the token when it is
// called; a mutation on the client's own queue (the default) reads it only when its turn comes.
function queueingClient() {
  const gates = [];
  const c = {
    auth: null, queue: [], busy: false, sent: [],
    setAuth(t) { c.auth = t; },
    clearAuth() { c.auth = null; },
    dispatch(name) { c.sent.push([name, c.auth]); return new Promise((r) => gates.push(() => r({ ok: true }))); },
    query: (name) => c.dispatch(name),
    mutation(name, args, options) {
      if (options && options.skipQueue === true) return c.dispatch(name);
      return new Promise((resolve) => { c.queue.push({ name, resolve }); c.drain(); });
    },
    async drain() {
      if (c.busy) return;
      c.busy = true;
      while (c.queue.length) { const m = c.queue.shift(); m.resolve(await c.dispatch(m.name)); }
      c.busy = false;
    },
    open: () => { while (gates.length) gates.shift()(); },
  };
  return c;
}
const turn = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
{
  const who = { id: 'user_A' };
  const person = { get state() { return { userId: who.id, clerk: { session: { id: `s_${who.id}`, user: { id: who.id }, getToken: async () => `tok_${who.id}` } } }; }, convexToken: async () => `tok_${who.id}` };
  const shared = queueingClient();
  const call = A.authedCall(async () => shared, person);
  const take = call('mutation', 'drafts:take', {});
  await turn();
  const approve = call('mutation', 'drafts:approve', {});
  await turn();
  who.id = 'user_B';
  const me = call('query', 'desk:me', {});
  await turn();
  for (let i = 0; i < 4; i += 1) { shared.open(); await turn(); }
  await Promise.all([take, approve, me]);
  eq(shared.sent, [['drafts:take', 'tok_user_A'], ['drafts:approve', 'tok_user_A'], ['desk:me', 'tok_user_B']],
    "a write A sent while an earlier one was still out goes with A's token, not the next person's (skipQueue)");
}

// ── The permission mirror ───────────────────────────────────────────────────
eq(Object.keys(MIRROR).sort(), Object.keys(PERMISSIONS).sort(), 'js/desk-ui.js mirrors every action of convex/lib/access.ts');
eq(Object.keys(PERMISSIONS).filter((k) => JSON.stringify([...MIRROR[k]].sort()) !== JSON.stringify([...PERMISSIONS[k]].sort())), [], 'with the same roles for each');

// ── Every refusal as a plain sentence ───────────────────────────────────────
const CODES_4_2 = ['not-signed-in', 'not-member', 'forbidden', 'frozen', 'not-found', 'stale', 'status', 'own-submission',
  'external-links', 'links-blocked', 'invalid', 'duplicate-id', 'rate-limited', 'queue-full', 'bad-role', 'bad-subject', 'too-many'];
eq(Object.keys(A.FAILURE_TEXT).sort(), [...CODES_4_2, 'unreachable'].sort(), 'FAILURE_TEXT covers the section 4.2 codes, plus a request that never got an answer');
eq(CODES_4_2.filter((c) => !/^[A-Z][^<>]*\.$/.test(A.explain({ ok: false, code: c }))), [], 'each is a sentence: a capital, no markup, a full stop');
eq(new Set(CODES_4_2.map((c) => A.explain({ ok: false, code: c }))).size, CODES_4_2.length, 'and no two codes read the same');
eq(A.explain({ ok: false, code: 'stale', message: 'SERVER TEXT' }).includes('SERVER TEXT'), false, "the server's message is never shown");
eq(A.explain({ ok: false, code: 'rate-limited', retryAfterMs: 125000 }), 'Too many changes in a short time. Try again in 3 minutes.', 'rate-limited says how long to wait');
eq([60000, 3600001, 1380 * 60000, 3 * 86400000 - 5].map(A.waitText), ['a minute', '2 hours', '23 hours', '3 days'], 'a wait past an hour is in hours, past a day in days, rounded up as convex/lib/rate.ts does');
eq([A.FAILURE_TEXT['rate-limited'], A.explain({ ok: false, code: 'rate-limited', retryAfterMs: 1380 * 60000 })].some((t) => /hour|minute/.test(t.split('.')[0])), false, 'and neither sentence names a window the limit may not have');
eq(A.explain({ ok: false, code: 'rate-limited', retryAfterMs: 1380 * 60000 }, { 'rate-limited': 'At most 3 access requests a day.' }), 'At most 3 access requests a day. Try again in 23 hours.', 'an action words its own limit, and the wait follows it');
eq(A.explain({ ok: false, code: 'invalid', problems: [{ field: 'title', code: 'too-long' }, { field: 'links[1].url', code: 'scheme' }] }),
  'The story does not pass the desk rules yet. Title is too long; Link 2 URL must start with https://.', 'invalid lists its problems in words');
eq(A.explain({ ok: false, code: 'status' }, { status: 'Only a failed run can be retried.' }), 'Only a failed run can be retried.', 'an action can word a code for itself');
eq(A.explain({ ok: false, code: 'stale', retried: true }).startsWith('Your change may already have gone through'), true, 'a retried write that comes back stale may be its own first attempt');
eq([A.explain(null), A.explain({ ok: false, code: 'brand-new' })], [A.FAILURE_TEXT.unreachable, 'The desk refused that (brand-new).'], 'no answer, or a code the desk does not know yet');

// ── The fleet rules on the desk's files ─────────────────────────────────────
const DESK_JS = readdirSync(new URL('../js/', import.meta.url)).filter((f) => /^desk(-\w+)?\.js$/.test(f)).map((f) => `js/${f}`);
const EM_DASH = String.fromCharCode(0x2014);
const lines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
eq(DESK_JS.sort(), ['js/desk-api.js', 'js/desk-lanes.js', 'js/desk-people.js', 'js/desk-publish.js', 'js/desk-ui.js', 'js/desk.js'], 'the desk is these six modules');
eq(DESK_JS.filter((f) => lines(read(f)) > 500), [], 'none over 500 lines');
eq(lines(read('js/desk.js')) < 100, true, 'and the entry under 100');
const mine = [...DESK_JS, 'desk.html', 'css/style.css', 'tests/desk-api.test.mjs', 'tests/desk-flow.test.mjs', 'tests/desk-flow-more.test.mjs',
  'tests/desk-escape.test.mjs', 'tests/desk-publish.test.mjs', 'tests/support/fakedom.mjs', 'tests/support/deskflow.mjs'];
eq(mine.filter((f) => read(f).includes(EM_DASH)), [], 'no em dash in any of them');
const inlineHandler = (text) => /\son[a-z]+=(\\?["']|[^\s"'=<>`]+[\s>])/.test(text);
eq(DESK_JS.filter((f) => inlineHandler(code(read(f)))), [], 'no inline event handler attribute in the markup the desk builds');
eq([inlineHandler(`'<b onclick="go()">'`), inlineHandler('<b onmouseover=go>'), inlineHandler('const once = 1; const onClick = () => {};')], [true, true, false], 'the check finds one, quoted or bare, and not an identifier');
eq(/<[a-z][^>]*\son[a-z]+\s*=/i.test(read('desk.html')), false, 'nor in desk.html');
eq(DESK_JS.filter((f) => /\bbindConvex\s*\(/.test(code(read(f)))), [], "the desk never calls the kit's bindConvex: every call goes through authedCall");
const api = read('js/desk-api.js');
eq(/^\s*import\s[^(]/m.test(api), false, 'desk-api.js has no static import, so loading it fetches nothing');
eq(api.includes(`import('${A.CLIENT_URL}')`), true, 'and imports the pinned client by that one literal');
eq(/(^|[\s,{])\.auth-[\w-]+/m.test(read('css/style.css')), false, 'css/style.css holds no .auth-* rule: the Auth Kit styles its own');
const body = read('desk.html').slice(read('desk.html').indexOf('<body>'));
eq([/data\/drafts/.test(body), (body.match(/data-neo-auth/g) || []).length], [false, 1], 'the page no longer mentions data/drafts, and keeps one kit slot');

console.log(failed ? `\ndesk api: ${failed} of ${checks} checks failed` : `\ndesk api: all ${checks} checks pass`);
process.exit(failed ? 1 : 0);
