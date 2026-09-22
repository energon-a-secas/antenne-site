// Shape from projects/vitrina-site/tests/convex-contract.test.mjs: its limits stated literally, then checks that read text.
// Plain node, no install. Run with: make validate
//
// What the desk backend contract (docs/plans/2026-09-15-antenne-desk.md
// sections 1, 4 and 7) fixes and no behaviour test can see.
//
// The behaviour tests read their numbers from convex/lib/limits.ts, so a number
// changed there moves its tests with it. The numbers are stated here literally,
// once. The rest reads text: every public function resolves its caller; no
// secret and no unsafeMetadata in convex/ or js/; one TypeScript spelling the
// Convex CLI refuses; the fleet rules for convex/; convex/lib/canonical.ts
// hashing with no import and no Web Crypto, against node:crypto; and the desk.html and
// js/theme-boot.js guards. Each text check is a function, run on the real files
// and then on copies broken on purpose, so every guard is shown to trip.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as canonical from '../convex/lib/canonical.ts';
import * as limits from '../convex/lib/limits.ts';
import * as serverPost from '../convex/lib/post.ts';

let failed = 0;
let checks = 0;
function eq(actual, expected, what) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
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
const list = (dir, keep) => readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
  .map((name) => `${dir}/${String(name).replace(/\\/g, '/')}`).filter(keep).sort();
/** The fixture must find its text, or the broken copy would be the real file and prove nothing. */
function swap(text, from, to) {
  eq(text.includes(from), true, `fixture finds ${JSON.stringify(from.slice(0, 60))}`);
  return text.replace(from, to);
}
/** Comments and string literals blanked to spaces, newlines kept, so offsets and line numbers still match. */
function blank(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

await section('the numbers of section 4.4, and of 4.3 and 6.1, as the contract writes them', () => {
  eq(limits.LIMITS, {
    'draft.submit': { max: 30, windowMs: HOUR },
    'draft.write': { max: 600, windowMs: HOUR },
    'access.request': { max: 3, windowMs: DAY },
    'machine.submit': { max: 60, windowMs: HOUR },
    'machine.status': { max: 120, windowMs: HOUR },
    'machine.publish': { max: 120, windowMs: HOUR },
  }, 'per subject 30 submits and 600 writes an hour and 3 access requests a day; per machine key 60 submits, 120 status and 120 publish calls an hour');
  eq([...limits.LIMIT_NAMES], ['draft.submit', 'draft.write', 'access.request', 'machine.submit', 'machine.status', 'machine.publish'], 'the six limit names');
  const CAPS = {
    SUBMIT_BATCH_MAX: 12, MACHINE_PENDING_MAX: 40, DESK_PENDING_MAX: 20, REQUESTS_MAX: 50, APPROVE_MANY_MAX: 25, CLAIM_MAX: 25, BODY_MAX_BYTES: 64000,
    SIGNATURE_WINDOW_MS: 300000, PUBLISH_DELAY_DEFAULT_MS: 300000, PUBLISH_DELAY_MAX_MS: 1800000, RUN_MAX_ATTEMPTS: 5,
    DISPATCH_STALE_MS: 1200000, CLAIM_STALE_MS: 1800000,
  };
  eq(Object.fromEntries(Object.keys(CAPS).map((k) => [k, limits[k]])), CAPS, 'section 4.4 caps, literally');
  const MORE = {
    QUEUE_PER_STATUS_MAX: 200, LIVE_SHOWN_MS: 7 * DAY, SPIKED_SHOWN_MS: 30 * DAY, REVOKE_MOVE_MAX: 100, NOTE_MAX: 200,
    TOKEN_WARNING_MS: 30 * DAY, LABEL_MAX: 80, EMAIL_MAX: 254, RATE_PRUNE_MAX: 100, RATE_SWEEP_AGE_MS: 31 * DAY,
    REQUEST_SWEEP_AGE_MS: 30 * DAY, SPIKED_SWEEP_AGE_MS: 90 * DAY, RUN_SWEEP_AGE_MS: 30 * DAY,
  };
  eq(Object.fromEntries(Object.keys(MORE).map((k) => [k, limits[k]])), MORE, 'sections 4.3 and 6.1: 200 per status, live 7 and spiked 30 days, 100 moved per revoke, notes of 200, a 30-day token warning, sweeps at 31, 30, 90 and 30 days');
  eq(Object.keys(limits).sort(), [...Object.keys(CAPS), ...Object.keys(MORE), 'LIMITS', 'LIMIT_NAMES'].sort(), 'limits.ts exports no number this test does not state');
  eq(Object.isFrozen(limits.LIMITS) && Object.values(limits.LIMITS).every(Object.isFrozen), true, 'LIMITS cannot change at run time');
  eq(Object.entries(limits.LIMITS).filter(([, l]) => limits.RATE_SWEEP_AGE_MS <= l.windowMs).map(([n]) => n), [], 'the daily sweep never deletes a rate row a window still counts');
});

// ── Every public function resolves its caller ───────────────────────────────
/** Problems with the exported queries, mutations and actions in one convex/*.ts source. */
function accessProblems(source) {
  const code = blank(source);
  const lines = source.split('\n');
  const problems = [];
  for (const m of code.matchAll(/export\s+const\s+(\w+)\s*=\s*(query|mutation|action)\s*\(/g)) {
    let depth = 0;
    let end = code.length;
    for (let i = m.index + m[0].length - 1; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = code.slice(m.index, end);
    let row = code.slice(0, m.index).split('\n').length - 2;
    let open = false;
    while (row >= 0 && /^\s*\/\//.test(lines[row])) {
      if (/^\s*\/\/\s*access: open \([^)]*\S[^)]*\)/.test(lines[row])) open = true;
      row -= 1;
    }
    if (open) continue;
    if (!/\bresolveCaller\(/.test(body)) problems.push(`${m[1]}: no resolveCaller and no "// access: open (reason)" comment`);
    else if (!/\b\w+Core\(/.test(body)) problems.push(`${m[1]}: calls no core`);
  }
  return problems;
}
const WRAPPERS = {
  'convex/desk.ts': { me: 'query', queue: 'query' },
  'convex/drafts.ts': {
    submit: 'mutation', edit: 'mutation', approve: 'mutation', approveMany: 'mutation', withdraw: 'mutation', reopen: 'mutation',
    take: 'mutation', overrideLinks: 'mutation', spike: 'mutation', assign: 'mutation', recheckLinks: 'mutation',
  },
  'convex/members.ts': { list: 'query', assignable: 'query', grant: 'mutation', revoke: 'mutation', requestAccess: 'mutation', dismissRequest: 'mutation' },
  'convex/settings.ts': { get: 'query', update: 'mutation' },
};
await section('every exported query, mutation or action in convex/*.ts resolves its caller or says why it is open', () => {
  const top = list('convex', (n) => /^convex\/[^/]+\.ts$/.test(n));
  for (const file of top) eq(accessProblems(read(file)), [], `${file}`);
  for (const [file, fns] of Object.entries(WRAPPERS)) {
    const found = Object.fromEntries([...blank(read(file)).matchAll(/export\s+const\s+(\w+)\s*=\s*(query|mutation|action)\s*\(/g)].map((m) => [m[1], m[2]]));
    eq(Object.fromEntries(Object.keys(fns).map((k) => [k, found[k] ?? null])), fns, `${file} exports section 4.3's functions as their kinds`);
  }
  const fn = (kind, body, above = '') => `${above}export const a = ${kind}({\n  args: {},\n  handler: async (ctx) => {\n${body}\n  },\n});\n`;
  eq(accessProblems(fn('mutation', '    return await aCore(ctx.db);')), ['a: no resolveCaller and no "// access: open (reason)" comment'], 'a mutation that never resolves its caller trips');
  eq(accessProblems(fn('query', '    // resolveCaller(ctx.db)\n    return aCore(ctx.db);')).length, 1, 'resolveCaller named only in a comment trips');
  eq(accessProblems(fn('query', '    const s = "resolveCaller(";\n    return aCore(s);')).length, 1, 'or only inside a string');
  eq(accessProblems(fn('action', '    return aCore(ctx.db);', '// access: open ()\n')).length, 1, 'an open comment with no reason trips');
  eq(accessProblems(fn('mutation', '    return await resolveCaller(ctx.db, null, {});')), ['a: calls no core'], 'resolving without calling a core trips');
  eq(accessProblems(fn('query', '    return { ok: true };', '// access: open (a health check that reads no desk data)\n')), [], 'an open comment with a reason passes');
  eq(accessProblems(fn('action', '    const c = await resolveCaller(ctx.db, null, {});\n    return aCore(ctx.db, c);')), [], 'resolving and calling a core passes');
  eq(accessProblems('export const a = internalMutation({ handler: async () => 1 });\nexport const b = httpAction(async () => new Response());'), [], 'internal functions and HTTP actions are not browser-callable queries or mutations');
});

// Cores never read process.env, so each wrapper file copies the desk variables
// itself; one copy that loses DESK_DENY keeps a denied owner an owner. A file
// that resolves callers or reads the owner or deny list copies all three. The
// behaviour behind this is swept in tests/convex-members.test.mjs; this is the
// backstop for internal functions, which that sweep does not call.
const DESK_VARS = ['DESK_OWNERS', 'DESK_DENY', 'DESK_FROZEN'];
function envProblems(name, source) {
  const code = blank(source);
  if (!/\bresolveCaller\(|\bprocess\.env\.DESK_(?:OWNERS|DENY)\b/.test(code)) return [];
  return DESK_VARS.filter((k) => !new RegExp(`\\b${k}\\s*:\\s*process\\.env\\.${k}\\b`).test(code)).map((k) => `${name}: does not copy ${k} from process.env`);
}
await section('every convex/*.ts that resolves callers copies DESK_OWNERS, DESK_DENY and DESK_FROZEN from process.env', () => {
  const top = list('convex', (n) => /^convex\/[^/]+\.ts$/.test(n));
  const bare = (f) => blank(read(f)).replace(/\bprocess\.env\.DESK_\w+/g, 'undefined');
  eq(Object.keys(WRAPPERS).map((f) => envProblems(f, bare(f)).length), [3, 3, 3, 3], 'the rule reaches the four desk wrappers: with their copies gone, each trips three times');
  eq(top.flatMap((f) => envProblems(f, read(f))), [], `${top.length} files copy all three where they need them`);
  const env = 'function deskEnv(): DeskEnv {\n  return { DESK_OWNERS: process.env.DESK_OWNERS, DESK_DENY: process.env.DESK_DENY, DESK_FROZEN: process.env.DESK_FROZEN };\n}\nconst c = await resolveCaller(ctx.db, s, deskEnv());\n';
  eq(envProblems('convex/x.ts', env), [], 'all three copied passes');
  eq(envProblems('convex/x.ts', swap(env, ' DESK_DENY: process.env.DESK_DENY,', '')), ['convex/x.ts: does not copy DESK_DENY from process.env'], 'dropping DESK_DENY trips');
  eq(envProblems('convex/x.ts', swap(env, 'DESK_FROZEN: process.env.DESK_FROZEN', 'DESK_FROZEN: undefined')), ['convex/x.ts: does not copy DESK_FROZEN from process.env'], 'DESK_FROZEN set to anything else trips');
  eq(envProblems('convex/x.ts', swap(env, 'DESK_OWNERS: process.env.DESK_OWNERS', 'DESK_OWNERS: process.env.DESK_DENY')), ['convex/x.ts: does not copy DESK_OWNERS from process.env'], 'a key copied from the wrong variable trips');
  eq(envProblems('convex/x.ts', `// DESK_DENY: process.env.DESK_DENY\n${swap(env, ' DESK_DENY: process.env.DESK_DENY,', '')}`).length, 1, 'a copy only in a comment trips');
  eq(envProblems('convex/http.ts', 'const e = { MACHINE_KEYS: process.env.MACHINE_KEYS, DESK_FROZEN: process.env.DESK_FROZEN };'), [], 'a machine route that only reads DESK_FROZEN is not held to it');
});

// ── No secret and no unsafeMetadata in convex/ or js/ ───────────────────────
const FORBIDDEN = ['unsafeMetadata', 'sk_live_', 'CLERK_SECRET_KEY'];
// Section 3.2's token check names sk_live_ in order to refuse it, in both
// JavaScript enforcers. Exactly that literal is exempt, once per file.
const TOKEN_RE_LITERAL = '/sk-ant-|ghp_|gho_|ghs_|github_pat_|sk_live_|sk_test_|xox[abprs]-|AKIA[0-9A-Z]{16}|-----BEGIN/';
const TOKEN_RE_FILES = ['js/schema.js', 'convex/lib/post.ts'];
// The vendored Auth Kit reads and writes unsafeMetadata for its "Your Neorgon
// sites" list, never for desk authority; it is packages/neorgon-ui's file, kept
// identical by sync-auth.sh --check. It is exempt from that one word, only
// while it carries the kit's banner.
const KIT = 'js/neorgon-auth.js';
const KIT_BANNER = 'Vendored per site as js/neorgon-auth.js by packages/neorgon-ui/sync-auth.sh.';
function secretProblems(path, text) {
  let body = text;
  if (TOKEN_RE_FILES.includes(path)) {
    const n = body.split(TOKEN_RE_LITERAL).length - 1;
    if (n !== 1) return [`${path}: the token regex appears ${n} times, not once`];
    body = body.replace(TOKEN_RE_LITERAL, '');
  }
  return FORBIDDEN.filter((word) => body.includes(word) && !(word === 'unsafeMetadata' && path === KIT && text.includes(KIT_BANNER))).map((word) => `${path}: ${word}`);
}
await section('no unsafeMetadata, sk_live_ or CLERK_SECRET_KEY in convex/ or js/', () => {
  const scanned = [
    ...list('convex', (n) => /\.(ts|js|mjs)$/.test(n) && !n.startsWith('convex/_generated/')),
    ...list('js', (n) => /\.(ts|js|mjs)$/.test(n)),
  ];
  eq([...TOKEN_RE_FILES, KIT].every((f) => scanned.includes(f)), true, 'the scan reads both enforcers and the vendored kit');
  eq(scanned.flatMap((f) => secretProblems(f, read(f))), [], `${scanned.length} files clean`);
  eq(secretProblems('convex/lib/x.ts', 'const m = identity.unsafeMetadata;'), ['convex/lib/x.ts: unsafeMetadata'], 'unsafeMetadata in convex/ trips');
  eq(secretProblems('js/desk.js', 'const key = "sk_live_abc";'), ['js/desk.js: sk_live_'], 'a live secret key in js/ trips');
  eq(secretProblems('convex/http.ts', 'process.env.CLERK_SECRET_KEY'), ['convex/http.ts: CLERK_SECRET_KEY'], 'the Clerk secret key variable trips');
  eq(secretProblems('js/schema.js', `${TOKEN_RE_LITERAL}\nconst k = "sk_live_x";`), ['js/schema.js: sk_live_'], 'the token regex exempts itself and nothing beside it');
  eq(secretProblems('js/schema.js', 'no regex here').length, 1, 'an enforcer that lost its token regex trips');
  eq(secretProblems(KIT, 'user.unsafeMetadata'), [`${KIT}: unsafeMetadata`], 'the kit without its banner trips');
  eq(secretProblems(KIT, `${KIT_BANNER} user.unsafeMetadata sk_live_x`), [`${KIT}: sk_live_`], 'the kit exemption covers unsafeMetadata only');
  eq(secretProblems('js/desk-api.js', `${KIT_BANNER} user.unsafeMetadata`), ['js/desk-api.js: unsafeMetadata'], 'and the kit\'s path only');
});

// ── A spelling the Convex CLI refuses ───────────────────────────────────────
// Since TypeScript 5.7 a bare Uint8Array type means Uint8Array<ArrayBufferLike>,
// which Web Crypto's BufferSource does not accept, and a deploy that typechecks
// fails on it. make validate has no tsc, so the spelling is kept out instead.
function bareUint8(name, source) {
  const found = [];
  source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/\/\/[^\n]*/g, '').split('\n').forEach((line, i) => {
    if (/(?::|<|,|\||\bas)\s*Uint8Array\b(?!\s*<)/.test(line)) found.push(`${name}:${i + 1}`);
  });
  return found;
}
await section('no type in convex/ is a bare Uint8Array', () => {
  const sources = list('convex', (n) => n.endsWith('.ts') && !n.startsWith('convex/_generated/'));
  eq(sources.includes('convex/lib/canonical.ts'), true, 'the scan reads convex/lib, where the byte arrays are');
  eq(sources.flatMap((f) => bareUint8(f, read(f))), [], 'each byte array type says Uint8Array<ArrayBuffer>');
  eq(bareUint8('x.ts', 'function f(b: Uint8Array) {}\nconst c = d as Uint8Array;\nlet e: Map<string, Uint8Array>;'), ['x.ts:1', 'x.ts:2', 'x.ts:3'], 'a parameter, a cast and a type argument trip');
  eq(bareUint8('x.ts', 'function f(b: Uint8Array<ArrayBuffer>) {}\nconst c = new Uint8Array(8); // : Uint8Array'), [], 'the full spelling, a constructor and a comment pass');
});

// ── The fleet rules for convex/ ─────────────────────────────────────────────
// Written as a char code: the fleet rule forbids the character itself in any file.
const EM_DASH = String.fromCharCode(0x2014);
function fleetProblems(name, source) {
  const problems = [];
  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  if (lines > 500) problems.push(`${name}: ${lines} lines`);
  if (source.includes(EM_DASH)) problems.push(`${name}: an em dash`);
  if (name.startsWith('convex/lib/')) {
    const code = blank(source);
    if (/\bprocess\.env\b/.test(code)) problems.push(`${name}: reads process.env`);
    for (const m of source.matchAll(/^\s*(?:import|export)\b[^'"]*from\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
      if (!m[1].endsWith('.ts')) problems.push(`${name}: imports ${m[1]} without .ts`);
    }
  }
  return problems;
}
await section('convex/ and these tests: at most 500 lines, no em dash; cores read no env and import siblings with .ts', () => {
  const files = [
    ...list('convex', (n) => n.endsWith('.ts') && !n.startsWith('convex/_generated/')),
    ...list('tests', (n) => /^tests\/convex-[\w-]+\.test\.mjs$/.test(n) || n === 'tests/support/fakedb.mjs'),
  ];
  eq(files.length >= 20, true, `${files.length} files scanned`);
  eq(files.flatMap((f) => fleetProblems(f, read(f))), [], 'all of them keep the rules');
  eq(fleetProblems('convex/lib/x.ts', 'const a = process.env.DESK_OWNERS;\n'), ['convex/lib/x.ts: reads process.env'], 'a core reading process.env trips');
  eq(fleetProblems('convex/lib/x.ts', '// process.env is read by the wrappers\nconst a = 1;\n'), [], 'a comment naming it does not');
  eq(fleetProblems('convex/lib/x.ts', 'import { fail } from "./result";\n'), ['convex/lib/x.ts: imports ./result without .ts'], 'a sibling import without .ts trips');
  eq(fleetProblems('convex/x.ts', `${'a\n'.repeat(501)}`), ['convex/x.ts: 501 lines'], 'a 501-line file trips');
  eq(fleetProblems('convex/x.ts', `a ${EM_DASH} b\n`), ['convex/x.ts: an em dash'], 'an em dash trips');
});

// ── desk.html and js/theme-boot.js (sections 1 and 7) ───────────────────────
const CONVEX_URL_RE = /^https:\/\/[a-z-]+-\d+\.convex\.cloud$/;
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};
// Section 7's desk.html policy, literally. The Convex host is not in it: the
// checks above let it into connect-src only, and only when the meta is set.
// Every other directive must be exactly this; script-src may be narrower (a
// source dropped, or a path under one of its hosts) but never wider.
const SECTION_7_CSP = "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self' https://clerk.neorgon.com https://challenges.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.neorgon.org https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.neorgon.org https://img.clerk.com; connect-src 'self' https://clerk.neorgon.com; frame-src https://challenges.cloudflare.com; worker-src blob:; upgrade-insecure-requests";
const cspDirectives = (text) => text.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([n, ...s]) => [n, s]);
function policyProblems(content) {
  const want = new Map(cspDirectives(SECTION_7_CSP));
  const got = cspDirectives(content).map(([n, s]) => [n, s.filter((x) => !/convex\.(cloud|site)/.test(x))]);
  const names = got.map(([n]) => n);
  const problems = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].map((n) => `the CSP names ${n} twice`);
  for (const n of want.keys()) if (!names.includes(n)) problems.push(`the CSP has no ${n}`);
  for (const [n, sources] of got) {
    if (!want.has(n)) { problems.push(`the CSP adds ${n}, which section 7 does not have`); continue; }
    const allowed = want.get(n);
    const hosts = allowed.filter((s) => s.startsWith('https://'));
    const extra = sources.filter((s) => !allowed.includes(s) && !(n === 'script-src' && hosts.some((h) => s.startsWith(`${h}/`))));
    const missing = n === 'script-src' ? [] : allowed.filter((s) => !sources.includes(s));
    if (extra.length || missing.length) problems.push(`${n} is not section 7's:${extra.length ? ` adds ${extra.join(' ')}` : ''}${missing.length ? ` lacks ${missing.join(' ')}` : ''}`);
  }
  return problems;
}
// The frame check in its usual spellings: top and self compared either way round, then the page hidden.
const FRAME_CHECK = /if\s*\(\s*(?:(?:window\.)?top\s*!==?\s*(?:window\.)?self|(?:window\.)?self\s*!==?\s*(?:window\.)?top)\s*\)\s*\{?\s*document\.documentElement\.style\.(?:setProperty\(\s*(['"])display\1\s*,\s*(['"])none\2|display\s*=\s*(['"])none\3)/;
function deskProblems(html, boot) {
  const problems = [];
  const tags = (el) => [...html.matchAll(new RegExp(`<${el}\\b[^>]*>`, 'g'))].map((m) => m[0]);
  const metas = (name) => tags('meta').filter((t) => attr(t, 'name') === name);
  const convex = metas('neo-convex-url');
  if (convex.length !== 1) problems.push(`neo-convex-url meta: found ${convex.length}, expected 1`);
  const csp = tags('meta').filter((t) => attr(t, 'http-equiv') === 'Content-Security-Policy');
  if (csp.length !== 1) return [...problems, `CSP meta: found ${csp.length}, expected 1`];
  const directives = new Map(attr(csp[0], 'content').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([n, ...s]) => [n, s]));
  const hosts = [...directives].flatMap(([n, sources]) => sources.filter((s) => /convex\.(cloud|site)/.test(s)).map((s) => `${n} ${s}`));
  const url = convex.length === 1 ? attr(convex[0], 'content') : null;
  if (url === '' && hosts.length) problems.push(`neo-convex-url is empty but the CSP names ${hosts.join(', ')}`);
  if (url && !CONVEX_URL_RE.test(url)) problems.push('neo-convex-url is set but is no Convex cloud URL');
  else if (url && JSON.stringify(hosts) !== JSON.stringify([`connect-src ${url}`])) problems.push(`the CSP must name ${url} in connect-src and nowhere else, and no other Convex host`);
  if ((directives.get('script-src') || []).includes("'unsafe-inline'")) problems.push("script-src allows 'unsafe-inline'");
  if (JSON.stringify(directives.get('object-src')) !== JSON.stringify(["'none'"])) problems.push("object-src is not 'none'");
  problems.push(...policyProblems(attr(csp[0], 'content')));
  const inline = tags('script').filter((t) => attr(t, 'src') === null).length;
  if (inline) problems.push(`${inline} script element(s) without src`);
  const analytics = metas('neo-analytics');
  if (analytics.length !== 1 || attr(analytics[0], 'content') !== 'off') problems.push('neo-analytics is not off');
  const bootTag = tags('script').find((t) => attr(t, 'src') === 'js/theme-boot.js');
  if (!bootTag || /\s(defer|async)\b|type="module"/.test(bootTag)) problems.push('js/theme-boot.js is not a classic blocking script');
  const code = boot.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const guard = code.search(FRAME_CHECK);
  const cookie = code.indexOf('document.cookie');
  if (guard < 0) problems.push('js/theme-boot.js does not hide a framed page');
  else if (cookie >= 0 && cookie < guard) problems.push('js/theme-boot.js reads document.cookie before the frame check');
  return problems;
}
await section('desk.html: section 7\'s CSP and no wider, the Convex URL and its CSP host agree, no inline script, object-src none, no analytics; theme-boot hides a frame first', () => {
  const html = read('desk.html');
  const boot = read('js/theme-boot.js');
  eq(deskProblems(html, boot), [], 'desk.html and js/theme-boot.js as they are');
  const cloud = 'https://happy-otter-123.convex.cloud';
  const connect = "connect-src 'self' https://clerk.neorgon.com;";
  const set = swap(html, '<meta name="neo-convex-url" content="">', `<meta name="neo-convex-url" content="${cloud}">`);
  const wired = swap(set, connect, connect.replace(';', ` ${cloud};`));
  eq(deskProblems(wired, boot), [], 'a URL in the meta with exactly that host in connect-src passes (the wizard writes both)');
  eq(deskProblems(set, boot).length, 1, 'a URL in the meta with no CSP host trips');
  eq(deskProblems(swap(html, connect, connect.replace(';', ` ${cloud};`)), boot).length, 1, 'a Convex host in the CSP with an empty meta trips');
  eq(deskProblems(swap(wired, `${cloud};`, `${cloud} https://other-otter-9.convex.cloud;`), boot).length, 1, 'a second Convex host trips');
  eq(deskProblems(swap(wired, "script-src 'self'", `script-src 'self' ${cloud}`), boot).length, 1, 'the host outside connect-src trips');
  eq(deskProblems(swap(wired, `content="${cloud}"`, 'content="https://evil.example.com"'), boot).length, 1, 'a meta that is no Convex URL trips');
  eq(deskProblems(swap(html, "script-src 'self'", "script-src 'self' 'unsafe-inline'"), boot), ["script-src allows 'unsafe-inline'", "script-src is not section 7's: adds 'unsafe-inline'"], "'unsafe-inline' trips");
  eq(deskProblems(swap(html, "object-src 'none'; ", ''), boot), ["object-src is not 'none'", 'the CSP has no object-src'], 'a missing object-src trips');
  const widened = [
    ["default-src 'self'", 'default-src *', ["default-src is not section 7's: adds * lacks 'self'"]],
    ['frame-src https://challenges.cloudflare.com', 'frame-src *', ["frame-src is not section 7's: adds * lacks https://challenges.cloudflare.com"]],
    ['https://cdn.jsdelivr.net;', 'https://cdn.jsdelivr.net https:;', ["script-src is not section 7's: adds https:"]],
    ['https://cdn.jsdelivr.net;', 'https://cdn.jsdelivr.net.evil.example;', ["script-src is not section 7's: adds https://cdn.jsdelivr.net.evil.example"]],
    ["connect-src 'self' https://clerk.neorgon.com;", "connect-src 'self' https://clerk.neorgon.com https:;", ["connect-src is not section 7's: adds https:"]],
    ["img-src 'self' data:", "img-src 'self' data: blob:", ["img-src is not section 7's: adds blob:"]],
    ["base-uri 'self'; ", '', ['the CSP has no base-uri']],
    ['upgrade-insecure-requests', 'upgrade-insecure-requests; script-src-elem *', ['the CSP adds script-src-elem, which section 7 does not have']],
    ['upgrade-insecure-requests', "upgrade-insecure-requests; default-src 'self'", ['the CSP names default-src twice']],
  ];
  for (const [from, to, want] of widened) eq(deskProblems(swap(html, from, to), boot), want, `${to} trips`);
  eq(deskProblems(swap(html, 'https://cdn.jsdelivr.net;', 'https://cdn.jsdelivr.net/npm/convex@1.45.0/;'), boot), [], 'a script-src narrowed to a path under one of its hosts passes');
  eq(deskProblems(swap(html, "script-src 'self' https://clerk.neorgon.com", "script-src 'self'"), boot), [], 'and so does a script-src with a source dropped');
  eq(deskProblems(swap(html, '</body>', '<script>void 0</script></body>'), boot), ['1 script element(s) without src'], 'an inline script trips');
  eq(deskProblems(swap(html, '<meta name="neo-analytics" content="off">', '<meta name="neo-analytics" content="on">'), boot), ['neo-analytics is not off'], 'analytics on trips');
  eq(deskProblems(swap(html, '<meta name="neo-convex-url" content="">', ''), boot), ['neo-convex-url meta: found 0, expected 1'], 'a missing meta trips');
  eq(deskProblems(swap(html, '<script src="js/theme-boot.js">', '<script defer src="js/theme-boot.js">'), boot), ['js/theme-boot.js is not a classic blocking script'], 'a deferred theme-boot trips');
  const check = "  if (window.top !== window.self) document.documentElement.style.setProperty('display', 'none', 'important');\n";
  eq(deskProblems(html, `${swap(boot, check, '')}\n${check}`), ['js/theme-boot.js reads document.cookie before the frame check'], 'a frame check after the cookie read trips');
  eq(deskProblems(html, swap(boot, 'window.top !== window.self', 'false')), ['js/theme-boot.js does not hide a framed page'], 'no frame check trips');
  eq(deskProblems(html, swap(boot, check, '  if (self !== top) { document.documentElement.style.display = "none"; }\n')), [], 'the same frame check spelled another way passes');
  eq(deskProblems(html, swap(boot, 'window.top !== window.self', 'window.top === window.self')), ['js/theme-boot.js does not hide a framed page'], 'a check that hides the unframed page instead trips');
  eq(deskProblems(html, swap(boot, "'display', 'none'", "'display', 'block'")), ['js/theme-boot.js does not hide a framed page'], 'a check that shows the framed page trips');
});

// ── convex/lib/canonical.ts hashes in plain TypeScript (section 3.3) ───────
// Web Crypto inside Convex queries and mutations is unverified, and every
// approval hash comes from this file, so it imports nothing and names no
// crypto. Its digest is held to node:crypto at each padding boundary: 55 bytes
// is the most one block carries with its length, 56 needs a second block, 64
// fills one, 119 is the most two carry. Multi-byte characters land on every
// side of each.
function canonicalProblems(source) {
  const code = blank(source);
  return [...(/\bimport\b|\brequire\s*\(/.test(code) ? ['imports'] : []), ...(/\bcrypto\b/.test(code) ? ['names crypto'] : [])];
}
const nodeSha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Exactly `bytes` UTF-8 bytes: as many of `unit` as fit, and ASCII for the rest, first when `lead`. */
function textOf(bytes, unit, lead) {
  const size = Buffer.byteLength(unit);
  const [body, pad] = [unit.repeat(Math.floor(bytes / size)), 'x'.repeat(bytes % size)];
  return lead ? pad + body : body + pad;
}
/** Exactly `bytes` UTF-8 bytes of 1, 2, 3 and 4 byte characters in turn, so each boundary splits a different one. */
function mixedOf(bytes) {
  const cycle = ['a', 'é', '€', '\u{1F600}'];
  let text = '';
  for (let i = 0; Buffer.byteLength(text) + Buffer.byteLength(cycle[i % 4]) <= bytes; i += 1) text += cycle[i % 4];
  return text + 'x'.repeat(bytes - Buffer.byteLength(text));
}
await section('convex/lib/canonical.ts computes SHA-256 itself: nothing imported, no Web Crypto, node:crypto\'s digest at every block boundary', async () => {
  eq(canonicalProblems(read('convex/lib/canonical.ts')), [], 'canonical.ts imports nothing and never names crypto');
  eq(canonicalProblems('import { x } from "./x.ts";\nconst d = await crypto.subtle.digest("SHA-256", b);'), ['imports', 'names crypto'], 'an import and crypto.subtle trip');
  eq([canonicalProblems('const m = await import(name);'), canonicalProblems('const d = globalThis.crypto;')], [['imports'], ['names crypto']], 'so do a dynamic import and globalThis.crypto');
  eq(canonicalProblems('// crypto.subtle is never used\nconst s = "import";\n'), [], 'a comment or a string naming them does not');
  eq(serverPost.contentHash === canonical.contentHash && serverPost.canonicalJson === canonical.canonicalJson, true, 'convex/lib/post.ts hands out exactly these two functions');

  const settle = async (fn) => {
    try { return await fn(); } catch (err) { return `threw ${err.name}: ${err.message}`; }
  };
  const vectors = JSON.parse(read('tests/hash-vectors.json')).vectors;
  const good = vectors.filter((h) => !h.error);
  for (const h of vectors.filter((v) => v.error)) eq(/^threw /.test(await settle(() => canonical.contentHash(h.value))), true, `contentHash refuses ${h.name}`);
  const hidden = ['crypto', 'TextEncoder'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const answers = [];
  try {
    for (const [name] of hidden) Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
    for (const h of good) answers.push(await settle(() => canonical.contentHash(h.value)));
  } finally {
    for (const [name, descriptor] of hidden) Object.defineProperty(globalThis, name, descriptor);
  }
  eq(answers, good.map((h) => h.sha256), `with globalThis.crypto and TextEncoder taken away, all ${good.length} hash vectors still answer their hex`);
  eq([typeof globalThis.crypto.subtle, typeof TextEncoder], ['object', 'function'], 'and both globals are put back');

  eq(['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'].map(canonical.sha256Hex), [
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ], 'the FIPS 180-2 examples: empty, abc, and the 56-byte message');
  const texts = [];
  const units = ['a', '', '', 'é', '߿', 'ࠀ', '€', '퟿', '', '￿', '\u{10000}', '\u{1F600}', '\u{10FFFF}'];
  for (const bytes of [0, 1, 2, 3, 4, 5, 53, 54, 55, 56, 57, 58, 59, 62, 63, 64, 65, 66, 67, 117, 118, 119, 120, 121, 122, 127, 128, 129, 183, 184, 1000]) {
    for (const unit of units) for (const lead of [false, true]) texts.push([bytes, textOf(bytes, unit, lead)]);
  }
  for (let bytes = 0; bytes <= 260; bytes += 1) texts.push([bytes, mixedOf(bytes)]);
  texts.push([70000, 'é\u{1F600}a'.repeat(10000)]);
  eq(texts.filter(([bytes, text]) => Buffer.byteLength(text) !== bytes).length, 0, `the fixture: each of ${texts.length} texts is exactly its byte length`);
  const differ = texts.filter(([, text]) => canonical.sha256Hex(text) !== nodeSha(text)).map(([bytes, text]) => `${bytes} bytes starting U+${text.codePointAt(0)?.toString(16)}`);
  eq(differ, [], `sha256Hex equals node:crypto on ${texts.length} texts of 0 to 70000 bytes, around 55, 56, 64 and 119, in 1 to 4 byte characters`);
  const throws = (fn) => {
    try { fn(); return false; } catch { return true; }
  };
  eq(['\ud800', 'a\udc00b', '\udbff\ud800', 'x\udbff'].map((s) => throws(() => canonical.sha256Hex(s))), [true, true, true, true], 'a lone surrogate throws rather than hashing as U+FFFD');
});

await section('package.json pins convex exactly, for the CLI only; auth.config.ts trusts the fleet issuer', () => {
  const pkg = JSON.parse(read('package.json'));
  eq([pkg.private, pkg.type, pkg.dependencies, pkg.devDependencies ?? null], [true, 'module', { convex: '1.45.0' }, null], 'private, ESM, one dependency: convex 1.45.0 exactly');
  const lock = JSON.parse(read('package-lock.json'));
  eq([lock.packages[''].dependencies, lock.packages['node_modules/convex'].version], [{ convex: '1.45.0' }, '1.45.0'], 'package-lock.json resolves the same version');
  const auth = read('convex/auth.config.ts');
  eq([auth.includes('const CLERK_JWT_ISSUER = "https://clerk.neorgon.com";'), auth.includes('applicationID: "convex"')], [true, true], 'the Clerk issuer and the convex template audience');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
