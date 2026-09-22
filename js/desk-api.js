// ── The desk's Convex surface ────────────────────────────────
// Everything the desk knows about its backend, in one place: the deployment
// the page names, every function the browser may call (section 4.3 of
// docs/plans/2026-09-15-antenne-desk.md), the client loader, the signed-in
// request, and the plain sentence each refusal becomes. Pure apart from
// loadClient, which imports the Convex client on first use, so importing this
// file fetches nothing. tests/desk-api.test.mjs holds FN to what convex/*.ts
// exports.

// Copied from projects/vitrina-site/js/backend.js (CONVEX_URL_RE, convexUrlFrom, loadClient).
/** A Convex cloud deployment URL, and nothing else. */
export const CONVEX_URL_RE = /^https:\/\/[a-z-]+-\d+\.convex\.cloud$/;

/**
 * Every public function the desk calls, named exactly as convex/*.ts exports
 * it. The internal publish:*, links:* and submit:* functions are absent:
 * no browser can call them.
 */
export const FN = Object.freeze({
  desk: Object.freeze({ me: 'desk:me', queue: 'desk:queue' }),
  drafts: Object.freeze({
    submit: 'drafts:submit',
    edit: 'drafts:edit',
    approve: 'drafts:approve',
    approveMany: 'drafts:approveMany',
    withdraw: 'drafts:withdraw',
    reopen: 'drafts:reopen',
    take: 'drafts:take',
    overrideLinks: 'drafts:overrideLinks',
    spike: 'drafts:spike',
    assign: 'drafts:assign',
    recheckLinks: 'drafts:recheckLinks',
  }),
  members: Object.freeze({
    list: 'members:list',
    assignable: 'members:assignable',
    grant: 'members:grant',
    revoke: 'members:revoke',
    requestAccess: 'members:requestAccess',
    dismissRequest: 'members:dismissRequest',
  }),
  settings: Object.freeze({ get: 'settings:get', update: 'settings:update' }),
  publish: Object.freeze({ status: 'publish:status', now: 'publish:now', retry: 'publish:retry' }),
});

/** The queries among FN; every other name is a mutation. */
export const QUERIES = Object.freeze([
  FN.desk.me, FN.desk.queue, FN.members.list, FN.members.assignable, FN.settings.get, FN.publish.status,
]);

/** 'query' or 'mutation', as authedCall's first argument wants it. */
export function kindOf(name) {
  return QUERIES.includes(name) ? 'query' : 'mutation';
}

function meta(doc, name) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  return doc.querySelector(`meta[name="${name}"]`);
}

/**
 * The deployment this page talks to, or null when there is none yet. Unlike
 * vitrina, an EMPTY meta is null too: desk.html ships it empty until
 * scripts/setup-antenne.sh writes the URL, and empty means "the backend is not
 * set up". A meta that is present, non-empty and malformed still throws: read
 * as "not set up", a typo there would hide a deployment that exists.
 */
export function convexUrlFrom(doc) {
  const tag = meta(doc, 'neo-convex-url');
  if (!tag) return null;
  const url = tag.getAttribute('content') || '';
  if (url === '') return null;
  if (!CONVEX_URL_RE.test(url)) {
    throw new Error(`neo-convex-url must be a Convex cloud deployment URL, not ${JSON.stringify(url.slice(0, 80))}`);
  }
  return url;
}

/** The pinned client build, one self-contained file on jsDelivr (script-src allows it). */
export const CLIENT_URL = 'https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm';

const clients = new Map();

/**
 * A ConvexHttpClient for url, loaded once and cached per URL. The URL is
 * checked again here because it decides where a sign-in token is sent. A
 * failed load is not cached, so the next refresh tries again.
 */
export function loadClient(url) {
  if (!CONVEX_URL_RE.test(String(url))) return Promise.reject(new Error('loadClient needs a Convex cloud deployment URL'));
  if (!clients.has(url)) {
    const loading = import('https://cdn.jsdelivr.net/npm/convex@1.45.0/browser/+esm')
      .then(({ ConvexHttpClient }) => new ConvexHttpClient(url))
      .catch((err) => { clients.delete(url); throw err; });
    clients.set(url, loading);
  }
  return clients.get(url);
}

// ── Authenticated requests ───────────────────────────────────
// Copied from projects/vitrina-site/js/accountplan.js (authedCall, sessionOf, holderOf, isObject).

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * call(kind, name, args) through a signed-in Convex client (section 7 of
 * docs/plans/2026-09-15-antenne-desk.md: every desk call goes through here).
 *
 * The kit keeps a bound client on the token as Clerk refreshes it, but a
 * template token lives 60 seconds and clerk-js 5 does not refresh it in the
 * background, so every request, queries included, asks the kit for a token
 * first. A request that throws gets one fresh mint past Clerk's cache and one
 * retry; a second failure is the caller's to report. A write that threw may
 * still have reached the backend, with only its answer lost, so what its retry
 * finds there can be its own work: that answer carries retried: true, and
 * explain() below words a retried stale or status answer as a change that may
 * already have gone through.
 *
 * Who a request is for (holderOf) is taken before anything is awaited and
 * checked again just before a token is set. The desk shares one client per
 * deployment, so the request has to read that token before anything else can
 * set another: ConvexHttpClient builds a query's headers, and a mutation's
 * with skipQueue, synchronously on the call. A mutation left on the client's
 * own queue (its default) would read the token only when its turn came, which
 * can be after the next person's refresh set theirs; the desk awaits every
 * action itself, so it never needs that queue. A request whose holder changed
 * on the way throws unsent, and its retry is minted from the session it
 * started with, never from whoever is signed in by the time it failed.
 */
export function authedCall(getClient, kit) {
  return async function call(kind, name, args) {
    const session = sessionOf(kit);
    const holder = holderOf(kit);
    const still = () => holder !== null && holderOf(kit) === holder;
    const client = await getClient();
    const run = () => (kind === 'mutation' ? client.mutation(name, args, { skipQueue: true }) : client.query(name, args));
    try {
      const token = await kit.convexToken();
      if (!still()) throw new Error('the signed-in account changed before this request went out');
      if (token) client.setAuth(token);
      else if (typeof client.clearAuth === 'function') client.clearAuth();
      return await run();
    } catch (err) {
      if (!session || !still()) throw err;
      const fresh = await session.getToken({ template: 'convex', skipCache: true });
      if (!fresh || !still()) throw err;
      client.setAuth(fresh);
      const again = await run();
      return kind === 'mutation' && isObject(again) ? { ...again, retried: true } : again;
    }
  };
}

function sessionOf(kit) {
  const snap = kit ? kit.state : null;
  return snap && snap.clerk && snap.clerk.session ? snap.clerk.session : null;
}

/**
 * Who the kit's session is for, as one string, or null while the kit is between
 * two people. The kit swaps the session, then the token on every bound client,
 * and only then its userId and its listeners, so for a moment the session is
 * the next person's while userId is still the last one's. The session id is in
 * the string too, so a sign-out and sign-in in between is a change as well.
 */
export function holderOf(kit) {
  const snap = kit ? kit.state : null;
  const session = sessionOf(kit);
  const userId = (snap && snap.userId) || null;
  const owner = session && session.user && typeof session.user.id === 'string' ? session.user.id : userId;
  if (owner !== userId) return null;
  return `${userId || ''}|${(session && session.id) || ''}`;
}

// ── Refusals, in plain sentences ─────────────────────────────

/**
 * One sentence per failure code of section 4.2, written for the person at the
 * desk. The server's own message is never shown: this text is the desk's
 * promise about what each code means, and it cannot carry a story's words.
 */
export const FAILURE_TEXT = Object.freeze({
  'not-signed-in': 'Sign in to use the desk.',
  'not-member': 'Your account holds no desk role. Ask an owner for access.',
  forbidden: 'Your desk role cannot do that.',
  frozen: 'The desk is frozen: reading works, but changes are paused until an owner lifts the freeze.',
  'not-found': 'That story is no longer on the desk. The desk reloaded the queue.',
  stale: 'Someone changed this story since you loaded it. The desk reloaded it: check it and try again.',
  status: 'This story has moved on, so that cannot be done now. The desk reloaded it.',
  'own-submission': 'You submitted this story, so someone else has to approve it.',
  'external-links': 'This story links outside neorgon.com, so an editor or an owner has to approve it.',
  'links-blocked': 'A link on this story is broken. Fix the link, or ask an owner to override the check.',
  invalid: 'The story does not pass the desk rules yet.',
  'duplicate-id': 'Another story already uses that id. Give this one a different id.',
  'rate-limited': 'Too many changes in a short time. Wait a little and try again.',
  'queue-full': 'The desk has too many open access requests right now. Try again later.',
  'bad-role': 'That role does not fit: grant editor, reviewer or submitter, and hand stories only to a reviewer, an editor or an owner.',
  'bad-subject': 'That is not an account the desk can use. An account id looks like user_2abc, and an owner is set outside the desk.',
  'too-many': 'That is too many at once: approve at most 25 stories in one go.',
  unreachable: 'The desk could not reach its backend. Check your connection and try again.',
});

/** "links[1].url" becomes "Link 2 URL"; a problem code becomes a phrase. */
const PROBLEM_TEXT = Object.freeze({
  required: 'is missing',
  format: 'has the wrong format',
  'too-long': 'is too long',
  'too-many': 'has too many entries',
  chars: 'holds a character the feed refuses',
  token: 'looks like a secret token',
  'id-date': 'must start with the story date, as in 2026-09-21-name',
  calendar: 'is not a real date',
  duplicate: 'repeats a tag',
  scheme: 'must start with https://',
  host: 'links outside neorgon.com',
  window: 'is outside the submission window',
});

const FIELD_TEXT = Object.freeze({
  id: 'Id', date: 'Date', kind: 'Kind', site: 'Site', title: 'Title', summary: 'Summary',
  body: 'Body', links: 'Links', tags: 'Tags', patch: 'The change', items: 'The list', note: 'The note', label: 'The label',
});

export function fieldText(field) {
  const s = String(field);
  const m = /^(body|links|tags)\[(\d+)\](?:\.(label|url))?$/.exec(s);
  if (!m) return FIELD_TEXT[s] || 'A field';
  const n = Number(m[2]) + 1;
  if (m[1] === 'body') return 'Paragraph ' + n;
  if (m[1] === 'tags') return 'Tag ' + n;
  return 'Link ' + n + (m[3] === 'url' ? ' URL' : m[3] === 'label' ? ' label' : '');
}

/** One problem, { field, code }, as a phrase: "Title is too long". */
export function problemText(p) {
  const what = p && PROBLEM_TEXT[p.code] ? PROBLEM_TEXT[p.code] : 'is not accepted';
  return fieldText(p ? p.field : '') + ' ' + what;
}

const RATE_LEAD = 'Too many changes in a short time.';
const unit = (n, one, many) => (n === 1 ? one : n + ' ' + many);

/** A wait, rounded up as convex/lib/rate.ts retryAfterText does: minutes, then hours, then days. */
export function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(Number(ms) / 60000));
  if (minutes < 60) return unit(minutes, 'a minute', 'minutes');
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return unit(hours, 'an hour', 'hours');
  return unit(Math.ceil(hours / 24), 'a day', 'days');
}

/**
 * The sentence for a refused answer. `overrides` lets one action say what a
 * code means for it (publish:retry's "status" is about the last run, not a
 * story; Request access's "rate-limited" is a daily limit). A rate-limited
 * answer that carries retryAfterMs then says how long to wait. A retried write
 * that comes back stale or status may have been our own first attempt landing
 * with its answer lost, so it says that instead.
 */
export function explain(result, overrides = {}) {
  const r = isObject(result) ? result : { ok: false, code: 'unreachable' };
  const code = typeof r.code === 'string' ? r.code : 'unreachable';
  if (r.retried && (code === 'stale' || code === 'status')) {
    return 'Your change may already have gone through before the connection dropped. The desk reloaded the story: check it.';
  }
  let text = Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code]
    : Object.prototype.hasOwnProperty.call(FAILURE_TEXT, code) ? FAILURE_TEXT[code]
      : 'The desk refused that (' + code.slice(0, 40) + ').';
  if (code === 'rate-limited' && Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0) {
    const lead = Object.prototype.hasOwnProperty.call(overrides, code) ? overrides[code] : RATE_LEAD;
    text = lead + ' Try again in ' + waitText(r.retryAfterMs) + '.';
  }
  if (code === 'invalid' && Array.isArray(r.problems) && r.problems.length) {
    text += ' ' + r.problems.slice(0, 6).map(problemText).join('; ') + '.';
  }
  return text;
}
