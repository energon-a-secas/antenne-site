// Copied verbatim from projects/vitrina-site/tests/support/fakedb.mjs; the write counter at the end is this site's addition.
// An in-memory Convex database for the backend tests. Plain node, no install.
//
// The cores in convex/lib take a db and never import Convex, so this is all a
// test needs to run them. It is only worth trusting if it refuses what a real
// deployment refuses, so it is stricter than it has to be in the places a core
// could quietly go wrong:
//
// - Tables, fields and indexes come from convex/schema.ts itself, parsed at
//   load. Reading an index the schema does not declare throws, and so does a
//   write whose fields or value types do not match, as a deployment would.
// - withIndex ranges follow Convex's rules: eq on the index fields in order,
//   then at most one lower and one upper bound on the next field. Results are
//   ordered by the index fields, then _creationTime.
// - There is no filter(). A core that cannot say what it reads through an
//   index does not pass here.
// - Every query that runs is logged as { table, index }, so a test can assert
//   what was never read (byHandle must not touch entries before it knows the
//   answer is a shelf).
//
// Not modelled: transactions and OCC, the scheduler, and size limits.

import { readFileSync } from 'node:fs';

const SCHEMA = new URL('../../convex/schema.ts', import.meta.url);

// ── The schema ────────────────────────────────────────────────────────────────

// Splits on commas that are not inside brackets.
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// The text between the bracket at `open` and the one that closes it.
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('fakedb: unbalanced brackets in convex/schema.ts');
}

// Only the validators the schema uses. Anything else throws, so a schema edit
// that outgrows this parser is noticed instead of passing every value.
function parseValidator(expr) {
  const text = expr.trim();
  if (text === 'v.string()') return (x) => typeof x === 'string';
  if (text === 'v.number()') return (x) => typeof x === 'number';
  if (text === 'v.boolean()') return (x) => typeof x === 'boolean';
  if (text === 'v.null()') return (x) => x === null;
  if (text === 'v.any()') return (x) => x !== undefined;
  let m = text.match(/^v\.union\(([\s\S]*)\)$/);
  if (m) {
    const members = splitTop(m[1]).map(parseValidator);
    return (x) => members.some((check) => check(x));
  }
  m = text.match(/^v\.optional\(([\s\S]*)\)$/);
  if (m) {
    const inner = parseValidator(m[1]);
    const check = (x) => x === undefined || inner(x);
    check.optional = true;
    return check;
  }
  throw new Error(`fakedb: no parser for the validator ${text}; teach parseValidator`);
}

export function parseSchema(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const tables = {};
  const starts = [...text.matchAll(/(\w+):\s*defineTable\(/g)];
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const chunk = text.slice(match.index + match[0].length, end);
    const fields = {};
    for (const part of splitTop(balanced(chunk, chunk.indexOf('{')))) {
      const colon = part.indexOf(':');
      fields[part.slice(0, colon).trim()] = parseValidator(part.slice(colon + 1));
    }
    const indexes = {};
    for (const im of chunk.matchAll(/\.index\(\s*"(\w+)"\s*,\s*\[([^\]]*)\]\s*\)/g)) {
      indexes[im[1]] = im[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    tables[match[1]] = { fields, indexes };
  });
  if (!Object.keys(tables).length) throw new Error('fakedb: found no tables in convex/schema.ts');
  return tables;
}

// ── Values ────────────────────────────────────────────────────────────────────

// Convex's cross-type order: undefined < null < number < boolean < string < array < object.
function rank(x) {
  if (x === undefined) return 0;
  if (x === null) return 1;
  if (typeof x === 'bigint') return 2;
  if (typeof x === 'number') return 3;
  if (typeof x === 'boolean') return 4;
  if (typeof x === 'string') return 5;
  if (Array.isArray(x)) return 7;
  return 8;
}

export function compareValues(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a === b) return 0;
  if (ra === 7 || ra === 8) {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// What a document field may hold: JSON-shaped values, no undefined inside, no
// "$" field names. A core that stores a Date or a class instance fails here.
function assertConvexValue(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item === undefined) throw new Error(`fakedb: ${path}[${i}] is undefined`);
      assertConvexValue(item, `${path}[${i}]`);
    });
    return;
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.startsWith('$')) throw new Error(`fakedb: ${path} has the field name ${JSON.stringify(key)}`);
      if (item !== undefined) assertConvexValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`fakedb: ${path} is not a Convex value (${typeof value})`);
}

// ── The database ──────────────────────────────────────────────────────────────

export function createFakeDb({ schemaSource } = {}) {
  const schema = parseSchema(schemaSource ?? readFileSync(SCHEMA, 'utf8'));
  const store = new Map(Object.keys(schema).map((table) => [table, new Map()]));
  const log = [];
  let seq = 0;
  let clock = 1_700_000_000_000;

  function tableDef(table) {
    const def = schema[table];
    if (!def) throw new Error(`fakedb: convex/schema.ts has no table ${table}`);
    return def;
  }

  function tableOf(id) {
    const table = typeof id === 'string' ? id.slice(0, id.indexOf(':')) : '';
    if (!schema[table]) throw new Error(`fakedb: ${JSON.stringify(id)} is not a document id`);
    return table;
  }

  function validate(table, doc) {
    const { fields } = tableDef(table);
    for (const key of Object.keys(doc)) {
      if (key === '_id' || key === '_creationTime') continue;
      if (!fields[key]) throw new Error(`fakedb: ${table} has no field ${key} in convex/schema.ts`);
    }
    for (const [key, check] of Object.entries(fields)) {
      if (!check(doc[key])) {
        throw new Error(`fakedb: ${table}.${key} does not match convex/schema.ts: ${JSON.stringify(doc[key])}`);
      }
      if (doc[key] !== undefined) assertConvexValue(doc[key], `${table}.${key}`);
    }
  }

  // Both call shapes Convex 1.45 accepts: (table, id, ...) and the older (id, ...).
  function split(args, arity) {
    if (args.length === arity + 1) {
      const [table, id, ...rest] = args;
      if (tableOf(id) !== table) throw new Error(`fakedb: id ${id} does not belong to ${table}`);
      return [table, id, ...rest];
    }
    return [tableOf(args[0]), ...args];
  }

  function rangeBuilder(fields) {
    const state = { eqs: [], lower: null, upper: null };
    const next = () => fields[state.eqs.length];
    const builder = {
      eq(field, value) {
        if (state.lower || state.upper) throw new Error('fakedb: eq after a range bound');
        if (field !== next()) throw new Error(`fakedb: this index takes ${next()} next, not ${field}`);
        state.eqs.push(value);
        return builder;
      },
      gt: (field, value) => bound('lower', 'gt', field, value),
      gte: (field, value) => bound('lower', 'gte', field, value),
      lt: (field, value) => bound('upper', 'lt', field, value),
      lte: (field, value) => bound('upper', 'lte', field, value),
    };
    function bound(side, op, field, value) {
      if (field !== next()) throw new Error(`fakedb: a range bound goes on ${next()}, not ${field}`);
      if (state[side]) throw new Error(`fakedb: two ${side} bounds`);
      if (side === 'lower' && state.upper) throw new Error('fakedb: a lower bound must come before the upper bound');
      state[side] = { op, value };
      return builder;
    }
    return { builder, state };
  }

  function inRange(doc, fields, state) {
    for (let i = 0; i < state.eqs.length; i++) {
      if (compareValues(doc[fields[i]], state.eqs[i]) !== 0) return false;
    }
    const field = fields[state.eqs.length];
    if (state.lower) {
      const c = compareValues(doc[field], state.lower.value);
      if (state.lower.op === 'gt' ? c <= 0 : c < 0) return false;
    }
    if (state.upper) {
      const c = compareValues(doc[field], state.upper.value);
      if (state.upper.op === 'lt' ? c >= 0 : c > 0) return false;
    }
    return true;
  }

  function query(table) {
    tableDef(table);
    let index = null;
    let fields = [];
    let range = { eqs: [], lower: null, upper: null };
    let order = 'asc';

    function run(limit) {
      log.push({ table, index: index ?? 'by_creation_time' });
      const rows = [...store.get(table).values()].filter((doc) => inRange(doc, fields, range));
      rows.sort((a, b) => {
        for (const f of fields) {
          const c = compareValues(a[f], b[f]);
          if (c !== 0) return c;
        }
        return a._creationTime - b._creationTime;
      });
      if (order === 'desc') rows.reverse();
      return rows.slice(0, limit).map((doc) => structuredClone(doc));
    }

    const q = {
      withIndex(name, fn) {
        if (index) throw new Error('fakedb: withIndex called twice');
        const def = tableDef(table).indexes[name];
        if (!def) throw new Error(`fakedb: ${table} has no index ${name} in convex/schema.ts`);
        index = name;
        fields = def;
        const built = rangeBuilder(def);
        if (fn && fn(built.builder) !== built.builder) throw new Error('fakedb: the range function must return the builder');
        range = built.state;
        return q;
      },
      order(direction) {
        if (direction !== 'asc' && direction !== 'desc') throw new Error(`fakedb: order ${direction}`);
        order = direction;
        return q;
      },
      filter() {
        throw new Error('fakedb: filter() is not supported; read through an index');
      },
      async first() {
        return run(1)[0] ?? null;
      },
      async unique() {
        const rows = run(2);
        if (rows.length > 1) throw new Error(`fakedb: unique() found more than one ${table} row`);
        return rows[0] ?? null;
      },
      async take(n) {
        if (!Number.isInteger(n) || n < 0) throw new Error(`fakedb: take(${n})`);
        return run(n);
      },
      async collect() {
        return run(Infinity);
      },
    };
    return q;
  }

  const db = {
    query,

    async get(...args) {
      const [table, id] = split(args, 1);
      const doc = store.get(table).get(id);
      return doc ? structuredClone(doc) : null;
    },

    async insert(table, value) {
      tableDef(table);
      if (value === null || typeof value !== 'object') throw new Error(`fakedb: insert into ${table} needs an object`);
      const doc = {};
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith('_')) throw new Error(`fakedb: ${key} is a system field`);
        if (item !== undefined) doc[key] = structuredClone(item);
      }
      validate(table, doc);
      seq += 1;
      clock += 1;
      const _id = `${table}:${seq}`;
      store.get(table).set(_id, { ...doc, _id, _creationTime: clock });
      return _id;
    },

    async patch(...args) {
      const [table, id, value] = split(args, 2);
      const current = store.get(table).get(id);
      if (!current) throw new Error(`fakedb: patch on a missing document ${id}`);
      const next = { ...current };
      for (const [key, item] of Object.entries(value)) {
        if (key === '_id' || key === '_creationTime') {
          if (item !== current[key]) throw new Error(`fakedb: ${key} cannot be patched`);
          continue;
        }
        if (item === undefined) delete next[key];
        else next[key] = structuredClone(item);
      }
      validate(table, next);
      store.get(table).set(id, next);
    },

    async delete(...args) {
      const [table, id] = split(args, 1);
      if (!store.get(table).has(id)) throw new Error(`fakedb: delete on a missing document ${id}`);
      store.get(table).delete(id);
    },

    // ── For tests only ──────────────────────────────────────────────────────
    log,
    clearLog() {
      log.length = 0;
    },
    /** True when any query on this table ran since the last clearLog(). */
    queried(table) {
      return log.some((entry) => entry.table === table);
    },
    rows(table) {
      tableDef(table);
      return [...store.get(table).values()]
        .sort((a, b) => a._creationTime - b._creationTime)
        .map((doc) => structuredClone(doc));
    },
    count(table) {
      tableDef(table);
      return store.get(table).size;
    },
    schema,
  };
  return db;
}

// ── This site's addition: a write counter ─────────────────────────────────────
// Not in vitrina's copy. A Convex mutation that returns a failure still commits
// every write it made before returning, so the desk contract
// (docs/plans/2026-09-15-antenne-desk.md section 4.2) has each core check
// everything first. countWrites wraps a fake db so a test can prove that a
// refused call wrote nothing. A write is counted before it runs, so one that
// throws still counts.

export function countWrites(db) {
  let writes = 0;
  const counted = { ...db };
  for (const name of ['insert', 'patch', 'delete']) {
    counted[name] = async (...args) => {
      writes += 1;
      return db[name](...args);
    };
  }
  /** Writes since the wrapper was made or last reset. */
  counted.writes = () => writes;
  counted.resetWrites = () => {
    writes = 0;
  };
  return counted;
}
