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
