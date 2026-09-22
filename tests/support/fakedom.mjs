// Enough of a browser for a desk module that only reaches the DOM to say
// something. Plain node, no install.
//
// js/utils.js showToast() wants getElementById, createElement, body.appendChild
// and requestAnimationFrame; the publish fallback wants createElement plus a
// click. Nothing here pretends to be a DOM: there is no tree, no events and no
// layout. A test that needs those needs a real browser, and the desk's own
// rendering is covered by exercising the page.
//
// requestAnimationFrame QUEUES rather than fires, so a test that forgets to
// flush() reads an empty toast and fails, instead of passing on a callback that
// happened to run synchronously here and would not in a browser.

const frames = [];

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
}

function makeElement(tag, clicked) {
  return {
    tagName: String(tag).toUpperCase(),
    textContent: '',
    classList: new FakeClassList(),
    attributes: Object.create(null),
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { return child; },
    click() { clicked.push(this); },
  };
}

/**
 * Installs the globals on globalThis and returns the handles a test asserts on.
 * Call once, before importing the module under test.
 */
export function installDom() {
  const clicked = [];
  const byId = new Map();

  const document = {
    body: { appendChild(el) { return el; } },
    getElementById: (id) => byId.get(id) || null,
    createElement(tag) {
      const el = makeElement(tag, clicked);
      // showToast finds its region again by id, so an element that sets one has
      // to become findable the way appendChild would make it.
      Object.defineProperty(el, 'id', {
        get() { return el.attributes.id || ''; },
        set(value) { el.attributes.id = value; byId.set(value, el); },
      });
      return el;
    },
  };

  globalThis.window = { showSaveFilePicker: undefined };
  globalThis.document = document;
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

  return {
    clicked,
    /** Register an element the module under test will look up by id. */
    put(id, el) { byId.set(id, el); return el; },
    /** What the toast region currently reads, '' when nothing has been said. */
    toastText() {
      const el = byId.get('app-toast');
      return el ? el.textContent : '';
    },
    /** Forget the last publish, so the next assertion cannot pass on stale state. */
    reset() {
      clicked.length = 0;
      const el = byId.get('app-toast');
      if (el) el.textContent = '';
      frames.length = 0;
    },
  };
}

/** Run the queued frame callbacks, then let pending promises settle. */
export async function flush() {
  const pending = frames.splice(0, frames.length);
  for (const fn of pending) fn();
  await Promise.resolve();
}

// ── Added 2026-09-21 (desk-client): markup, a parsed page, bubbling events ──
// The desk renders with innerHTML into containers and listens on those
// containers (js/desk-*.js), so its tests need a little more than the above.
// Everything above keeps its behaviour; what follows is new and opt-in.
//
// parseHtml turns markup into nodes: tags, attributes and text, nothing
// rendered and no script run. A node answers querySelector(All), closest,
// matches, contains, focus, dataset, value, hidden, innerHTML and textContent,
// and holds listeners; fire() bubbles an event from a node through its
// ancestors, then to document and window. load(html) makes a whole page the
// document, so a test drives the real desk.html. Every innerHTML assignment is logged
// (writes()), so a test can parse all the markup a page ever produced.
//
// Selectors: tag, #id, .class, [attr], [attr="v"] and descendant chains,
// comma-separated. Nothing else.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : Object.prototype.hasOwnProperty.call(ENTITY, e.toLowerCase()) ? ENTITY[e.toLowerCase()] : m));
const encodeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeAttr = (s) => encodeText(s).replace(/"/g, '&quot;');
const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const page = { root: null, docListeners: new Map(), winListeners: new Map(), writes: [], byIdBefore: null, active: null };

/** As the DOM does it: the same listener added twice is registered once. */
function listen(map, type, fn) {
  if (!map.has(type)) map.set(type, []);
  if (!map.get(type).includes(fn)) map.get(type).push(fn);
}
function unlisten(map, type, fn) {
  const list = map.get(type) || [];
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

/** An element node. */
export function makeNode(tag, attributes = {}) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attributes: Object.assign(Object.create(null), attributes),
    children: [],
    parent: null,
    listeners: new Map(),
    _value: undefined,
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
    addEventListener(type, fn) { listen(this.listeners, type, fn); },
    removeEventListener(type, fn) { unlisten(this.listeners, type, fn); },
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); },
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; },
    matches(sel) { return matches(this, sel); },
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parent) if (matches(n, sel)) return n; return null; },
    appendChild(child) { adopt(this, child); return child; },
    append(...kids) { for (const k of kids) adopt(this, typeof k === 'string' ? { nodeType: 3, text: k } : k); },
    replaceChildren(...kids) { orphan(this); this.append(...kids); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
    click() { fire(this, 'click'); },
    // Focus as a browser keeps it: one element, and document.activeElement falls
    // back to <body> once that element leaves the page (see loadPage).
    focus() { page.active = this; },
    blur() { if (page.active === this) page.active = null; },
    contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
    showModal() { this.attributes.open = ''; this.modalCount = (this.modalCount || 0) + 1; },
    close() { if (!('open' in this.attributes)) return; delete this.attributes.open; fire(this, 'close', { bubbles: false }); },
  };
  const flag = (name) => ({ get() { return name in node.attributes; }, set(v) { if (v) node.attributes[name] = ''; else delete node.attributes[name]; }, enumerable: true });
  Object.defineProperties(node, {
    id: { get() { return node.attributes.id || ''; }, set(v) { node.attributes.id = String(v); } },
    className: { get() { return node.attributes.class || ''; }, set(v) { node.attributes.class = String(v); } },
    hidden: flag('hidden'),
    disabled: flag('disabled'),
    open: flag('open'),
    classList: { get() { return classList(node); } },
    dataset: {
      get() {
        return new Proxy({}, {
          get: (_, k) => (typeof k === 'string' && ('data-' + kebab(k)) in node.attributes ? node.attributes['data-' + kebab(k)] : undefined),
          set: (_, k, v) => { node.attributes['data-' + kebab(k)] = String(v); return true; },
        });
      },
    },
    textContent: {
      get() { return node.children.map((c) => (c.nodeType === 3 ? c.text : c.nodeType === 1 ? c.textContent : '')).join(''); },
      set(v) { orphan(node); adopt(node, { nodeType: 3, text: String(v) }); },
    },
    innerHTML: {
      get() { return serialize(node.children); },
      set(v) { page.writes.push(String(v)); orphan(node); parseInto(node, String(v)); },
    },
    value: {
      get() {
        if (node._value !== undefined) return node._value;
        if (node.tagName === 'TEXTAREA') return node.textContent;
        if (node.tagName === 'SELECT') {
          const options = descendants(node).filter((n) => n.tagName === 'OPTION');
          const chosen = options.find((o) => 'selected' in o.attributes) || options[0];
          return chosen ? chosen.value : '';
        }
        if (node.tagName === 'OPTION') return 'value' in node.attributes ? node.attributes.value : node.textContent;
        return node.attributes.value || '';
      },
      set(v) { node._value = String(v); },
    },
  });
  return node;
}

function classList(node) {
  const get = () => (node.attributes.class || '').split(/\s+/).filter(Boolean);
  const put = (list) => { node.attributes.class = list.join(' '); };
  return {
    add: (c) => { const l = get(); if (!l.includes(c)) put([...l, c]); },
    remove: (c) => put(get().filter((x) => x !== c)),
    contains: (c) => get().includes(c),
    toggle: (c, force) => { const on = force === undefined ? !get().includes(c) : force; if (on) classList(node).add(c); else classList(node).remove(c); return on; },
  };
}

/** Drops every child, detached, so a node that was replaced is no longer in the page. */
function orphan(node) {
  for (const c of node.children) if (c && typeof c === 'object') c.parent = null;
  node.children = [];
}

function adopt(parent, child) {
  if (child && typeof child === 'object') child.parent = parent;
  parent.children.push(child);
}

function descendants(node) {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) if (c && c.nodeType === 1) { out.push(c); walk(c); } };
  walk(node);
  return out;
}

function serialize(children) {
  return children.map((c) => {
    if (!c || typeof c !== 'object') return '';
    if (c.nodeType === 3) return encodeText(c.text);
    if (c.nodeType !== 1) return '';
    const tag = c.tagName.toLowerCase();
    const attrs = Object.entries(c.attributes).map(([k, v]) => (v === '' ? ' ' + k : ' ' + k + '="' + encodeAttr(v) + '"')).join('');
    return '<' + tag + attrs + '>' + (VOID.has(tag) ? '' : serialize(c.children) + '</' + tag + '>');
  }).join('');
}

const TAG_RE = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** Parses markup into children of parent (a node from makeNode). */
export function parseInto(parent, html) {
  const stack = [parent];
  const text = (s) => { if (s) adopt(stack[stack.length - 1], { nodeType: 3, text: decode(s) }); };
  TAG_RE.lastIndex = 0;
  let last = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    text(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    if (m[1]) {
      const tag = m[1].toUpperCase();
      const at = stack.map((n) => n.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    const node = makeNode(tag, parseAttrs(m[3] || ''));
    adopt(stack[stack.length - 1], node);
    if (VOID.has(tag) || m[4] === '/') continue;
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf('</' + tag, last);
      const stop = end < 0 ? html.length : end;
      const raw = html.slice(last, stop);
      if (raw) adopt(node, { nodeType: 3, text: tag === 'textarea' || tag === 'title' ? decode(raw) : raw });
      last = end < 0 ? html.length : html.indexOf('>', end) + 1;
      TAG_RE.lastIndex = last;
      continue;
    }
    stack.push(node);
  }
  text(html.slice(last));
  return parent;
}

/** Markup as a detached tree, for a test that checks what some HTML would become. */
export function parseHtml(html) {
  return parseInto(makeNode('#fragment'), html);
}

function compound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([^\]=\s]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let used = 0;
  for (const m of src.matchAll(re)) {
    used += m[0].length;
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] });
  }
  if (used !== src.length) throw new Error('fakedom: unsupported selector ' + JSON.stringify(src));
  return c;
}

function splitChain(sel) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel.trim()) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(compound);
}

function one(node, c) {
  if (!node || node.nodeType !== 1) return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.attributes.id !== c.id) return false;
  const classes = (node.attributes.class || '').split(/\s+/);
  if (c.classes.some((k) => !classes.includes(k))) return false;
  return c.attrs.every((a) => a.name in node.attributes && (a.value === undefined || node.attributes[a.name] === a.value));
}

function matches(node, sel) {
  return sel.split(',').some((alt) => {
    const chain = splitChain(alt);
    if (!one(node, chain[chain.length - 1])) return false;
    let n = node.parent;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (n && !one(n, chain[i])) n = n.parent;
      if (!n) return false;
      n = n.parent;
    }
    return true;
  });
}

/**
 * Dispatches an event at node and bubbles it through its ancestors, then to
 * document and window. A click on a submit button (or a button with no type)
 * inside a form then submits that form, as a browser would.
 */
export function fire(node, type, init = {}) {
  const event = {
    type, target: node, currentTarget: null, defaultPrevented: false, stopped: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  const bubbles = init.bubbles !== false;
  const call = (list, target) => { for (const fn of [...(list || [])]) { event.currentTarget = target; fn.call(target, event); } };
  let top = node;
  for (let n = node; n && !event.stopped; n = bubbles ? n.parent : null) { call(n.listeners && n.listeners.get(type), n); top = n; }
  const attached = bubbles && top === page.root;
  if (attached && !event.stopped) call(page.docListeners.get(type), globalThis.document);
  if (attached && !event.stopped) call(page.winListeners.get(type), globalThis.window);
  if (type === 'click' && !event.defaultPrevented && node.tagName === 'BUTTON' && (node.attributes.type || 'submit') === 'submit') {
    const form = node.closest('form');
    if (form) fire(form, 'submit');
  }
  return event;
}

/**
 * Makes a whole page the document: getElementById and querySelector search
 * it, document and window take listeners, and visibilityState is settable.
 * Returns the root. Call after installDom().
 */
export function loadPage(html) {
  const root = parseInto(makeNode('#document'), html);
  page.root = root;
  page.docListeners = new Map();
  page.winListeners = new Map();
  page.writes = [];
  const doc = globalThis.document;
  const byTree = (id) => descendants(root).find((n) => n.attributes.id === id) || null;
  if (!page.byIdBefore) page.byIdBefore = doc.getElementById;
  const earlier = page.byIdBefore;
  doc.getElementById = (id) => byTree(id) || earlier(id);
  doc.querySelector = (sel) => root.querySelector(sel);
  doc.querySelectorAll = (sel) => root.querySelectorAll(sel);
  doc.documentElement = root.querySelector('html');
  doc.head = root.querySelector('head');
  doc.visibilityState = 'visible';
  page.active = null;
  Object.defineProperty(doc, 'activeElement', {
    configurable: true,
    get: () => (page.active && root.contains(page.active) ? page.active : root.querySelector('body')),
  });
  doc.addEventListener = (type, fn) => listen(page.docListeners, type, fn);
  doc.removeEventListener = (type, fn) => unlisten(page.docListeners, type, fn);
  globalThis.window.addEventListener = (type, fn) => listen(page.winListeners, type, fn);
  globalThis.window.removeEventListener = (type, fn) => unlisten(page.winListeners, type, fn);
  return root;
}

/** Fires an event at document or window listeners directly (focus, visibilitychange). */
export function fireGlobal(target, type) {
  const map = target === 'window' ? page.winListeners : page.docListeners;
  for (const fn of [...(map.get(type) || [])]) fn({ type, target: null });
}

/** Every string assigned to an innerHTML since the page loaded. */
export function writes() {
  return page.writes.slice();
}
