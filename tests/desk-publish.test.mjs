// Plain node, no install. Run with: make validate
//
// Where Publish puts the file (queue #64).
//
// On 2026-09-11 the desk wrote twelve approved stories to the REPO ROOT, over a
// stale tracked posts.json that nothing reads, and nothing went live until they
// were copied into data/posts.json by hand. The dialog asked for a file called
// posts.json and said nothing about where it belongs, so it opened wherever the
// picker had last been and the operator accepted it.
//
// Two halves to the fix and this file covers the desk's half. The picker now
// carries a stable `id`, which is what makes a browser remember a directory PER
// PURPOSE rather than one "last used" directory shared with every other save on
// the machine, and every message names the path rather than the file. The other
// half is scripts/build-feed.py, which fails when a posts.json appears at the
// root (tests/test_build_feed.py), because no wording in a dialog can be relied
// on to stop a mis-save and a check at commit can.
//
// A dialog's starting directory is a browser decision that no test can observe:
// what is asserted here is that the desk asks for the right thing and says the
// right thing.

import assert from 'node:assert/strict';

import { installDom, flush } from './support/fakedom.mjs';

const dom = installDom();
const { publish, PUBLISH_TARGET, docJson } = await import('../js/desk.js');

let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
};

/** A picker that records what it was asked for and what was written to it. */
function fakePicker({ name = 'posts.json', abort = false } = {}) {
  const calls = [];
  const written = [];
  globalThis.window.showSaveFilePicker = async (options) => {
    calls.push(options);
    if (abort) {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    }
    return {
      name,
      createWritable: async () => ({
        write: async (text) => written.push(text),
        close: async () => {},
      }),
    };
  };
  return { calls, written };
}

console.log('desk publish (#64)');

await test('the archive path is named once, and it is data/posts.json', () => {
  assert.equal(PUBLISH_TARGET, 'data/posts.json');
});

await test('the picker is asked for posts.json under a stable id, so the dialog can reopen where it last saved', async () => {
  const picker = fakePicker();
  await publish();
  assert.equal(picker.calls.length, 1, 'the picker was not opened');
  const [options] = picker.calls;
  assert.equal(options.suggestedName, 'posts.json');
  // A suggestedName may not carry a directory, so the id is the only part of the
  // request that can steer WHERE the dialog opens. Its form is constrained: a
  // browser rejects an id that is not alphanumeric with underscores or hyphens,
  // or is longer than 32 characters, and a rejected id throws instead of saving.
  assert.match(options.id, /^[A-Za-z0-9_-]{1,32}$/, `an id of "${options.id}" would make the picker throw`);
  assert.equal(options.types[0].accept['application/json'][0], '.json');
});

await test('what is written is the document the desk would publish, byte for byte', async () => {
  const picker = fakePicker();
  const expected = docJson();
  await publish();
  assert.deepEqual(picker.written, [expected]);
});

await test('the toast names the path and not only the file, because the file alone is what went wrong', async () => {
  const picker = fakePicker();
  await publish();
  await flush();
  assert.equal(picker.written.length, 1, 'nothing was written, so the toast proves nothing');
  assert.match(dom.toastText(), /data\/posts\.json/, `the toast read "${dom.toastText()}"`);
});

await test('a saved file under another name is called out rather than reported as published', async () => {
  // The picker lets the operator rename. "posts (1).json" in the right directory
  // is as dead as posts.json in the wrong one, and the desk can see this one.
  const picker = fakePicker({ name: 'posts (1).json' });
  await publish();
  await flush();
  assert.equal(picker.written.length, 1, 'the file was not written, which is a different failure');
  assert.match(dom.toastText(), /posts \(1\)\.json/, `the toast read "${dom.toastText()}"`);
  assert.match(dom.toastText(), /data\/posts\.json/, 'the toast did not say what the name has to be');
});

await test('a cancelled dialog writes nothing and does not fall through to a download', async () => {
  fakePicker({ abort: true });
  dom.reset();
  await publish();
  await flush();
  assert.deepEqual(dom.clicked, [], 'a cancelled save started a download');
  assert.equal(dom.toastText(), '', `a cancelled save said "${dom.toastText()}"`);
});

await test('a browser with no picker downloads the file and says where it has to go', async () => {
  delete globalThis.window.showSaveFilePicker;
  dom.reset();
  await publish();
  await flush();
  assert.equal(dom.clicked.length, 1, 'no download was started');
  assert.equal(dom.clicked[0].download, 'posts.json');
  assert.match(dom.toastText(), /data\/posts\.json/, `the toast read "${dom.toastText()}"`);
});

console.log(failures ? `\ndesk publish: ${failures} failure(s)` : '\ndesk publish: all checks pass');
process.exit(failures ? 1 : 0);
