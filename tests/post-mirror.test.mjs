// Plain node, no install. Run with: make validate
//
// One rule set, three enforcers (docs/plans/2026-09-15-antenne-desk.md section
// 3): js/schema.js for the feed and the desk, convex/lib/post.ts on the server,
// scripts/build-feed.py at commit. tests/post-vectors.json and
// tests/hash-vectors.json hold the answers, and a rule list copied into three
// languages drifts, so this runs every JavaScript enforcer over both
// (tests/test_build_feed.py runs the Python one). It then proves the public
// feed lost nothing: read mode against a verbatim copy of the normalizePost it
// replaced, over the vectors, the archive and a seeded fuzz corpus, down to the
// rendered card.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as schema from '../js/schema.js';
import * as serverPost from '../convex/lib/post.ts';
import * as data from '../js/data.js';
import { renderCard } from '../js/render.js';

// Every JavaScript enforcer, one entry each: the browser's and the server's.
const ENFORCERS = [
  ['js/schema.js', schema],
  ['convex/lib/post.ts', serverPost],
];

const MODES = ['read', 'archive', 'desk', 'submit'];
const STRICT = ['archive', 'desk', 'submit'];
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const POST_VECTORS = readJson('./post-vectors.json');
const HASH_VECTORS = readJson('./hash-vectors.json');
const ARCHIVE = readJson('../data/posts.json');

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
const threw = (fn) => {
  try { fn(); return false; } catch { return true; }
};
async function rejected(fn) {
  try { await fn(); return false; } catch { return true; }
}
const shape = (r) => ({ ok: r.ok, problems: r.problems, external: r.external, post: r.post });
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ── The constants are the ones the vectors pin ──────────────────────────────
await section('this node trims exactly the characters tests/post-vectors.json pins', () => {
  let trimmed = '';
  for (let c = 0; c < 0x10000; c += 1) if (String.fromCharCode(c).trim() === '') trimmed += String.fromCharCode(c);
  eq(trimmed, POST_VECTORS.rules.trim, 'String.prototype.trim removes the pinned set');
});
for (const [name, mod] of ENFORCERS) {
  await section(`${name} holds the pinned KINDS, CAPS and HOSTS, frozen`, () => {
    eq([...mod.KINDS], POST_VECTORS.rules.kinds, `${name} KINDS`);
    eq({ ...mod.CAPS }, POST_VECTORS.rules.caps, `${name} CAPS, in order`);
    eq(mod.HOSTS.map((h) => ({ ...h })), POST_VECTORS.rules.hosts, `${name} HOSTS`);
    eq([Object.isFrozen(mod.KINDS), Object.isFrozen(mod.CAPS), Object.isFrozen(mod.HOSTS), mod.HOSTS.every(Object.isFrozen)],
      [true, true, true, true], `${name} freezes KINDS, CAPS, HOSTS and each host`);
  });
}

// ── Every vector, every mode, every enforcer ────────────────────────────────
for (const [name, mod] of ENFORCERS) {
  await section(`${name} answers every post vector in every mode`, () => {
    for (const v of POST_VECTORS.vectors) {
      for (const mode of MODES) {
        const input = structuredClone(v.raw);
        let got;
        try {
          got = mod.validatePost(input, { mode, today: v.today });
        } catch (err) {
          // Recorded as a failure, so one throwing vector cannot hide the rest.
          eq(`threw ${err.name}: ${err.message}`, v.expect[mode], `${name}: ${v.name} [${mode}]`);
          continue;
        }
        eq(shape(got), v.expect[mode], `${name}: ${v.name} [${mode}]`);
        eq(Object.keys(got).sort(), ['external', 'ok', 'post', 'problems'], `${name}: ${v.name} [${mode}] returns exactly ok, post, problems, external`);
        eq(input, v.raw, `${name}: ${v.name} [${mode}] leaves its input untouched`);
      }
    }
  });
  await section(`${name} returns a post that shares nothing with its input`, () => {
    for (const mode of MODES) {
      const input = structuredClone(POST_VECTORS.vectors[0].raw);
      const { post } = mod.validatePost(input, { mode, today: POST_VECTORS.vectors[0].today });
      post.body.push('added');
      post.links[0].label = 'changed';
      post.tags.push('added');
      eq(input, POST_VECTORS.vectors[0].raw, `${name} [${mode}]: editing the returned post leaves the input alone`);
    }
  });
  await section(`${name} refuses a mode it does not know and a submit with no real today`, () => {
    const base = POST_VECTORS.vectors[0].raw;
    eq(threw(() => mod.validatePost(base, { mode: 'published' })), true, `${name}: an unknown mode throws`);
    eq(threw(() => mod.validatePost(base)), true, `${name}: no options throws`);
    eq(threw(() => mod.validatePost(base, { mode: 'submit' })), true, `${name}: submit without today throws`);
    eq(threw(() => mod.validatePost(base, { mode: 'submit', today: '2026-02-30' })), true, `${name}: submit with an impossible today throws`);
    eq(threw(() => mod.validatePost(base, { mode: 'submit', today: '2026-09-15\n' })), true, `${name}: submit with a padded today throws`);
    eq(threw(() => mod.validatePost(base, { mode: 'archive' })), false, `${name}: archive needs no today`);
    eq(threw(() => mod.validatePost(base, { mode: 'desk' })), false, `${name}: desk needs no today`);
  });
}

// ── The vectors cover every rule, code and mode ─────────────────────────────
// Field patterns with indices folded to []. Equality, not a superset: a code
// the contract never names must not appear either.
const COVERAGE = {
  strict: {
    post: ['format'],
    id: ['chars', 'format', 'id-date', 'required', 'token', 'too-long'],
    date: ['calendar', 'chars', 'format', 'required', 'token', 'window'],
    kind: ['chars', 'format', 'required', 'token'],
    site: ['chars', 'format', 'token'],
    title: ['chars', 'required', 'token', 'too-long'],
    summary: ['chars', 'required', 'token', 'too-long'],
    body: ['format', 'too-many'],
    'body[]': ['chars', 'format', 'required', 'token', 'too-long'],
    links: ['format', 'too-many'],
    'links[]': ['format'],
    'links[].label': ['chars', 'required', 'token', 'too-long'],
    'links[].url': ['chars', 'format', 'host', 'scheme', 'token', 'too-long'],
    tags: ['format', 'too-many'],
    'tags[]': ['chars', 'duplicate', 'format', 'token'],
  },
  read: { date: ['format', 'required'], id: ['format', 'required'], kind: ['format', 'required'], post: ['format'], title: ['required'] },
};
const flatten = (table) => Object.entries(table).flatMap(([f, codes]) => codes.map((c) => `${f} ${c}`)).sort();
await section('the vectors cover every field, code and mode, and nothing else', () => {
  const seen = { read: new Set(), archive: new Set(), desk: new Set(), submit: new Set() };
  const outcomes = { read: new Set(), archive: new Set(), desk: new Set(), submit: new Set() };
  for (const v of POST_VECTORS.vectors) {
    for (const mode of MODES) {
      const e = v.expect[mode];
      outcomes[mode].add(`ok ${e.ok}`).add(`external ${e.external}`);
      e.problems.forEach((p) => seen[mode].add(`${p.field.replace(/\[\d+\]/g, '[]')} ${p.code}`));
    }
  }
  const strictSeen = new Set([...seen.archive, ...seen.desk, ...seen.submit]);
  eq([...strictSeen].sort(), flatten(COVERAGE.strict), 'strict modes: every field and code pair the contract names appears');
  eq([...seen.read].sort(), flatten(COVERAGE.read), 'read mode: only the reasons today\'s feed dropped a post');
  const codes = new Set([...strictSeen].map((k) => k.split(' ')[1]));
  eq([...codes].sort(), ['calendar', 'chars', 'duplicate', 'format', 'host', 'id-date', 'required', 'scheme', 'token', 'too-long', 'too-many', 'window'],
    'all twelve codes of section 3.2 appear');
  const onlyIn = (code) => MODES.filter((m) => [...seen[m]].some((k) => k.endsWith(` ${code}`)));
  eq(onlyIn('id-date'), ['desk', 'submit'], 'id-date is desk and submit only');
  eq(onlyIn('window'), ['submit'], 'window is submit only');
  eq(onlyIn('host'), ['submit'], 'host is submit only');
  for (const mode of MODES) {
    eq([...outcomes[mode]].sort(), ['external false', 'external true', 'ok false', 'ok true'], `${mode}: vectors that pass, fail, and set external`);
  }
});

await section('the vectors hold every host, scheme and path section 3.2 names, each refused', () => {
  const urlVectors = POST_VECTORS.vectors.filter((v) => v.raw && Array.isArray(v.raw.links) && v.raw.links.length === 1
    && v.raw.links[0] && typeof v.raw.links[0].url === 'string');
  const codes = (url) => urlVectors.filter((v) => v.raw.links[0].url === url)
    .map((v) => v.expect.archive.problems.filter((p) => p.field === 'links[0].url').map((p) => p.code));
  const named = ['a.1', '999.1.1.1', '1.2.3.4', 'a_b.neorgon.com', 'neorgon.com.', 'a..b.neorgon.com', '%6eeorgon.com',
    '-a.neorgon.com', 'xn--bcher-kva.neorgon.com', 'xn--a.neorgon.com', 'a.0x1', 'a.b2'];
  for (const host of named) eq(codes('https://' + host + '/'), [['format']], `the host ${host}: one vector, refused as format`);
  for (const scheme of ['HTTPS://', 'Https://']) eq(codes(scheme + 'dispatch.neorgon.com/'), [['scheme']], `the scheme ${scheme}: one vector, refused as scheme`);
  eq(codes('https://github.com/energon-a-secas/../x'), [['format']], 'the path /energon-a-secas/../x: one vector, refused as format');
});

await section('the modes nest: submit within desk within archive within read', () => {
  const pairs = (e) => e.problems.map((p) => `${p.field} ${p.code}`);
  for (const v of POST_VECTORS.vectors) {
    const e = v.expect;
    eq([e.submit.ok && !e.desk.ok, e.desk.ok && !e.archive.ok, e.archive.ok && !e.read.ok], [false, false, false],
      `${v.name}: no mode accepts what a looser mode rejects`);
    eq([pairs(e.archive).every((p) => pairs(e.desk).includes(p)), pairs(e.desk).every((p) => pairs(e.submit).includes(p))], [true, true],
      `${v.name}: each stricter mode keeps every problem of the looser one`);
    const okPosts = STRICT.filter((m) => e[m].ok).map((m) => JSON.stringify(e[m].post));
    eq(new Set(okPosts).size <= 1, true, `${v.name}: the strict modes normalize alike`);
    if (e.archive.ok) {
      eq(e.read.post.links.map((l) => l.url), e.archive.post.links.map((l) => l.url), `${v.name}: the feed shows every link the archive accepts`);
    }
    eq(new Set(STRICT.map((m) => e[m].external)).size, 1, `${v.name}: the strict modes agree on external`);
  }
});

// ── The canonical hash ──────────────────────────────────────────────────────
for (const [name, mod] of ENFORCERS) {
  await section(`${name} answers every hash vector`, async () => {
    for (const h of HASH_VECTORS.vectors) {
      if (h.error) {
        eq(threw(() => mod.canonicalJson(h.value)), true, `${name}: canonicalJson refuses ${h.name}`);
        eq(await rejected(async () => mod.contentHash(h.value)), true, `${name}: contentHash refuses ${h.name}`);
        continue;
      }
      eq(sha256(h.canonical), h.sha256, `the vector file's own sha256 for ${h.name} is the digest of its canonical text`);
      // A throw is recorded as the answer, so it fails this vector and no other.
      const settle = async (fn) => {
        try { return await fn(); } catch (err) { return `threw ${err.name}: ${err.message}`; }
      };
      eq(await settle(() => mod.canonicalJson(h.value)), h.canonical, `${name}: canonicalJson of ${h.name}`);
      eq(await settle(() => mod.contentHash(h.value)), h.sha256, `${name}: contentHash of ${h.name}`);
    }
    eq(HASH_VECTORS.vectors.filter((h) => h.error).length >= 4, true, 'the hash vectors include refusals');
  });
}

// ── The published archive ───────────────────────────────────────────────────
for (const [name, mod] of ENFORCERS) {
  await section(`${name} accepts every post in data/posts.json in archive, desk and read mode, unchanged`, async () => {
    for (const p of ARCHIVE.posts) {
      for (const mode of ['archive', 'desk', 'read']) {
        eq(shape(mod.validatePost(p, { mode })), { ok: true, problems: [], external: false, post: p }, `${name}: ${p.id} [${mode}]`);
      }
      eq(await mod.contentHash(p), sha256(mod.canonicalJson(p)), `${name}: ${p.id} hashes its canonical text`);
    }
  });
}

// ── Read mode is the feed's old normalizePost ───────────────────────────────
// Verbatim copy of normalizePost and its constants from js/data.js at a7d51a8,
// the version read mode replaced. Do not edit: it is the reference.
const LEGACY_KINDS = ['launch', 'feature', 'fix', 'note'];
const LEGACY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_ID_RE = /^[a-z0-9-]+$/;
function legacyNormalizePost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  const kind = LEGACY_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!LEGACY_ID_RE.test(id) || !title || !LEGACY_DATE_RE.test(date) || !kind) return null;

  const body = Array.isArray(raw.body)
    ? raw.body.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : [];
  const links = Array.isArray(raw.links)
    ? raw.links.filter((l) => l && typeof l.label === 'string' && typeof l.url === 'string'
        && /^https?:\/\//.test(l.url))
    : [];
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];

  return {
    id,
    date,
    kind,
    site: typeof raw.site === 'string' && raw.site.trim() ? raw.site.trim() : null,
    title,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    body,
    links,
    tags,
  };
}

// Seeded, so a failure reproduces. mulberry32.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MISSING = Symbol('missing');
const LINK_POOL = [
  { label: 'Antenne', url: 'https://dispatch.neorgon.com/' }, { label: '', url: 'http://x.y' }, { label: 3, url: 'https://a.b' },
  { url: 'https://a.b/', label: 'keys reordered' }, { label: 'ftp', url: 'ftp://neorgon.com/' }, { label: 'upper', url: 'HTTPS://neorgon.com/' },
  { label: 'extra', url: 'https://neorgon.com/', rel: 'me' }, { label: ' padded ', url: 'https://example.com/' }, { label: 'no url' },
  { url: 'https://neorgon.com/' }, 'https://neorgon.com/', null, 0, ['label', 'https://neorgon.com/'], { label: 'bare', url: 'https://' },
  { label: 'number', url: 5 }, { label: 'space', url: 'https://neorgon.com/a b' }, { label: 'dotdot', url: 'https://github.com/energon-a-secas/../x' },
];
const POOLS = {
  id: [MISSING, null, 42, '', ' ', '2026-09-10-a', ' 2026-09-10-a ', '2026-09-10-A', 'a b', '\u00a02026-09-10-a\ufeff', '2026-09-10-a\u0085', 'x'.repeat(90), '2026-09-10-a\n'],
  date: [MISSING, null, 20260910, '', '2026-09-10', ' 2026-09-10\n', '2026-9-10', '2026-02-30', '\uff12026-09-10', '2026-09-10\u0085'],
  kind: [MISSING, null, 3, '', 'fix', 'note', 'launch', 'feature', ' fix', 'FIX', 'release', ['fix']],
  site: [MISSING, null, 7, '', '   ', 'x-site', ' x-site ', 'X', '\u2028x\u2028', 'x\u0085'],
  title: [MISSING, null, 5, '', '   ', 'T', '  T  ', '\u00a0T\u3000', 'T\u0085', 'x'.repeat(200), '<b>&"quoted"</b>'],
  summary: [MISSING, null, {}, '', ' S ', 'S', '\u2029S', 'x'.repeat(400)],
  body: [MISSING, null, 'str', {}, [], ['a'], [' a ', '', '  ', 3, null, ['x'], {}, 'b', '\u00a0', '\u0085'], ['x'.repeat(1000)], ['one\n\ntwo']],
  tags: [MISSING, null, 'fleet', [], ['a', ' b ', '', 3, 'a', null, '\ufeff', '\u0085']],
  extra: [MISSING, 'x', { nested: true }],
};
// Usable values for the four fields that decide whether a post is kept, drawn
// most of the time so most posts survive and their links, body and tags get
// filtered and rendered.
const USABLE = {
  id: ['2026-09-10-a', ' 2026-09-10-b ', '\u00a02026-09-10-c\ufeff'],
  date: ['2026-09-10', ' 2026-09-10\n', '2026-02-30'],
  kind: ['launch', 'feature', 'fix', 'note'],
  title: ['T', '  T  ', '<b>&"quoted"</b>'],
};
function fuzzCorpus(count, seed) {
  const r = random(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (r() < 0.04) {
      out.push(pick([null, [], 'story', 0, true, 1.5, [{ id: '2026-09-10-a' }]]));
      continue;
    }
    const post = {};
    for (const [key, pool] of Object.entries(POOLS)) {
      const value = USABLE[key] && r() < 0.8 ? pick(USABLE[key]) : pick(pool);
      if (value !== MISSING) post[key] = structuredClone(value);
    }
    const links = pick([MISSING, null, 'str', {}, 'list']);
    if (links === 'list') {
      post.links = Array.from({ length: Math.floor(r() * 9) }, () => structuredClone(pick(LINK_POOL)));
    } else if (links !== MISSING) post.links = links;
    out.push(post);
  }
  return out;
}

await section('read mode gives the old normalizePost answer for every input, and the feed renders the same card', () => {
  const inputs = [
    ...POST_VECTORS.vectors.map((v) => v.raw),
    ...ARCHIVE.posts,
    ...fuzzCorpus(4000, 20260915),
  ];
  let exact = 0;
  let kept = 0;
  let linkKeysOnlyDiffer = 0;
  for (const raw of inputs) {
    const legacy = legacyNormalizePost(raw);
    const got = schema.validatePost(raw, { mode: 'read' });
    const label = JSON.stringify(raw) ?? String(raw);
    eq(got.ok, legacy !== null, `kept or dropped alike: ${label}`);
    // The one intended difference: a link comes back as { label, url } (contract
    // section 3.2), where the old code handed back the raw link object with
    // whatever else it carried. Nothing reads those extra keys.
    const projected = legacy && { ...legacy, links: legacy.links.map((l) => ({ label: l.label, url: l.url })) };
    eq(got.post, projected, `the same post, link objects as { label, url }: ${label}`);
    const plainLinks = !legacy || legacy.links.every((l) => JSON.stringify(Object.keys(l)) === '["label","url"]');
    if (plainLinks) {
      if (eq(got.post, legacy, `byte for byte when every link is exactly { label, url }: ${label}`)) exact += 1;
    } else linkKeysOnlyDiffer += 1;
    eq(JSON.stringify(data.normalizePost(raw)), JSON.stringify(got.post), `js/data.js normalizePost is read mode: ${label}`);
    if (legacy) {
      kept += 1;
      for (const opts of [{}, { open: true }, { hero: true, isNew: true }]) {
        eq(renderCard(got.post, opts), renderCard(legacy, opts), `renderCard(${JSON.stringify(opts)}) is unchanged: ${label}`);
      }
    }
  }
  console.log(`     ${inputs.length} inputs, ${kept} kept; ${exact} identical byte for byte, ${linkKeysOnlyDiffer} differ only in link objects' extra keys or key order`);
});

// ── A url the rules accept opens where the rules read it ────────────────────
// The pinned grammar of section 3.2 decides validity with no platform parser.
// This holds it to the browser's parser from outside: a url the rules accept
// must parse with new URL(), carry no credentials or port, keep its lowercased
// host as the hostname and its path as the pathname, and get the allowlist
// verdict of where the browser opens it.
//
// No exception, for any enforcer. Round 3 found two host shapes the grammar
// then accepted and new URL() refuses (a.0x1, a hex number to the URL Standard,
// and xn--a.neorgon.com, not Punycode); section 3.2 now refuses both, so each
// must be refused below and every accepted url must agree.
const NUMERIC_HOSTS = ['a.1', '999.1.1.1', '1.2.3.4', '127.0.0.1', '0.0.0.0', '1.2.3', 'neorgon.com.1', 'a.b.c.123', '0x7f.0.0.1', 'a.07'];
const REFUSED_HOSTS = [...NUMERIC_HOSTS, 'a.0x1', '1.0x1', 'neorgon.0X', 'neorgon.0x7f', 'a.b2', 'a.1a', 'neorgon.c', 'neorgon.co-m',
  'xn--a.neorgon.com', 'xn--bcher-kva.neorgon.com', 'XN--BCHER-KVA.neorgon.com', 'dispatch.Xn--bcher-kva.neorgon.com', 'neorgon.xn--p1ai'];
function urlCorpus(count, seed) {
  const r = random(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  const schemes = ['https://', 'https://', 'https://', 'HTTPS://', 'Https://', ' https://', 'http://', 'https:/', '//'];
  const hosts = [...NUMERIC_HOSTS, 'github.com', 'GitHub.com', 'neorgon.com', 'dispatch.neorgon.com', 'example.com', 'neorgon.com.example.com',
    'gist.github.com', 'evilneorgon.com', '123.neorgon.com', 'a.1a', 'xn--bcher-kva.neorgon.com', 'XN--BCHER-KVA.neorgon.com',
    'x'.repeat(63) + '.neorgon.com', 'a.0x1', '1.0x1', 'neorgon.0X', 'xn--a.neorgon.com', 'xn--ab-cd.neorgon.com', '-a.neorgon.com',
    'a-.neorgon.com', 'a_b.neorgon.com', 'neorgon.com.', 'a..b.neorgon.com', '%6eeorgon.com', 'x'.repeat(64) + '.neorgon.com',
    'git@hub.com', 'github.com:443', 'neo' + TAB + 'rgon.com', '[::1]', '', 'localhost'];
  const starts = ['', '/', '/energon-a-secas/', '/energon-a-secas', BS + 'energon-a-secas' + BS, '/x/../energon-a-secas/', '//energon-a-secas/', '?', '#'];
  const pieces = ['/', BS, 'energon-a-secas', 'energon-a-secas/', 'x', '.', '..', '...', '%2e', '%2E', '.%2e', '%2e.', '%2E%2e', '%252e',
    TAB, LF, ' ', 'a b', '%', '%2f', '%4', '?', '#', '?next=/energon-a-secas/', '#/energon-a-secas/', 'dispatch-site',
    'caf' + String.fromCharCode(0xe9), "'", '&', '[1]', '|', '"', '<', '@', ':', '!$()*+,;=', '~_-'];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let path = pick(starts);
    for (let n = Math.floor(r() * 5); n > 0; n -= 1) path += pick(pieces);
    out.push(pick(schemes) + pick(hosts) + path + pick(['', '', '', ' ', TAB, LF + ' ']));
  }
  return out;
}
/** The host and path as the grammar splits them, read off independently of judgeUrl, and whether new URL() agrees. */
function browserReading(url) {
  const afterScheme = url.slice('https://'.length);
  const host = afterScheme.split(/[/?#]/)[0];
  const path = afterScheme.slice(host.length).split(/[?#]/)[0];
  let opened = null;
  try { opened = new URL(url); } catch { return { host, opened, agrees: false }; }
  const agrees = opened.protocol === 'https:' && opened.username === '' && opened.password === '' && opened.port === ''
    && opened.hostname === host.toLowerCase() && opened.pathname === (path || '/');
  return { host, opened, agrees };
}
const VECTOR_URLS = POST_VECTORS.vectors.flatMap((v) => (v.raw && Array.isArray(v.raw.links) ? v.raw.links : []))
  .map((l) => l && l.url).filter((u) => typeof u === 'string');
for (const [name, mod] of ENFORCERS) {
  await section(`${name}: every url it accepts parses in new URL() as it reads it, with that allowlist verdict`, () => {
    const judge = (url) => {
      const result = mod.validatePost({ ...POST_VECTORS.vectors[0].raw, links: [{ label: 'Link', url }] }, { mode: 'archive' });
      const codes = result.problems.filter((p) => p.field === 'links[0].url').map((p) => p.code);
      return { result, codes, refused: codes.includes('format') || codes.includes('scheme') };
    };
    for (const host of REFUSED_HOSTS) {
      for (const rest of ['/', '', '/energon-a-secas/x', '?q=1']) {
        eq(judge('https://' + host + rest).codes, ['format'], `${name}: https://${host}${rest} is refused: an xn-- label, or a last label that is not 2 to 63 letters`);
      }
    }
    const tally = { accepted: 0, inside: 0, outside: 0, refused: 0, refusedButParses: 0 };
    for (const url of [...VECTOR_URLS, ...urlCorpus(8000, 915)]) {
      const { result, refused } = judge(url);
      if (refused) {
        tally.refused += 1;
        if (URL.canParse(url)) tally.refusedButParses += 1;
        continue;
      }
      tally.accepted += 1;
      const seen = browserReading(url);
      const opened = seen.opened ? `opens ${seen.opened.hostname}${seen.opened.pathname}` : 'throws';
      if (!eq(seen.agrees, true, `${name}: new URL() reads ${JSON.stringify(url)} as the rules do, and it ${opened}`)) continue;
      const inside = mod.HOSTS.some((h) => (seen.opened.hostname === h.host || (h.subdomains && seen.opened.hostname.endsWith('.' + h.host)))
        && seen.opened.pathname.startsWith(h.pathPrefix));
      eq(result.external, !inside, `${name}: external for ${JSON.stringify(url)}, which opens ${seen.opened.hostname}${seen.opened.pathname}`);
      tally[inside ? 'inside' : 'outside'] += 1;
    }
    eq([tally.inside > 0, tally.outside > 0, tally.refusedButParses > 0], [true, true, true],
      `${name}: urls inside, outside, and refused although new URL() would parse them ${JSON.stringify(tally)}`);
    console.log(`     ${tally.accepted} accepted, every one read alike by new URL(): ${tally.inside} inside, ${tally.outside} outside;`
      + ` ${tally.refused} refused, ${tally.refusedButParses} of them parseable by new URL()`);
  });
}

await section('js/data.js keeps every export the feed and the desk import', () => {
  eq(Object.keys(data).sort(), ['KINDS', 'KIND_LABELS', 'loadArchive', 'normalizeDoc', 'normalizePost'], 'the export names');
  eq(data.KINDS, schema.KINDS, 'KINDS is the schema\'s list');
  eq(data.KIND_LABELS, { launch: 'Launch', feature: 'Feature', fix: 'Fix', note: 'Note' }, 'KIND_LABELS');
  const shuffled = [...ARCHIVE.posts].reverse();
  eq(data.normalizeDoc({ posts: [null, ...shuffled, { id: 'no-title' }] }), ARCHIVE.posts, 'normalizeDoc drops junk and sorts newest first');
  eq(data.normalizeDoc(null), [], 'normalizeDoc of nothing is an empty feed');
});

await section('js/schema.js stays pure and small', () => {
  const source = readFileSync(new URL('../js/schema.js', import.meta.url), 'utf8');
  // Globals as code uses them (window.x, document.querySelector), so a name
  // such as CAPS.windowPastDays is not mistaken for the DOM.
  const impure = /\b(?:document|window|localStorage|sessionStorage|navigator)\s*[.[]|\bnew Date\(|\bDate\.now\(/g;
  eq(source.match(impure) || [], [], 'no DOM, no storage, no clock');
  eq(['window.x', 'document.title', 'new Date()', 'Date.now()'].map((s) => s.match(impure) !== null), [true, true, true, true],
    'and that pattern does catch them');
  eq(source.split('\n').length < 500, true, 'under 500 lines');
  eq(Object.keys(schema).sort(), ['CAPS', 'HOSTS', 'KINDS', 'canonicalJson', 'contentHash', 'validatePost'], 'exactly the contract\'s exports');
});

console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
