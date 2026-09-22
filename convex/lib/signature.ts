// Shape from projects/vitrina-site/convex/lib/webhookVerify.ts: Web Crypto HMAC and nothing else, every byte array typed Uint8Array<ArrayBuffer>.
import { SCOPE_NAMES } from "./access.ts";
import type { Scope } from "./access.ts";
import { SIGNATURE_WINDOW_MS } from "./limits.ts";

// Signed machine requests (docs/plans/2026-09-15-antenne-desk.md section 5).
//
//   signed content  "<keyId>.<timestamp>.<path>.<raw body>"
//   key             base64 decode of the key's secret, at least 32 bytes
//   signature       base64 HMAC-SHA256, in X-Antenne-Signature
//
// Keys come from the Convex env MACHINE_KEYS, comma separated
// "keyId:scope+scope:base64secret". A malformed entry is skipped, and a key id
// that appears twice is dropped entirely, since nothing says which secret is
// meant. tests/sign-vectors.json pins this against scripts/antenne_sign.py.
//
// crypto.subtle.verify does the comparison, so it is constant time; comparing
// base64 strings with === would not be. This file runs only inside HTTP
// actions, where Web Crypto is available; queries and mutations hash with
// convex/lib/canonical.ts instead. The clock is passed in, so a test can hold
// it still.
//
// Every byte array here is typed Uint8Array<ArrayBuffer>. Since TypeScript 5.7
// a bare Uint8Array means Uint8Array<ArrayBufferLike>, which Web Crypto's
// BufferSource refuses, and the Convex CLI fails a push on that error once
// typescript is installed. tests/convex-contract.test.mjs keeps the bare
// spelling out of convex/.

export const KEY_HEADER = "X-Antenne-Key";
export const TIMESTAMP_HEADER = "X-Antenne-Timestamp";
export const SIGNATURE_HEADER = "X-Antenne-Signature";

export const KEY_ID_RE = /^[a-z0-9-]{1,32}$/;
/** The shortest secret a key may hold, in decoded bytes. */
export const SECRET_MIN_BYTES = 32;
/** Unix seconds, as digits only. */
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
/** Standard base64 with its padding, the form openssl rand -base64 and Python's b64encode write. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Which paths each scope signs for. Section 5 names every machine route, so
 * the publish paths are here before publish-bridge adds their rows to the
 * route table in convex/lib/routes.ts, which refuses a row that disagrees.
 */
export const SCOPE_PATHS: Readonly<Record<Scope, readonly string[]>> = Object.freeze({
  submit: Object.freeze(["/submit"]),
  status: Object.freeze(["/status"]),
  publish: Object.freeze(["/publish/claim", "/publish/conflict", "/publish/pushed", "/publish/built", "/publish/release"]),
});

export type MachineKey = { keyId: string; scopes: Scope[]; secret: Uint8Array<ArrayBuffer> };
export type HeaderSource = { get(name: string): string | null };

/** The scope a machine route belongs to, or null for a path no scope signs for. */
export function scopeForPath(path: string): Scope | null {
  for (const scope of SCOPE_NAMES) if (SCOPE_PATHS[scope].includes(path)) return scope;
  return null;
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (text === "" || !BASE64_RE.test(text)) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The bytes standard padded base64 decodes to, counted from its length alone, or null for text that is not base64. */
function base64Length(text: string): number | null {
  if (text === "" || !BASE64_RE.test(text)) return null;
  return (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
}

type Entry = { keyId: string; scopes: Scope[]; secretText: string };

/** One MACHINE_KEYS entry checked, with its secret still base64: a key id, known scopes each once, a secret of SECRET_MIN_BYTES or more. */
function checkEntry(entry: string): Entry | null {
  const parts = entry.split(":");
  if (parts.length !== 3) return null;
  const [keyId, scopeText, secretText] = parts;
  if (!KEY_ID_RE.test(keyId)) return null;
  const scopes = scopeText.split("+");
  if (!scopes.every((s) => (SCOPE_NAMES as readonly string[]).includes(s)) || new Set(scopes).size !== scopes.length) return null;
  const bytes = base64Length(secretText);
  if (bytes === null || bytes < SECRET_MIN_BYTES) return null;
  return { keyId, scopes: scopes as Scope[], secretText };
}

/** Every well-formed entry by key id, in order, with a key id listed twice dropped both times. Nothing is decoded. */
function entriesOf(raw: string | null | undefined): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const twice = new Set<string>();
  if (typeof raw !== "string") return entries;
  for (const text of raw.split(",")) {
    const entry = checkEntry(text.trim());
    if (entry === null || twice.has(entry.keyId)) continue;
    if (entries.has(entry.keyId)) {
      entries.delete(entry.keyId);
      twice.add(entry.keyId);
      continue;
    }
    entries.set(entry.keyId, entry);
  }
  return entries;
}

/** Every well-formed key in MACHINE_KEYS, by key id. An unset or empty value gives none. */
export function parseMachineKeys(raw: string | null | undefined): Map<string, MachineKey> {
  const keys = new Map<string, MachineKey>();
  for (const [keyId, entry] of entriesOf(raw)) {
    const secret = base64ToBytes(entry.secretText);
    if (secret !== null) keys.set(keyId, { keyId, scopes: entry.scopes, secret });
  }
  return keys;
}

/**
 * The key ids parseMachineKeys would give, found without decoding a secret,
 * so a mutation can ask which keys are configured: /submit counts every
 * configured key's pending drafts (convex/lib/submitCore.ts).
 */
export function machineKeyIds(raw: string | null | undefined): string[] {
  return [...entriesOf(raw).keys()];
}

export function signingText(keyId: string, timestamp: string, path: string, rawBody: string): string {
  return `${keyId}.${timestamp}.${path}.${rawBody}`;
}

/** True when timestamp is Unix seconds at most SIGNATURE_WINDOW_MS from nowMs, either way. */
export function timestampFresh(timestamp: string, nowMs: number): boolean {
  if (!TIMESTAMP_RE.test(timestamp)) return false;
  return Math.abs(nowMs - Number(timestamp) * 1000) <= SIGNATURE_WINDOW_MS;
}

/** True when signature is the base64 HMAC-SHA256 of text under secret. Compared by crypto.subtle.verify. */
export async function verifySignature(secret: Uint8Array<ArrayBuffer>, text: string, signature: string): Promise<boolean> {
  const mac = base64ToBytes(signature);
  if (mac === null) return false;
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(text));
}

// An unknown key id is checked against this, so it costs the same HMAC as a
// known one and answers the same way. It verifies nothing: the result is
// discarded because the key is unknown.
const STAND_IN = new Uint8Array(SECRET_MIN_BYTES);

/**
 * The key that signed this request, or null. null alike for a missing header,
 * an unknown key, a bad signature and a stale or future timestamp, so the
 * route cannot say which.
 */
export async function verifyRequest(headers: HeaderSource, path: string, rawBody: string, keys: Map<string, MachineKey>, nowMs: number): Promise<MachineKey | null> {
  const keyId = headers.get(KEY_HEADER) ?? "";
  const timestamp = headers.get(TIMESTAMP_HEADER) ?? "";
  const signature = headers.get(SIGNATURE_HEADER) ?? "";
  const key = keys.get(keyId) ?? null;
  const fresh = timestampFresh(timestamp, nowMs);
  const valid = await verifySignature(key === null ? STAND_IN : key.secret, signingText(keyId, timestamp, path, rawBody), signature);
  return key !== null && fresh && valid ? key : null;
}
