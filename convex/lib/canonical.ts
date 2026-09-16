// The canonical hash of docs/plans/2026-09-15-antenne-desk.md section 3.3, the
// server's copy of canonicalJson and contentHash from js/schema.js, spelled the
// same way step for step. tests/hash-vectors.json pins all three enforcers to
// the same hex, and tests/post-mirror.test.mjs runs this file over it.
//
// approvedHash = contentHash(post) is what publishing compares against the
// story it finds in a commit, so a difference of one byte here from Python's
// json.dumps(post, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
// would read every approved story as a conflict.
//
// SHA-256 and the UTF-8 encoding are computed here in plain TypeScript, with
// no import, no Web Crypto and no TextEncoder: Web Crypto inside Convex queries
// and mutations is unverified (section 3.3), and the approval hash must not
// depend on it. tests/convex-contract.test.mjs holds this file to node:crypto
// at every padding boundary, with those globals taken away.

/** True when s holds a UTF-16 surrogate with no partner, which has no UTF-8 form. */
export function loneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Python sorts keys by code point; JavaScript's default sort compares UTF-16 code units. */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function canonicalString(s: string): string {
  if (loneSurrogate(s)) throw new TypeError("canonicalJson: a lone surrogate has no UTF-8 form");
  return JSON.stringify(s);
}

/**
 * Keys sorted by code point, recursively, no whitespace: byte for byte what
 * Python's json.dumps(value, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False) writes. Numbers must be safe integers.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJson: numbers must be safe integers");
    return String(value);
  }
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort(compareCodePoints)
      .map((k) => canonicalString(k) + ":" + canonicalJson(record[k])).join(",") + "}";
  }
  throw new TypeError("canonicalJson: cannot serialize " + typeof value);
}

// ── SHA-256 (FIPS 180-4) ──────────────────────────────────────────────────────

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0: readonly number[] = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** The UTF-8 bytes of text. A lone surrogate throws, as canonicalJson does, rather than becoming U+FFFD. */
function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const low = text.charCodeAt(i + 1);
      if (cp > 0xdbff || !(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError("sha256Hex: a lone surrogate has no UTF-8 form");
      cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
      i += 1;
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

function rotr(x: number, r: number): number {
  return (x >>> r) | (x << (32 - r));
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of text. */
export function sha256Hex(text: string): string {
  const bytes = utf8(text);
  // The message, one 0x80 byte, zeros, and the length in bits as a 64-bit
  // big-endian integer, filling a whole number of 64-byte blocks.
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(size);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  const bits = bytes.length * 8;
  view.setUint32(size - 8, Math.floor(bits / 0x100000000));
  view.setUint32(size - 4, bits >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15];
      const y = w[t - 2];
      // Uint32Array storage reduces the sum mod 2^32.
      w[t] = w[t - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[t - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t += 1) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => {
      h[i] = (h[i] + v) | 0;
    });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of canonicalJson(post). Async, as js/schema.js's is. */
export async function contentHash(post: unknown): Promise<string> {
  return sha256Hex(canonicalJson(post));
}
