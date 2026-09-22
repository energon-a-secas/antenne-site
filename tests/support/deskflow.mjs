// The desk, end to end in node, for tests/desk-flow.test.mjs,
// tests/desk-flow-more.test.mjs and tests/desk-escape.test.mjs: the real
// desk.html in ./fakedom.mjs, the real js/desk*.js, and behind the Convex client
// the real convex/*.ts wrappers over ./fakedb.mjs
// (docs/plans/2026-09-15-antenne-desk.md section 7). The client
// and the Auth Kit are swapped in where desk.js imports them, so its own wiring
// runs. Every call the desk makes is checked against the function's declared
// args the way Convex checks them (an extra, missing or mistyped field throws),
// and identity is only what the token carries.
//
// Importing this module boots the desk once on desk.html as committed (the
// neo-convex-url meta empty), which desk-flow's "not set up" case reads back
// through `loaded`, `fetched` and `intervals`.

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fire, fireGlobal, installDom, loadPage, writes } from './fakedom.mjs';
import { createFakeDb } from './fakedb.mjs';
import { newDraft } from '../../convex/lib/draftsCore.ts';
import { contentHash, validatePost } from '../../convex/lib/post.ts';

export { contentHash };
export const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// ── Modules: what desk.js loads, recorded, and the stand-ins ────────────────
const CLIENT_URL = 'https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm';
const data = (source) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
const STAND_INS = {
  'convex/server': 'export function httpRouter() { return { route() {} }; } export function cronJobs() { return { interval() {}, daily() {}, cron() {} }; }',
  'convex/values': 'export const v = new Proxy({}, { get: (_, kind) => (...args) => ({ kind, args }) });',
  './_generated/server': 'const reg = (kind) => (def) => ({ ...def, kind }); export const httpAction = (fn) => ({ kind: "http", run: fn }); export const internalMutation = reg("internalMutation"); export const internalQuery = reg("internalQuery"); export const internalAction = reg("internalAction"); export const mutation = reg("mutation"); export const query = reg("query"); export const action = reg("action");',
  './_generated/api': 'const ref = (p) => new Proxy({ name: p.join(":") }, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : k in t ? t[k] : ref([...p, k])) }); export const internal = ref([]);',
};
// The client takes mutation's third argument (skipQueue) and ignores it: tests/desk-api.test.mjs models the queue.
const CLIENT = 'export class ConvexHttpClient { constructor(url) { this.url = url; this.token = null; globalThis.__clients = (globalThis.__clients || 0) + 1; }'
  + ' setAuth(t) { this.token = t; } clearAuth() { this.token = null; }'
  + ' query(n, a) { return globalThis.__server.run("query", n, a, this.token); } mutation(n, a) { return globalThis.__server.run("mutation", n, a, this.token); } }';
const KIT = 'export const NeoAuth = new Proxy({}, { get: (_, k) => globalThis.__kit[k] });';
export const loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    if (/\/js\//.test(context.parentURL || '')) loaded.push(specifier);
    if (specifier === CLIENT_URL) return data(CLIENT);
    if (specifier === './neorgon-auth.js' && /\/js\/desk\.js$/.test(context.parentURL || '')) return data(KIT);
    const stand = STAND_INS[specifier];
    if (stand && (!specifier.startsWith('.') || /\/convex\/[^/]+\.ts$/.test(context.parentURL ?? ''))) return data(stand);
    return next(specifier, context);
  },
});
const mods = {};
for (const m of ['desk', 'drafts', 'members', 'settings', 'publish']) mods[m] = await import(`../../convex/${m}.ts`);

// ── A Convex deployment: the real wrappers, args checked as Convex checks them ──
function valid(validator, value) {
  const [k, a] = [validator.kind, validator.args];
  if (value === undefined) return k === 'optional';
  if (k === 'string' || k === 'id') return typeof value === 'string';
  if (k === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (k === 'boolean') return typeof value === 'boolean';
  if (k === 'null') return value === null;
  if (k === 'any') return true;
  if (k === 'optional') return valid(a[0], value);
  if (k === 'union') return a.some((x) => valid(x, value));
  if (k === 'array') return Array.isArray(value) && value.every((x) => valid(a[0], x));
  if (k === 'object') return fields(a[0], value);
  throw new Error(`unknown validator ${k}`);
}
function fields(spec, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => key in spec) && Object.entries(spec).every(([key, x]) => valid(x, value[key]));
}
export const OWNER = 'user_owner';
export const [EDITOR, REVIEWER, SUBMITTER, STRANGER] = ['user_editor', 'user_reviewer', 'user_submitter', 'user_stranger'];
process.env.DESK_OWNERS = OWNER;
/** fail: function names whose every call throws, as a lost connection does, until removed. */
export const server = { db: null, calls: [], errors: [], holds: new Map(), fail: new Set(), run: null };
server.run = async (kind, name, args, token) => {
  server.calls.push({ kind, name, args: JSON.parse(JSON.stringify(args)), token });
  const [m, f] = name.split(':');
  const def = mods[m] && mods[m][f];
  if (!def || def.kind !== kind) { server.errors.push(`${kind} ${name}`); throw new Error(`Could not find public function ${name}`); }
  if (!fields(def.args, args)) { server.errors.push(`${name} ${JSON.stringify(args)}`); throw new Error(`ArgumentValidationError in ${name}`); }
  if (server.fail.has(name)) throw new Error(`${name}: the connection dropped`);
  const subject = typeof token === 'string' && token.startsWith('tok:') ? token.slice(4) : null;
  const ctx = {
    db: server.db,
    auth: { getUserIdentity: async () => (subject ? { subject, name: `Name of ${subject}`, email: null } : null) },
    scheduler: { runAfter: async () => {}, runAt: async () => {} },
  };
  const answer = JSON.parse(JSON.stringify(await def.handler(ctx, args)));
  const gate = server.holds.get(name);
  if (gate) { server.holds.delete(name); await gate.promise; }
  return answer;
};
globalThis.__server = server;
export const names = (from = 0) => server.calls.slice(from).map((c) => c.name);
/** The args of the last call to name, or null. */
export const sent = (name) => { const c = server.calls.filter((x) => x.name === name).pop(); return c ? c.args : null; };
/** The next answer from name is computed at once and delivered only when the returned function is called. */
export function hold(name) { let open; server.holds.set(name, { promise: new Promise((r) => { open = r; }) }); return () => open(); }

// ── The desk's data ─────────────────────────────────────────────────────────
export const XSS = '<img src=x onerror=alert(1)>';
export const BREAK = `">${XSS}`; // closes a quoted attribute first
export const [ASKER, SPAM] = ['user_asker', 'user_spam'];
export const MIN = 60000;
export const post = (id, title, over = {}) => ({
  id: `2026-09-15-${id}`, date: '2026-09-15', kind: 'feature', site: null, title, summary: `About ${id}.`,
  body: ['One paragraph.'], links: [{ label: 'Desk', url: 'https://dispatch.neorgon.com/desk.html' }], tags: ['desk'], ...over,
});
export async function world({ more = 0 } = {}) {
  const db = Object.assign(createFakeDb(), { normalizeId: (t, id) => (typeof id === 'string' && id.startsWith(`${t}:`) ? id : null) });
  const now = Date.now();
  server.calls = [];
  server.fail.clear();
  await db.insert('accessRequests', { subject: ASKER, label: `Asker ${BREAK}`, email: `ask${BREAK}@example.org`, note: `Please ${BREAK}`, requestedAt: now - 5 * MIN });
  await db.insert('accessRequests', { subject: SPAM, label: 'Spam', email: null, note: null, requestedAt: now - 4 * MIN });
  for (const [subject, role] of [[EDITOR, 'editor'], [REVIEWER, 'reviewer'], [SUBMITTER, 'submitter']]) {
    await db.insert('members', { subject, role, label: `${role} ${XSS}`, email: null, grantedBy: OWNER, grantedAt: now });
  }
  const ids = {};
  const add = async (key, raw, by, assignee, extra = {}) => {
    const v = validatePost(raw, { mode: 'desk' });
    if (!v.ok) throw new Error(`fixture ${key}: ${JSON.stringify(v.problems)}`);
    ids[key] = await db.insert('drafts', { ...newDraft({ post: v.post, hash: await contentHash(v.post), external: v.external, source: by.startsWith('key:') ? 'machine' : 'desk', submittedBy: by, assignee, now: now - 30 * MIN }), ...extra });
  };
  await add('plain', post('plain', 'Plain story'), SUBMITTER, null);
  await add('held', post('held', 'Held by the reviewer'), SUBMITTER, REVIEWER);
  await add('own', post('own', 'The editor wrote this'), EDITOR, null);
  await add('xss', post('xss', XSS, { summary: `Summary ${XSS}` }), 'key:local', null);
  await add('outside', post('outside', 'Links elsewhere', { links: [{ label: 'Other', url: 'https://example.org/x' }] }), SUBMITTER, null);
  await add('broken', post('broken', 'Broken link'), SUBMITTER, null, { linkChecks: [{ url: 'https://gone.neorgon.com/a', status: 404, blocking: true }] });
  await add('waiting', post('waiting', 'Approved and waiting'), SUBMITTER, REVIEWER, { status: 'approved', approvedBy: REVIEWER, approvedAt: now, publishAfter: now + 5 * MIN, rev: 2 });
  await add('spiked', post('spiked', 'Spiked one'), SUBMITTER, null, { status: 'spiked', note: `no ${XSS}`, rev: 2 });
  await add('oddId', post('odd', 'Odd id'), SUBMITTER, null, { status: 'spiked', rev: 2, storyId: `2026-09-15-odd${BREAK}` }); // past the id rule
  await add('live', post('live', 'Already live'), SUBMITTER, null, { status: 'live', commitSha: 'a'.repeat(40), rev: 4 });
  await add('byEditor', post('by-editor', 'Approved by the editor'), SUBMITTER, null, { status: 'approved', approvedBy: EDITOR, approvedAt: now, publishAfter: now + 5 * MIN, rev: 2 });
  await add('claimed', post('claimed', 'Claimed by a run'), SUBMITTER, null, { status: 'publishing', approvedBy: EDITOR, approvedAt: now - 9 * MIN, publishAfter: now - 4 * MIN, rev: 3 });
  for (let i = 0; i < more; i += 1) await add(`more${i}`, post(`more-${i}`, `More ${i}`), SUBMITTER, null);
  server.db = db;
  return ids;
}

// ── A fake Auth Kit, the shape desk.js and authedCall read ──────────────────
/** switchTo(userId) moves the kit to another account and tells every listener, as a sign-in in another tab does. */
export function fakeKit(first, { label = 'Label', token = null } = {}) {
  const log = [];
  const listeners = [];
  let userId = first;
  const sessionOf = () => (userId ? { id: `sess_${userId}`, user: { id: userId }, getToken: async () => token || `tok:${userId}` } : null);
  let session = sessionOf();
  const kit = {
    log,
    snapshot: () => ({ status: userId ? 'signed-in' : 'signed-out', signedIn: !!userId, userId, label, clerk: userId ? { session } : null }),
    get state() { return kit.snapshot(); },
    start(options) { log.push(['start', options]); return Promise.resolve(kit.snapshot()); },
    onChange(fn) { log.push(['onChange']); listeners.push(fn); queueMicrotask(() => fn(kit.snapshot())); return () => {}; },
    convexToken: async () => (session ? session.getToken({ template: 'convex' }) : null),
    requireSignIn: async (options) => { log.push(['requireSignIn', options]); return false; },
    bindConvex: () => log.push(['bindConvex']),
    switchTo(next) { userId = next; session = sessionOf(); for (const fn of listeners) fn(kit.snapshot()); },
  };
  return kit;
}

// ── The page, and a desk started on it ─────────────────────────────────────
const HTML_FILE = readFileSync(new URL('../../desk.html', import.meta.url), 'utf8');
const URL_SET = 'https://happy-otter-123.convex.cloud';
// Once setup-antenne.sh stage 2 has run, the committed desk.html names a real
// deployment in its meta and connect-src (section 9 stage 2). The harness always
// starts from the not-set-up page and puts URL_SET in itself, so take that back
// out here rather than depending on which state the tree is in.
const LIVE = (HTML_FILE.match(/<meta name="neo-convex-url" content="([^"]*)">/) || [])[1] || '';
export const HTML = LIVE
  ? HTML_FILE.replace(`content="${LIVE}"`, 'content=""').replace(` ${LIVE};`, ';')
  : HTML_FILE;
export const intervals = [];
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms, live: true }); return intervals.length; };
globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].live = false; };
export let fetched = 0;
globalThis.fetch = async () => { fetched += 1; throw new Error('the desk must not fetch'); };

installDom();
loadPage(HTML);
export const $ = (id) => document.getElementById(id);
export const all = (sel, root = $('lanes')) => root.querySelectorAll(sel);
export const acts = (root = $('lanes')) => all('[data-act]', root).map((b) => b.dataset.act);

// The first import boots with desk.html as committed: the meta is empty.
export const { boot } = await import('../../js/desk.js');
await settle();

export let stop = null;
export const written = [];
/** Loads desk.html naming a deployment and boots the desk for userId; returns the index of its first call. */
export async function start(userId, options) {
  if (stop) stop();
  written.push(...writes());
  loadPage(HTML.replace('<meta name="neo-convex-url" content="">', `<meta name="neo-convex-url" content="${URL_SET}">`));
  globalThis.__kit = fakeKit(userId, options);
  const from = server.calls.length;
  stop = boot();
  await settle();
  return from;
}
export const click = async (node) => { fire(node, 'click'); await settle(); };
export const focus = async () => { fireGlobal('window', 'focus'); await settle(); };
export const btn = (act, draftId) => all(`[data-act="${act}"]${draftId ? `[data-draft="${draftId}"]` : ''}`)[0] || null;
export const row = (id) => server.db.rows('drafts').find((d) => d._id === id);

/** A tally of eq() checks, printed per section, for one test file. */
export function checker() {
  const t = { failed: 0, checks: 0 };
  t.eq = (actual, expected, what) => {
    t.checks += 1;
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a === e) return;
    t.failed += 1;
    console.error(`FAIL ${what}\n  expected ${e}\n  got      ${a}`);
  };
  t.section = async (title, fn) => {
    const before = [t.failed, t.checks];
    await fn();
    const n = t.checks - before[1];
    if (t.failed === before[0]) console.log(`ok   ${title} (${n} checks)`);
    else console.error(`FAIL ${title}: ${t.failed - before[0]} of ${n} checks`);
  };
  return t;
}
