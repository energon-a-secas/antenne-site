// Plain node, no install. Run with: make validate
//
// The desk, end to end in node: the real desk.html in tests/support/fakedom.mjs,
// the real js/desk*.js, and behind the Convex client the real convex/*.ts
// wrappers over tests/support/fakedb.mjs (docs/plans/2026-09-15-antenne-desk.md
// section 7), all set up by tests/support/deskflow.mjs. Every call the desk
// makes is checked against the function's declared args the way Convex checks
// them, and identity is only what the token carries. More cases, over the same
// harness, are in tests/desk-flow-more.test.mjs.
//
// The four states render; "not set up" loads no module and makes no request;
// each role sees what it may do and nothing more; every control is clicked and
// sends what the function declares (expectedRev where it takes one); a stale
// answer re-fetches and says so; "Approve all shown" lists every title before
// approveMany goes out, 25 at most; Escape settles a confirm; an answer that
// arrives after the caller changed draws nothing; and markup stays text.

import { fire, loadPage, parseHtml, writes } from './support/fakedom.mjs';
import {
  $, ASKER, BREAK, EDITOR, OWNER, REVIEWER, SPAM, STRANGER, SUBMITTER, XSS, acts, all, boot, btn, checker, click, contentHash,
  fetched, focus, hold, HTML, intervals, loaded, names, row, sent, server, settle, start, stop, world, written,
} from './support/deskflow.mjs';

const T = checker();
const { eq, section } = T;

await section('not set up: says so, and loads no kit, no client and makes no request', async () => {
  eq($('deskBanner').textContent.startsWith('The desk backend is not set up yet.'), true, 'the banner says the backend is not set up');
  eq(loaded.filter((s) => /neorgon-auth|jsdelivr|convex/.test(s)), [], 'neither the Auth Kit nor the Convex client was imported');
  eq([fetched, server.calls.length, globalThis.__clients, intervals.length], [0, 0, undefined, 0], 'no fetch, no Convex call, no client, no refresh timer');
  eq(['accountSection', 'lanesSection', 'publishSection', 'peopleSection'].map((id) => $(id).hidden), [true, true, true, true], 'every section stays hidden');
  loadPage(HTML.replace('<meta name="neo-convex-url" content="">', '<meta name="neo-convex-url" content="https://evil.example.com">'));
  const quiet = console.error;
  console.error = () => {};
  eq(boot(), null, 'a malformed URL connects nowhere either');
  console.error = quiet;
  eq([$('deskBanner').dataset.state, loaded.some((s) => /neorgon-auth|jsdelivr/.test(s))], ['misconfigured', false], 'and says the page is misconfigured');
});

await section('signed out: a sign-in prompt through NeoAuth.requireSignIn, and no queue', async () => {
  await world();
  const from = await start(null);
  const kit = globalThis.__kit;
  eq(kit.log.find((e) => e[0] === 'start'), ['start', { siteName: 'Antenne Desk' }], 'NeoAuth.start({ siteName: "Antenne Desk" })');
  eq([names(from), server.calls[from].token], [['desk:me'], null], 'desk:me alone, sent with no token');
  eq($('deskBanner').dataset.state, 'signed-out', 'the signed-out state');
  await click($('deskBanner').querySelector('[data-act="sign-in"]'));
  eq(kit.log.filter((e) => e[0] === 'requireSignIn').length, 1, 'its Sign in button asks the kit to sign in');
  eq([$('lanesSection').hidden, $('accountSection').hidden, kit.log.some((e) => e[0] === 'bindConvex')], [true, true, false], 'no lanes, no account, and bindConvex is never called');
  eq(globalThis.__clients, 1, 'the client was loaded once the page named a deployment');
});

await section('signed in, no role: the account id, then Request access, then "requested"', async () => {
  await world();
  const from = await start(STRANGER, { label: `Stranger ${XSS}` });
  eq([$('deskBanner').dataset.state, $('accountSection').hidden, $('lanesSection').hidden], ['no-role', false, true], 'the no-role state shows the account only');
  eq($('deskAccount').querySelector('code').textContent, STRANGER, 'the account id an owner grants a role to');
  eq(names(from), ['desk:me'], 'and asks for nothing a role would see');
  $('deskAccount').querySelector('[name="note"]').value = 'I write the release notes';
  await click($('deskAccount').querySelector('form button[type="submit"]'));
  eq(sent('members:requestAccess'), { note: 'I write the release notes' }, 'members:requestAccess with the note');
  eq($('deskAccount').querySelector('[data-state="requested"]') !== null, true, 'and the page now says access was requested');
  eq(server.db.rows('accessRequests').map((r) => r.subject), [ASKER, SPAM, STRANGER], 'the request is stored for that account');
  await start('user_quiet');
  await click($('deskAccount').querySelector('form button[type="submit"]'));
  eq(server.calls.filter((c) => c.name === 'members:requestAccess').map((c) => c.args), [{ note: 'I write the release notes' }, {}], 'with no note typed, the request carries no note field');
});

await section('an owner: People and settings, Publish now, the override, and the dialog', async () => {
  const ids = await world();
  await start(OWNER);
  const panel = $('people');
  const field = (form, name) => panel.querySelector(`[data-form="${form}"] [name="${name}"]`);
  const submit = (form) => click(panel.querySelector(`[data-form="${form}"] button[type="submit"]`));
  eq([$('deskBanner').dataset.state, $('peopleSection').hidden, $('publishSection').hidden], ['member', false, false], 'member state, People and the status bar shown');
  eq(['[data-form="grant"]', '[data-form="settings"]', '[data-act="revoke"]'].map((s) => panel.querySelector(s) !== null), [true, true, true], 'the grant form, settings, and revoke');
  eq($('publishBar').querySelector('[data-act="publish-now"]') !== null, true, 'Publish now');
  eq([btn('override', ids.broken) !== null, btn('approve', ids.broken), btn('override', ids.plain)], [true, null, null], 'override only on a blocking link check, and no approve there');
  await click(btn('override', ids.broken));
  eq([sent('drafts:overrideLinks'), typeof row(ids.broken).linkOverride], [{ draftId: ids.broken, expectedRev: 1 }, 'string'], 'Override sends the draft and its rev');
  const request = [`Asker ${BREAK}`, `ask${BREAK}@example.org`, `Please ${BREAK}`];
  eq([panel.querySelectorAll('img').length, request.map((t) => panel.textContent.includes(t))], [0, [true, true, true]], "an access request's label, email and note arrive as text");
  field('grant', 'subject').value = 'user_half';
  fire(field('grant', 'subject'), 'input');
  const from = server.calls.length;
  await focus();
  eq([names(from).includes('desk:me'), names(from).includes('members:list'), field('grant', 'subject').value], [true, false, 'user_half'], 'an auto refresh leaves the People forms alone once something is typed');
  field('grant', 'label').value = ' ';
  await submit('grant');
  eq([sent('members:grant'), $('deskNotice').textContent], [null, 'Give the account id and a label.'], 'a grant with no label is not sent');
  field('grant', 'subject').value = 'user_newbie';
  field('grant', 'label').value = 'New person';
  await submit('grant');
  eq(sent('members:grant'), { subject: 'user_newbie', role: 'reviewer', label: 'New person' }, 'Grant sends the subject, the role select and the label');
  await click(panel.querySelector(`[data-act="use-request"][data-subject="${ASKER}"]`));
  eq([field('grant', 'subject').value, field('grant', 'label').value], [ASKER, `Asker ${BREAK}`], 'Grant a role fills the form from the request');
  await submit('grant');
  eq(sent('members:grant'), { subject: ASKER, role: 'reviewer', label: `Asker ${BREAK}` }, 'and Grant sends it as typed');
  await click(panel.querySelector(`[data-act="dismiss"][data-subject="${SPAM}"]`));
  eq([sent('members:dismissRequest'), server.db.rows('accessRequests').length], [{ subject: SPAM }, 0], 'Dismiss sends members:dismissRequest; no request is left');
  field('settings', 'delay').value = '31';
  await submit('settings');
  eq([sent('settings:update'), $('deskNotice').textContent.startsWith('The publish delay is a whole number')], [null, true], 'a delay past 30 minutes is not sent');
  field('settings', 'delay').value = '7';
  field('settings', 'defaultAssignee').value = REVIEWER;
  await submit('settings');
  eq([sent('settings:update'), server.db.rows('settings')[0].publishDelayMs], [{ defaultAssignee: REVIEWER, publishDelayMs: 420000 }, 420000], 'Save settings sends the delay in milliseconds');
  const revoke = () => panel.querySelector(`[data-act="revoke"][data-subject="${REVIEWER}"]`);
  await click(revoke());
  eq([$('deskDialog').open, sent('members:revoke')], [true, null], 'Revoke asks first');
  await click($('deskDialogCancel'));
  eq([$('deskDialog').open, sent('members:revoke')], [false, null], 'and Cancel revokes nobody');
  await click($('approveAllBtn'));
  $('deskDialog').close();
  await settle();
  await click(revoke());
  await click($('deskDialogConfirm'));
  eq([sent('members:revoke'), sent('drafts:approveMany')], [{ subject: REVIEWER }, null], 'Escape (the dialog closing) cancels Approve all, so the next confirm sends only its own call');
});

await section('an editor: the lanes, approve with expectedRev, and a stale answer re-fetched', async () => {
  const ids = await world();
  await start(EDITOR);
  eq(all('[data-lane]').map((l) => l.dataset.lane), ['mine', 'free', 'others', 'approved', 'done', 'spiked'], 'all six lanes');
  eq(all('[data-draft]', $('lanes').querySelector('[data-lane="others"]')).map((d) => d.dataset.draft).includes(ids.held), true, 'a story the reviewer holds is With others');
  eq([btn('approve', ids.own), $('lanes').textContent.includes('You submitted this story')], [null, true], 'no Approve on their own submission, and the reason');
  eq([$('peopleSection').hidden, $('publishBar').querySelector('[data-act="publish-now"]') !== null], [true, true], 'no People panel; Publish now');
  let from = server.calls.length;
  await click(btn('approve', ids.plain));
  eq(server.calls.slice(from).find((c) => c.name === 'drafts:approve').args, { draftId: ids.plain, expectedRev: 1 }, 'Approve sends the draft and the rev it was drawn at');
  eq([row(ids.plain).status, names(from).includes('desk:queue')], ['approved', true], 'the story is approved, and the queue reloaded');
  eq($('deskNotice').textContent.startsWith('Approved "Plain story".'), true, 'and the desk says so');
  await server.db.patch('drafts', ids.outside, { rev: 2, updatedAt: Date.now() });
  from = server.calls.length;
  await click(btn('approve', ids.outside));
  const answer = server.calls.slice(from).find((c) => c.name === 'drafts:approve');
  eq([answer.args.expectedRev, row(ids.outside).status], [1, 'pending'], 'a card drawn at rev 1 sends 1 and is refused');
  eq(names(from).slice(names(from).indexOf('drafts:approve') + 1).includes('desk:queue'), true, 'the stale answer re-fetches the queue');
  eq($('deskNotice').textContent.includes('changed this story since you loaded it'), true, 'and says so');
  eq(btn('approve', ids.outside).dataset.rev, '2', 'the card is redrawn at the new rev');
  from = server.calls.length;
  const select = all(`select[data-act="assign"][data-draft="${ids.own}"]`)[0];
  select.value = REVIEWER;
  fire(select, 'change');
  await settle();
  eq(names(from).includes('drafts:assign'), false, 'picking a name in Assign to sends nothing by itself');
  await click(btn('assign-go', ids.own));
  eq(server.calls.slice(from).find((c) => c.name === 'drafts:assign').args, { draftId: ids.own, expectedRev: 1, assignee: REVIEWER }, 'the Assign button sends expectedRev and the chosen person');
  for (const [act, key, rev] of [['take', 'xss', 1], ['withdraw', 'waiting', 2], ['reopen', 'spiked', 2]]) {
    await click(btn(act, ids[key]));
    eq([sent(`drafts:${act}`), row(ids[key]).status], [{ draftId: ids[key], expectedRev: rev }, 'pending'], `${act} sends the draft and the rev it was drawn at`);
  }
  await click(btn('recheck', ids.own));
  eq([row(ids.xss).assignee, sent('drafts:recheckLinks')], [EDITOR, { draftId: ids.own }], 'Take hands the story over; Check links again sends the draft alone (recheckLinks takes no rev)');
  const approved = $('lanes').querySelector('[data-lane="approved"]');
  eq([approved.querySelector(`[data-draft="${ids.claimed}"]`) !== null, approved.textContent.includes('Publishing now: a run has claimed it')], [true, true], 'a story a run has claimed stays in Approved, marked as publishing');
  eq(['members:list', 'settings:get'].map((n) => names().includes(n)), [false, false], 'an editor is never asked about People or settings');
});

await section('an edit that went stale keeps the text, then saves at the fresh rev', async () => {
  const ids = await world();
  await start(EDITOR);
  await click(btn('edit', ids.plain));
  const title = $('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`);
  title.value = 'Plain story, edited';
  fire(title, 'input');
  eq($('lanes').querySelector(`[data-preview="${ids.plain}"]`).textContent.includes('Plain story, edited'), true, 'the preview follows the typing');
  await server.db.patch('drafts', ids.plain, { rev: 3 });
  await click(btn('save', ids.plain));
  eq([server.calls.filter((c) => c.name === 'drafts:edit').map((c) => c.args.expectedRev), $('deskNotice').textContent.includes('while you were editing')], [[1], true], 'refused as stale, and said');
  eq($('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`).value, 'Plain story, edited', 'the editor stays open with the text');
  const from = server.calls.length;
  await focus();
  eq([names(from).includes('desk:me'), names(from).includes('desk:queue')], [true, false], 'a focus refresh while editing leaves the lanes alone');
  await click(btn('save', ids.plain));
  eq([server.calls.filter((c) => c.name === 'drafts:edit').map((c) => c.args.expectedRev), row(ids.plain).post.title, row(ids.plain).rev], [[1, 3], 'Plain story, edited', 4], 'saved at the fresh rev');
  await click(btn('edit', ids.plain));
  const again = $('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`);
  again.value = 'Approved as edited';
  fire(again, 'input');
  await click(btn('save-approve', ids.plain));
  const [args, r] = [sent('drafts:approve') || {}, row(ids.plain)];
  eq([args.expectedRev, (args.patch || {}).title, r.status, r.post.title, r.approvedHash === await contentHash(r.post)], [4, 'Approved as edited', 'approved', 'Approved as edited', true], 'Save and approve sends the edit as its patch, and the edited story is the one approved');
});

await section('Approve all shown: a dialog lists every title, then one approveMany', async () => {
  const ids = await world();
  await start(EDITOR);
  const from = server.calls.length;
  await click($('approveAllBtn'));
  eq([$('deskDialog').open, names(from).includes('drafts:approveMany')], [true, false], 'the dialog opens and nothing is sent yet');
  const listed = all('li', $('deskDialogList')).map((li) => li.textContent);
  eq(listed.slice().sort(), ['Held by the reviewer', 'Links elsewhere', 'Plain story', XSS].sort(), 'it lists every title an editor may approve, as text');
  const byTitle = { 'Held by the reviewer': ids.held, 'Links elsewhere': ids.outside, 'Plain story': ids.plain, [XSS]: ids.xss };
  const shown = listed.map((t) => byTitle[t]);
  await click($('deskDialogCancel'));
  eq([$('deskDialog').open, names(from).includes('drafts:approveMany')], [false, false], 'Cancel closes it and sends nothing');
  await click($('approveAllBtn'));
  await click($('deskDialogConfirm'));
  eq(sent('drafts:approveMany'), { items: shown.map((draftId) => ({ draftId, expectedRev: 1 })) }, 'Confirm sends every shown draft with its rev');
  eq(shown.map((id) => row(id).status), ['approved', 'approved', 'approved', 'approved'], 'and all four are approved');
  eq([row(ids.own).status, row(ids.broken).status], ['pending', 'pending'], 'their own story and the broken link were never offered');
});

await section('Approve all shown stops at 25, and says how many are left', async () => {
  await world({ more: 22 });
  await start(EDITOR);
  eq($('approveAllBtn').textContent, 'Approve all shown (25)', '26 approvable on show, 25 offered');
  await click($('approveAllBtn'));
  eq([all('li', $('deskDialogList')).length, $('deskDialogLead').textContent.endsWith('approve again for the other 1.')], [25, true], 'the dialog lists 25 and says one is left');
  await click($('deskDialogConfirm'));
  eq([(sent('drafts:approveMany') || { items: [] }).items.length, $('approveAllBtn').textContent], [25, 'Approve all shown (1)'], 'one approveMany of 25, and the last one still offered');
});

await section('an answer overtaken by a newer one, or asked for before the role went, draws nothing', async () => {
  const ids = await world();
  await start(EDITOR);
  const overtaken = hold('desk:queue');
  await focus();
  await click(btn('approve', ids.plain));
  overtaken();
  await settle();
  eq([btn('approve', ids.plain), $('lanes').querySelector(`[data-lane="approved"] [data-draft="${ids.plain}"]`) !== null], [null, true], 'the queue read before the approval, landing after the one read since, is dropped');
  const open = [hold('desk:queue'), hold('publish:status')];
  await focus();
  await server.db.delete('members', server.db.rows('members').find((m) => m.subject === EDITOR)._id);
  await focus();
  eq([$('deskBanner').dataset.state, all('article').length, $('publishBar').innerHTML], ['no-role', 0, ''], 'the role is gone, and so are the lanes and the status bar');
  open.forEach((release) => release());
  await settle();
  eq([all('article').length, $('publishBar').innerHTML], [0, ''], 'and the queue and status answers asked for before then draw nothing');
});

await section('a reviewer: no Publish now, no With others, and outside links left to an editor', async () => {
  const ids = await world();
  await start(REVIEWER);
  eq(all('[data-lane]').map((l) => l.dataset.lane), ['mine', 'free', 'approved', 'done', 'spiked'], 'no With others');
  eq([$('publishSection').hidden, acts($('publishBar'))], [false, []], 'the status bar, with no Publish now and no Retry');
  eq([btn('approve', ids.outside), $('lanes').textContent.includes('an editor or an owner approves it')], [null, true], 'no Approve on outside links, and the reason');
  eq([btn('edit', ids.held) !== null, btn('withdraw', ids.waiting) !== null, btn('withdraw', ids.byEditor), btn('reopen', ids.spiked)], [true, true, null, null], "edits what it holds, withdraws its own approval but not an editor's, cannot reopen");
  eq($('peopleSection').hidden, true, 'no People panel');
  await click(btn('spike', ids.held));
  eq([server.calls.find((c) => c.name === 'drafts:spike').args, row(ids.held).status], [{ draftId: ids.held, expectedRev: 1 }, 'spiked'], 'Spike sends the draft and its rev, and no note');
});

await section('a submitter: only their own stories, and only their controls', async () => {
  const ids = await world();
  const from = await start(SUBMITTER);
  const drafts = new Set(all('article[data-draft]').map((a) => a.dataset.draft));
  eq([drafts.has(ids.own), drafts.has(ids.xss), drafts.has(ids.plain), drafts.has(ids.held)], [false, false, true, true], "another person's stories are not on their desk, and their own held by a reviewer are");
  eq(all('[data-draft]', $('lanes').querySelector('[data-lane="others"]')).some((n) => n.dataset.draft === ids.held), true, 'in With others');
  const lanesMod = await import('../js/desk-lanes.js');
  const theirs = { status: 'pending', mine: false, assignee: null, external: false, linkChecks: null, linkOverride: null };
  eq(Object.entries(lanesMod.allowed(theirs, { role: 'submitter', subject: SUBMITTER })).filter(([, v]) => v).map(([k]) => k), [], 'and on a story that is not theirs, a submitter would get no control at all');
  eq([...new Set(acts())].sort(), ['edit', 'recheck', 'spike'], 'edit, check links and spike, nothing that decides');
  eq(all('[data-act]').every((b) => row(b.dataset.draft).submittedBy === SUBMITTER), true, 'every control is on a story they submitted');
  eq([$('approveAllBtn').hidden, $('publishSection').hidden, names(from).includes('publish:status')], [true, true, false], 'no Approve all, no status bar, and publish:status is never asked');
});

await section('a new story goes out as drafts:submit', async () => {
  await world();
  await start(REVIEWER);
  await click($('newStoryBtn'));
  const form = $('newStory');
  await click(form.querySelector('[data-act="submit-new"]'));
  eq([sent('drafts:submit'), $('deskNotice').textContent], [null, 'Fix the problems listed under the form first.'], 'a story with problems is not sent');
  const set = (f, v) => { const n = form.querySelector(`[data-field="${f}"]`); n.value = v; fire(n, 'input'); };
  set('date', '2026-09-20');
  set('id', '2026-09-20-new-thing');
  set('title', 'A new thing');
  set('summary', 'It is new.');
  set('body', 'First.\n\nSecond.');
  set('links', 'Site | https://new.neorgon.com/');
  set('tags', 'new, desk');
  await click(form.querySelector('[data-act="submit-new"]'));
  eq((sent('drafts:submit') || {}).post, { id: '2026-09-20-new-thing', title: 'A new thing', date: '2026-09-20', kind: 'note', site: null, summary: 'It is new.', body: ['First.', 'Second.'], links: [{ label: 'Site', url: 'https://new.neorgon.com/' }], tags: ['new', 'desk'] }, 'the parsed post');
  eq(server.db.rows('drafts').some((d) => d.storyId === '2026-09-20-new-thing'), true, 'and it is on the desk');
});

await section('frozen, unverified, and the refresh timer', async () => {
  const ids = await world();
  process.env.DESK_FROZEN = '1';
  await start(EDITOR);
  eq($('deskBanner').textContent.includes('The desk is frozen'), true, 'a frozen desk says so');
  await click(btn('approve', ids.plain));
  eq([$('deskNotice').textContent.startsWith('The desk is frozen'), row(ids.plain).status], [true, 'pending'], 'and a refused approve is worded');
  delete process.env.DESK_FROZEN;
  await start(EDITOR, { token: 'not-a-convex-token' });
  eq($('deskBanner').dataset.state, 'unverified', 'signed in to Clerk, refused by the backend: unverified, not "signed out"');
  await start(EDITOR);
  const timer = intervals.filter((t) => t.live);
  eq([timer.length, timer[0] && timer[0].ms], [1, 60000], 'one refresh timer, every 60 s, and a stopped desk clears its own');
  let from = server.calls.length;
  document.visibilityState = 'hidden';
  timer[0].fn();
  await settle();
  eq(names(from), [], 'a hidden tab is not refreshed');
  document.visibilityState = 'visible';
  timer[0].fn();
  await settle();
  eq([names(from)[0], names(from).includes('desk:queue')], ['desk:me', true], 'a visible one is');
  from = server.calls.length;
  await focus();
  eq(names(from).includes('desk:me'), true, 'and so is a focus');
});

await section('markup in a title, a note, a label, a request or an id never becomes markup', async () => {
  written.push(...writes());
  const everything = written.map((w) => parseHtml(w));
  const handlers = everything.flatMap((t) => [t, ...t.querySelectorAll('*')]).filter((n) => Object.keys(n.attributes || {}).some((a) => a.startsWith('on')));
  eq([written.length > 50, handlers.length, everything.some((t) => t.querySelectorAll('img').length)], [true, 0, false], 'no element with an on* attribute and no <img> in any markup the desk wrote');
  eq(written.some((w) => w.includes('&lt;img src=x onerror=alert(1)&gt;')), true, 'the title, the note and the labels arrive escaped, as text');
  eq(server.errors, [], 'and every call the desk made passed the functions\' declared args');
});

if (stop) stop();
console.log(T.failed ? `\ndesk flow: ${T.failed} of ${T.checks} checks failed` : `\ndesk flow: all ${T.checks} checks pass`);
process.exit(T.failed ? 1 : 0);
