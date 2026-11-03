// Plain node, no install. Run with: make validate
//
// Answers that arrive late, over the harness tests/desk-flow.test.mjs uses
// (tests/support/deskflow.mjs). Each case holds a guard that the other desk
// tests passed without (queue #134, the round 2 verifiers of 2026-09-22), so
// that taking it out turns this file red:
//
// - Every action that reports in the notice line takes its say() from
//   sayLater() before it calls the server, so an answer for the last account
//   never speaks under the next: Save, New story's Submit, Approve all, the
//   People panel's changes (send), Copy account id, Publish now and Retry.
//   tests/desk-flow-more.test.mjs holds the card buttons (mutate).
// - desk.js clears `asking` only for the refresh that set it, so an older
//   desk:me answering late does not let the next automatic refresh past a
//   newer one still on its way.
// - js/desk-people.js load() drops an answer once desk.gen has moved on, even
//   when no other People load started since.
// - An account change closes a confirm the last caller left open, settling it
//   as Cancel, so its Confirm can never act for the next account.

import { fire, fireGlobal } from './support/fakedom.mjs';
import {
  $, EDITOR, MIN, OWNER, SPAM, SUBMITTER, btn, checker, click, hold, names, row, sent, server, settle, start, stop, world,
} from './support/deskflow.mjs';
import { runRow } from '../convex/lib/publishCore.ts';
import * as peopleMod from '../js/desk-people.js';

const T = checker();
const { eq, section } = T;
const notice = () => $('deskNotice').textContent;
const count = (name, from) => names(from).filter((n) => n === name).length;

/**
 * Starts the desk for `who`, runs `act` (which starts an action whose server call `fn` is held),
 * switches the account to `next` while it waits, then lets the answer through.
 */
async function lateAnswer(who, fn, act, next = SUBMITTER) {
  await start(who);
  const kit = globalThis.__kit;
  const release = hold(fn);
  const from = server.calls.length;
  await act();
  eq(count(fn, from), 1, `${fn} was asked for`);
  kit.switchTo(next);
  await settle();
  release();
  await settle();
  return notice();
}

await section("an answer for the last account's action never speaks under the next: Save, Submit, Approve all, People, Publish now, Retry", async () => {
  let ids = await world();
  const saved = await lateAnswer(EDITOR, 'drafts:edit', async () => {
    await click(btn('edit', ids.plain));
    const title = $('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`);
    title.value = 'Saved late';
    fire(title, 'input');
    fire(btn('save', ids.plain), 'click');
    await settle();
  });
  eq([row(ids.plain).post.title, saved], ['Saved late', ''], "Save: the edit went through, and the editor's notice says nothing under the submitter");

  await world();
  const submitted = await lateAnswer(EDITOR, 'drafts:submit', async () => {
    await click($('newStoryBtn'));
    const form = $('newStory');
    for (const [f, v] of [['date', '2026-09-20'], ['id', '2026-09-20-sent-late'], ['title', 'Sent late'], ['summary', 'Late.'], ['body', 'First.'], ['tags', 'desk']]) {
      const n = form.querySelector(`[data-field="${f}"]`);
      n.value = v;
      fire(n, 'input');
    }
    fire(form.querySelector('[data-act="submit-new"]'), 'click');
    await settle();
  });
  eq([server.db.rows('drafts').some((d) => d.storyId === '2026-09-20-sent-late'), submitted], [true, ''], 'Submit: the story was added, and nothing is said under the next account');

  ids = await world();
  const approved = await lateAnswer(EDITOR, 'drafts:approveMany', async () => {
    await click($('approveAllBtn'));
    fire($('deskDialogConfirm'), 'click');
    await settle();
  });
  eq([row(ids.plain).status, approved], ['approved', ''], 'Approve all: the stories were approved, and its count is not said under the next account');

  await world();
  const dismissed = await lateAnswer(OWNER, 'members:dismissRequest', async () => {
    fire($('people').querySelector(`[data-act="dismiss"][data-subject="${SPAM}"]`), 'click');
    await settle();
  }, EDITOR);
  eq([server.db.rows('accessRequests').some((r) => r.subject === SPAM), dismissed], [false, ''], "People: the request was dismissed, and the owner's notice says nothing under the editor");

  await world();
  const published = await lateAnswer(EDITOR, 'publish:now', async () => {
    fire($('publishBar').querySelector('[data-act="publish-now"]'), 'click');
    await settle();
  });
  eq([server.db.rows('publishRuns').at(-1)?.trigger, published], ['now', ''], 'Publish now: the run was queued, and nothing is said under the next account');

  await world();
  await server.db.insert('publishRuns', runRow('approve', Date.now() - 20 * MIN, Date.now() - 20 * MIN, { state: 'failed', error: 'attempts', attempts: 5 }));
  const retried = await lateAnswer(EDITOR, 'publish:retry', async () => {
    fire($('publishBar').querySelector('[data-act="retry"]'), 'click');
    await settle();
  });
  eq([server.db.rows('publishRuns').at(-1)?.trigger, retried], ['retry', ''], 'Retry: the run was queued, and nothing is said under the next account');
});

await section('Copy account id, answered once the next account is signed in, says nothing under it', async () => {
  await world();
  const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let wrote = null;
  let finish = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text) => { wrote = text; return new Promise((r) => { finish = r; }); } } });
  try {
    await start(OWNER);
    fire($('deskAccount').querySelector('[data-act="copy-id"]'), 'click');
    await settle();
    finish();
    await settle();
    eq([wrote, notice()], [OWNER, 'Account id copied.'], 'the same account: the copy is reported');
    fire($('deskAccount').querySelector('[data-act="copy-id"]'), 'click');
    await settle();
    globalThis.__kit.switchTo(EDITOR);
    await settle();
    finish();
    await settle();
    eq(notice(), '', 'a copy that finishes after the account changed says nothing under the next one');
  } finally {
    if (had) Object.defineProperty(navigator, 'clipboard', had);
    else delete navigator.clipboard;
  }
});

await section('an older desk:me answering late leaves a newer one in charge of the next automatic refresh', async () => {
  await world();
  await start(EDITOR);
  const kit = globalThis.__kit;
  const older = hold('desk:me');
  fireGlobal('window', 'focus');
  await settle();
  const newer = hold('desk:me');
  kit.switchTo(EDITOR); // the same account: Clerk's onChange, which asks desk:me again without waiting
  await settle();
  older();
  await settle();
  const from = server.calls.length;
  fireGlobal('window', 'focus');
  await settle();
  eq(count('desk:me', from), 0, 'a return to the tab while the newer desk:me is on its way sends no third one');
  newer();
  await settle();
  const after = server.calls.length;
  fireGlobal('window', 'focus');
  await settle();
  eq(count('desk:me', after), 1, 'once the newer one has answered, the next return to the tab refreshes');
});

await section('a People load answered after desk.gen moved on draws nothing', async () => {
  await world();
  await start(OWNER);
  await server.db.insert('members', { subject: 'user_late', role: 'reviewer', label: 'Added while it was on its way', email: null, grantedBy: OWNER, grantedAt: Date.now() });
  const ctx = { me: { ok: true, signedIn: true, subject: OWNER, role: 'owner' }, gen: 5, call: (name) => server.run('query', name, {}, `tok:${OWNER}`) };
  const release = hold('members:list');
  const late = peopleMod.load(ctx);
  await settle();
  ctx.gen += 1; // a newer refresh began, and has not reached the People panel yet
  release();
  await late;
  eq($('people').textContent.includes('Added while it was on its way'), false, 'the answer for the older refresh is dropped');
  await peopleMod.load(ctx);
  eq($('people').textContent.includes('Added while it was on its way'), true, 'a load for the current gen draws the same list, with the new member');
});

await section("an account change closes the last caller's confirm as Cancel, and its Confirm then does nothing", async () => {
  await world();
  await start(EDITOR);
  await click($('approveAllBtn'));
  eq($('deskDialog').open, true, 'Approve all asks first');
  const from = server.calls.length;
  globalThis.__kit.switchTo(SUBMITTER);
  await settle();
  eq([$('deskDialog').open, count('drafts:approveMany', from)], [false, 0], 'the account changed: the dialog is closed, and nothing was approved');
  await click($('deskDialogConfirm'));
  eq([count('drafts:approveMany', from), sent('drafts:approveMany')], [0, null], "its Confirm, pressed after, sends nothing for the editor's list");
});

if (stop) stop();
console.log(T.failed ? `\ndesk late answers: ${T.failed} of ${T.checks} checks failed` : `\ndesk late answers: all ${T.checks} checks pass`);
process.exit(T.failed ? 1 : 0);
