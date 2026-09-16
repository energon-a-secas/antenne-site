// js/data.js loadArchive(): the browser end of the publish-time archive stamp.
// Run with: make validate
//
// scripts/build-feed.py writes the stamp and tests/test_build_feed.py holds it
// to the archive; this is the other half, the page reading it back. It runs
// against the real index.html and the real data/posts.json, so a stamp shape
// only one side understands fails here rather than in a browser (it already did
// once: the gen:archive markers started out inside the script element, where
// they are raw text, so every visitor got "published broken").
//
// The page never fetches now, and fetch is a hard failure here to keep it that
// way: a reintroduced request would otherwise pass in node and cost a round trip
// before the first render, which is the whole point of queue #43.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installDom } from './support/fakedom.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'index.html'), 'utf8');
const ARCHIVE = JSON.parse(readFileSync(join(ROOT, 'data', 'posts.json'), 'utf8'));

const dom = installDom();
globalThis.fetch = () => { throw new Error('the page must not fetch: the archive is stamped into it'); };
const { loadArchive, normalizeDoc } = await import('../js/data.js');

/** The stamped archive as the browser hands it to loadArchive: the element's own
    text, which is everything between the gen:archive markers minus the tags. */
function stampedText(html) {
  const region = html.slice(html.indexOf('<!-- gen:archive -->'), html.indexOf('<!-- /gen:archive -->'));
  return region.slice(region.indexOf('>', region.indexOf('<script')) + 1, region.lastIndexOf('</script>'));
}

/** Put a stamp in the page. Pass null for a page built without one. */
function stamp(textContent) {
  dom.put('archive', textContent === null ? null : { textContent });
}

test('the stamp in index.html is the archive in data/posts.json', () => {
  stamp(stampedText(INDEX));
  const got = loadArchive();
  assert.equal(got.updated, ARCHIVE.updated);
  assert.deepEqual(got.posts, normalizeDoc(ARCHIVE));
  assert.deepEqual(got.posts.map((p) => p.id), ARCHIVE.posts.map((p) => p.id));
});

test('the escaped < survives the round trip as a <', () => {
  // build-feed.py writes every < as \u003c so no story can end the element.
  // JSON.parse turns it back, so the page renders the character as written.
  stamp('{"updated":"2026-09-11","posts":[{"id":"2026-09-11-x","date":"2026-09-11",'
    + '"kind":"note","title":"Breakout \\u003c/script>","summary":"s","body":["\\u003c!-- b"],'
    + '"links":[],"tags":[]}]}');
  const [post] = loadArchive().posts;
  assert.equal(post.title, 'Breakout </script>');
  assert.equal(post.body[0], '<!-- b');
});

test('a page built with no stamp throws, naming the build step', () => {
  stamp(null);
  assert.throws(() => loadArchive(), /no archive stamp.*make feed/);
});

test('a stamp that is not JSON throws', () => {
  stamp('{"posts":[');
  assert.throws(() => loadArchive(), SyntaxError);
});

test('a stamp with no updated reads as no date, not as today', () => {
  // The edition line falls back to the word "today" rather than printing the
  // visitor's clock, which is the disagreement queue #43 was about.
  stamp('{"posts":[]}');
  assert.deepEqual(loadArchive(), { posts: [], updated: null });
});
