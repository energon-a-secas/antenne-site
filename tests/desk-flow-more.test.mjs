// Plain node, no install. Run with: make validate
//
// More of the desk end to end, over the harness tests/desk-flow.test.mjs uses
// (tests/support/deskflow.mjs: the real desk.html, js/desk*.js and convex/*.ts
// wrappers over fakedb). These cases hold the desk to what stays put and what
// must not: a card open in the editor offers no Approve that would approve the
// stored text; nothing drawn for one caller survives into the next caller's
// view, whether the account changes or the role changes, and a notice for the
// last account's action never shows under the next; a failed desk:me for the
// same account hides the desk but keeps an open edit, a new story and a typed
// grant; the owner-only People panel empties when the role goes, and nothing
// asked for before then draws it again; a refresh that changed nothing keeps
// the focused control and its nodes, one that did change puts focus back on the
// same control, and a return to the tab is one refresh, not two; a due approval
// after a failed run says it waits for Retry; a stale default assignee never
// blocks the publish delay; an access request with no name on the account says
// so; and a refusal is worded for the action that got it.

import { fire, fireGlobal } from './support/fakedom.mjs';
import {
  $, ASKER, BREAK, EDITOR, MIN, OWNER, REVIEWER, STRANGER, SUBMITTER, all, btn, checker, click, contentHash, focus, hold,
  intervals, names, row, sent, server, settle, start, stop, world,
} from './support/deskflow.mjs';
import { runRow } from '../convex/lib/publishCore.ts';
import * as lanesMod from '../js/desk-lanes.js';
import * as peopleMod from '../js/desk-people.js';

const T = checker();
const { eq, section } = T;
const quiet = console.error;
const hush = () => { console.error = () => {}; };
const unhush = () => { console.error = quiet; };
const tick = async () => { const t = intervals.filter((i) => i.live); t[t.length - 1].fn(); await settle(); };
const cards = () => all('article[data-draft]').map((a) => a.dataset.draft);
const on = (draftId) => all(`[data-act][data-draft="${draftId}"]`).map((b) => b.dataset.act);

await section('a card open in the editor offers only Save, Save and approve, and Cancel, and Approve all leaves it out', async () => {
  const ids = await world();
  await start(EDITOR);
  eq($('approveAllBtn').textContent, 'Approve all shown (4)', 'four approvable before anything is opened');
  await click(btn('edit', ids.plain));
  const title = $('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`);
  title.value = 'Corrected title';
  fire(title, 'input');
  eq($('lanes').querySelector(`[data-preview="${ids.plain}"]`).textContent.includes('Corrected title'), true, 'the preview shows the edit');
  eq(on(ids.plain).sort(), ['cancel-edit', 'save', 'save-approve'], 'and the card offers no Approve, Take, Spike, Check links or Assign next to it');
  eq($('approveAllBtn').textContent, 'Approve all shown (3)', 'Approve all no longer counts the story in the editor');
  await click($('approveAllBtn'));
  const listed = all('li', $('deskDialogList')).map((li) => li.textContent);
  await click($('deskDialogConfirm'));
  const items = (sent('drafts:approveMany') || { items: [] }).items.map((i) => i.draftId);
  eq([listed.includes('Plain story'), items.includes(ids.plain), items.length, row(ids.plain).status], [false, false, 3, 'pending'], 'nor lists it, nor approves its stored text');
  eq($('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`).value, 'Corrected title', 'the editor is still open with the edit');
  await click(btn('save-approve', ids.plain));
  const r = row(ids.plain);
  eq([r.status, r.post.title, r.approvedHash === await contentHash(r.post)], ['approved', 'Corrected title', true], 'Save and approve approves the text on screen');
});

await section('an account switch clears the last caller\'s queue before the next one is read', async () => {
  const ids = await world();
  await start(EDITOR);
  const kit = globalThis.__kit;
  eq([cards().includes(ids.own), $('approveAllBtn').hidden], [true, false], "the editor's desk: another person's story, and Approve all");
  const answerMe = hold('desk:me');
  kit.switchTo(SUBMITTER);
  await settle();
  eq([$('deskBanner').dataset.state, $('lanesSection').hidden, cards()], ['loading', true, []], 'the moment the account changes, the lanes are emptied and the desk says it is loading, before desk:me answers');
  const release = hold('desk:queue');
  answerMe();
  await settle();
  eq([$('deskBanner').dataset.state, $('lanesSection').hidden], ['member', false], 'the submitter is a member, and the lanes show');
  eq([cards(), $('approveAllBtn').hidden, $('newStoryBtn').hidden], [[], true, true], "while the submitter's queue is on its way, nothing of the editor's is drawn, and no Approve all");
  release();
  await settle();
  eq([cards().includes(ids.plain), cards().includes(ids.own)], [true, false], "then the submitter's own queue, and only that");
});

await section('an open editor and a failing queue never keep one caller\'s stories for the next', async () => {
  const ids = await world();
  await start(EDITOR);
  const kit = globalThis.__kit;
  await click(btn('edit', ids.own));
  eq(all(`[data-form="${ids.own}"]`).length > 0, true, 'the editor has a story open');
  hush();
  server.fail.add('desk:queue');
  kit.switchTo(SUBMITTER);
  await settle();
  await focus();
  await tick();
  unhush();
  eq([$('deskBanner').dataset.state, cards(), all('[data-form]').length, $('approveAllBtn').hidden], ['member', [], 0, true], "with the submitter's queue failing, the editor's stories and open form are gone, not left in place");
  server.fail.delete('desk:queue');
  await focus();
  eq([cards().includes(ids.plain), cards().includes(ids.own)], [true, false], 'and once it answers, the submitter sees their own');
});

await section('a failing desk:me hides the desk, and the next account starts from empty', async () => {
  await world();
  await start(OWNER);
  const kit = globalThis.__kit;
  const drawn = () => [cards().length > 0, ...['publishBar', 'deskAccount', 'people'].map((id) => $(id).innerHTML !== '')];
  eq(drawn(), [true, true, true, true], 'an owner with lanes, a status bar, an account readout and People');
  hush();
  server.fail.add('desk:me');
  await focus();
  unhush();
  eq([$('deskBanner').dataset.state, ...['accountSection', 'lanesSection', 'publishSection', 'peopleSection'].map((id) => $(id).hidden)],
    ['error', true, true, true, true], 'desk:me failing says so and hides every section');
  server.fail.delete('desk:me');
  const answerMe = hold('desk:me');
  kit.switchTo(EDITOR);
  await settle();
  eq([$('deskBanner').dataset.state, ...drawn()], ['loading', false, false, false, false], "the moment the account changes, the owner's lanes, bar, account and People are emptied, before desk:me answers");
  const release = hold('desk:queue');
  answerMe();
  await settle();
  eq([$('deskBanner').dataset.state, cards()], ['member', []], 'the next account to pass desk:me sees no lanes until its own queue answers');
  release();
  await settle();
});

await section('a failed desk:me for the same account keeps unsaved work: an open edit, a new story, a typed grant', async () => {
  const ids = await world();
  await start(OWNER);
  const edit = () => $('lanes').querySelector(`[data-form="${ids.plain}"][data-field="title"]`);
  const fresh = () => $('newStory').querySelector('[data-form="new"][data-field="title"]');
  const grant = () => $('people').querySelector('[data-form="grant"] [name="subject"]');
  await click(btn('edit', ids.plain));
  edit().value = 'A long careful correction';
  fire(edit(), 'input');
  await click($('newStoryBtn'));
  fresh().value = 'My half-written story';
  fire(fresh(), 'input');
  grant().value = 'user_2typedbyowner';
  fire(grant(), 'input');
  hush();
  server.fail.add('desk:me');
  await focus();
  unhush();
  eq($('deskBanner').dataset.state, 'error', 'one desk:me fails, as on a dropped connection or a laptop waking');
  server.fail.delete('desk:me');
  await focus();
  eq([$('deskBanner').dataset.state, $('lanesSection').hidden, $('peopleSection').hidden], ['member', false, false], 'the next answers for the same owner, and the desk shows again');
  eq(edit() && edit().value, 'A long careful correction', 'the story open in the editor keeps its text');
  eq(fresh() && fresh().value, 'My half-written story', 'the new story keeps its text');
  eq(grant() && grant().value, 'user_2typedbyowner', 'the grant form keeps the account id typed into it');
});

await section("a notice for the last account's action never shows under the next account", async () => {
  const ids = await world();
  await start(EDITOR);
  const kit = globalThis.__kit;
  await click(btn('approve', ids.plain));
  eq($('deskNotice').textContent.startsWith('Approved "Plain story".'), true, 'the editor is told the approval went through');
  kit.switchTo(SUBMITTER);
  await settle();
  eq($('deskNotice').textContent, '', 'the next account finds the line empty');
  kit.switchTo(EDITOR);
  await settle();
  const took = hold('drafts:take');
  fire(btn('take', ids.xss), 'click');
  await settle();
  kit.switchTo(SUBMITTER);
  await settle();
  took();
  await settle();
  eq([row(ids.xss).assignee, $('deskNotice').textContent], [EDITOR, ''], "the editor's Take, answered once the submitter is signed in, says nothing under them");
  kit.switchTo(EDITOR);
  await settle();
  const spiked = hold('drafts:spike');
  fire(btn('spike', ids.outside), 'click');
  await settle();
  const member = server.db.rows('members').find((m) => m.subject === EDITOR);
  await server.db.patch('members', member._id, { role: 'reviewer' });
  await focus();
  spiked();
  await settle();
  eq($('deskNotice').textContent, 'Spiked "Links elsewhere".', 'the same account keeps its notice through a refresh, even one that changed its role');
});

await section('a role that changes clears the lanes first, and a load cut short by clear() draws nothing', async () => {
  const ids = await world();
  await start(EDITOR);
  eq(all('[data-lane]').map((l) => l.dataset.lane).includes('others'), true, 'an editor has With others');
  const member = server.db.rows('members').find((m) => m.subject === EDITOR);
  await server.db.patch('members', member._id, { role: 'reviewer' });
  const release = hold('desk:queue');
  await focus();
  eq([all('[data-lane]').length, cards().includes(ids.outside)], [0, false], "the editor's lanes are gone before the reviewer's queue answers");
  release();
  await settle();
  eq(all('[data-lane]').map((l) => l.dataset.lane).includes('others'), false, 'then the reviewer\'s lanes, with no With others');
  const ctx = { me: { ok: true, signedIn: true, subject: REVIEWER, role: 'reviewer' }, gen: 99, call: (name) => server.run('query', name, {}, `tok:${REVIEWER}`) };
  const open = hold('desk:queue');
  const late = lanesMod.load(ctx);
  await settle();
  lanesMod.clear();
  open();
  await late;
  eq(cards(), [], 'a queue asked for before clear() and answered after it is dropped');
});

await section('a refresh that changed nothing keeps focus and nodes; one that did puts focus back on the same control', async () => {
  const ids = await world();
  await start(EDITOR);
  const take = btn('take', ids.xss);
  take.focus();
  const [lanes, bar, banner] = [$('lanes').children[0], $('publishBar').children[0], $('deskBanner').children[0]];
  const from = server.calls.length;
  await tick();
  eq([names(from).includes('desk:queue'), names(from).includes('publish:status')], [true, true], 'the 60 s tick asked for the queue and the bar again');
  eq([document.activeElement === take, $('lanes').contains(take)], [true, true], 'the focused Take button is the same node, still in the page');
  eq([$('lanes').children[0] === lanes, $('publishBar').children[0] === bar, $('deskBanner').children[0] === banner], [true, true, true], 'and the lanes, the status bar and the banner kept their nodes');
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * MIN;
  try { await tick(); } finally { Date.now = realNow; }
  eq([$('lanes').contains(take), $('lanes').textContent.includes('Submitted 33 min ago')], [true, true], 'minutes later the times move on in place, and the nodes stay');
  await server.db.patch('drafts', ids.plain, { rev: 2, updatedAt: Date.now() });
  await tick();
  const now = document.activeElement;
  eq([$('lanes').contains(take), now.dataset.act, now.dataset.draft, $('lanes').contains(now)], [false, 'take', ids.xss, true], 'when another story changed, the lanes are redrawn and focus is on the same Take button');
  const publishNow = $('publishBar').querySelector('[data-act="publish-now"]');
  publishNow.focus();
  await focus();
  eq(document.activeElement === publishNow, true, 'a window focus refresh keeps Publish now focused');
  const taking = btn('take', ids.xss);
  taking.focus();
  await click(taking);
  eq([document.activeElement.tagName, document.activeElement.dataset.draft, document.activeElement.getAttribute('tabindex')], ['ARTICLE', ids.xss, '-1'], 'after Take, whose button goes, focus moves to that story\'s card, not the page body');
  await start(null);
  const signIn = $('deskBanner').querySelector('[data-act="sign-in"]');
  signIn.focus();
  await tick();
  eq(document.activeElement === signIn, true, "a signed-out visitor's Sign in keeps focus across the tick");
});

await section('a return to the tab, which fires visibilitychange and focus, sends one refresh', async () => {
  await world();
  await start(EDITOR);
  const count = (from) => ['desk:me', 'desk:queue', 'publish:status'].map((n) => names(from).filter((x) => x === n).length);
  let from = server.calls.length;
  fireGlobal('document', 'visibilitychange');
  fireGlobal('window', 'focus');
  await settle();
  eq(count(from), [1, 1, 1], 'one desk:me, one queue and one status bar read, not two of each');
  from = server.calls.length;
  fireGlobal('window', 'focus');
  fireGlobal('document', 'visibilitychange');
  await settle();
  eq(count(from), [1, 1, 1], 'in either order');
  from = server.calls.length;
  await focus();
  await focus();
  eq(count(from), [2, 2, 2], 'two returns to the tab, one after the other, are two refreshes');
  const stuck = hold('desk:me');
  from = server.calls.length;
  fireGlobal('window', 'focus');
  await settle();
  const realNow = Date.now;
  Date.now = () => realNow() + 11000;
  try { fireGlobal('window', 'focus'); await settle(); } finally { Date.now = realNow; }
  eq(count(from)[0], 2, 'a desk:me still unanswered after 10 s no longer holds the next refresh back');
  stuck();
  await settle();
});

await section('Assign: a pick is sent by the Assign button, focus stays on it, and a refusal names the person, not a typo', async () => {
  const ids = await world();
  await start(EDITOR);
  const select = () => all(`select[data-act="assign"][data-draft="${ids.plain}"]`)[0];
  select().value = REVIEWER;
  fire(select(), 'change');
  await settle();
  const from = server.calls.length;
  const before = select();
  await server.db.patch('drafts', ids.outside, { rev: 2, updatedAt: Date.now() });
  await tick();
  eq([names(from).includes('drafts:assign'), select() !== before, select().value], [false, true, REVIEWER], 'a pick survives a refresh that redrew the lanes, and sends nothing');
  const go = btn('assign-go', ids.plain);
  go.focus();
  await click(go);
  eq([sent('drafts:assign'), row(ids.plain).assignee], [{ draftId: ids.plain, expectedRev: 1, assignee: REVIEWER }, REVIEWER], 'Assign sends it');
  eq([document.activeElement.dataset.act, document.activeElement.dataset.draft], ['assign-go', ids.plain], 'and focus is back on the Assign button of that story');
  const pick = all(`select[data-act="assign"][data-draft="${ids.xss}"]`)[0];
  pick.value = REVIEWER;
  fire(pick, 'change');
  await server.db.delete('members', server.db.rows('members').find((m) => m.subject === REVIEWER)._id);
  await click(btn('assign-go', ids.xss));
  eq([row(ids.xss).assignee, $('deskNotice').textContent], [null, 'That person can no longer hold stories. The desk reloaded the list: pick someone else.'], 'assigning someone revoked since the list loaded says so');
});

await section('settings: a revoked default assignee is labelled, and never blocks saving the delay', async () => {
  await world();
  await server.db.insert('settings', { key: 'desk', defaultAssignee: REVIEWER, publishDelayMs: 300000, updatedBy: OWNER, updatedAt: Date.now() });
  await server.db.delete('members', server.db.rows('members').find((m) => m.subject === REVIEWER)._id);
  await start(OWNER);
  const form = $('people').querySelector('[data-form="settings"]');
  const chosen = form.querySelectorAll('option').find((o) => o.hasAttribute('selected'));
  eq(chosen && [chosen.value, chosen.textContent], [REVIEWER, `${REVIEWER} (can no longer hold stories)`], 'the stored default shows as someone who can no longer hold stories');
  form.querySelector('[name="delay"]').value = '12';
  await click(form.querySelector('button[type="submit"]'));
  eq([sent('settings:update'), server.db.rows('settings')[0].publishDelayMs, $('deskNotice').textContent], [{ publishDelayMs: 720000 }, 720000, 'Settings saved.'], 'changing only the delay sends only the delay, and it is saved');
  const again = $('people').querySelector('[data-form="settings"]');
  again.querySelector('[name="defaultAssignee"]').value = EDITOR;
  await server.db.delete('members', server.db.rows('members').find((m) => m.subject === EDITOR)._id);
  await click(again.querySelector('button[type="submit"]'));
  eq([sent('settings:update'), $('deskNotice').textContent], [{ defaultAssignee: EDITOR, publishDelayMs: 720000 }, 'That person can no longer hold stories: pick someone else as the default assignee, or Nobody.'], 'picking someone revoked meanwhile is refused in words about the default assignee');
});

await section('after a failed run a due approval says it waits for Retry, and Retry puts it back to due', async () => {
  const ids = await world();
  await server.db.patch('drafts', ids.byEditor, { publishAfter: Date.now() - MIN });
  await server.db.insert('publishRuns', runRow('approve', Date.now() - 20 * MIN, Date.now() - 20 * MIN, { state: 'failed', error: 'attempts', attempts: 5 }));
  await start(EDITOR);
  const card = () => $('lanes').querySelector(`[data-lane="approved"] [data-draft="${ids.byEditor}"]`).textContent;
  eq(card().includes('Waiting: the last publish run failed, so this goes out once an owner or an editor presses Retry'), true, 'the due approval waits for Retry');
  await click($('publishBar').querySelector('[data-act="retry"]'));
  eq([sent('publish:retry'), card().includes('Due: it goes out with the next publish run')], [{}, true], 'after Retry the newest run has not failed, and it is due again');
  await start(SUBMITTER);
  eq($('lanes').querySelector(`[data-draft="${ids.byEditor}"] .draft__when`).textContent, 'Due: it goes out with the next publish run', 'a submitter, who never reads the bar, keeps the plain wording');
});

await section('the access request limit is worded as a daily limit, with the wait in hours', async () => {
  await world();
  const now = Date.now();
  for (const ago of [70, 65, 60]) await server.db.insert('rateEvents', { bucket: `${STRANGER}|access.request`, at: now - ago * MIN });
  await start(STRANGER);
  await click($('deskAccount').querySelector('form button[type="submit"]'));
  eq($('deskNotice').textContent, 'At most 3 access requests a day. Try again in 23 hours.', 'a fourth request in a day is told so, not about the last hour');
});

await section('the People panel empties when the role goes, and nothing asked for before then draws it again', async () => {
  await world();
  await start(OWNER);
  const kit = globalThis.__kit;
  const owners = process.env.DESK_OWNERS;
  const panel = () => [$('peopleSection').hidden, $('people').querySelector('[data-form="grant"]') !== null];
  eq(panel(), [false, true], 'an owner has the People panel');
  try {
    const list = hold('members:list');
    await focus();
    process.env.DESK_OWNERS = 'user_someone_else';
    await focus();
    eq([$('deskBanner').dataset.state, $('peopleSection').hidden, $('people').innerHTML], ['no-role', true, ''], 'the owner role is gone: the panel is emptied, not only hidden');
    list();
    await settle();
    eq($('people').innerHTML, '', 'and the members:list answer asked for while they were an owner draws nothing');
    process.env.DESK_OWNERS = owners;
    await focus();
    eq(panel(), [false, true], 'with the role back, so is the panel');
    const late = hold('desk:me');
    await focus();
    process.env.DESK_OWNERS = 'user_someone_else';
    kit.switchTo(OWNER);
    await settle();
    eq([$('deskBanner').dataset.state, $('people').innerHTML], ['no-role', ''], 'a newer desk:me, for the same account, says the role went');
    late();
    await settle();
    eq([$('deskBanner').dataset.state, $('people').innerHTML], ['no-role', ''], 'so an older one, asked for while they were an owner and answered after, changes nothing');
  } finally {
    process.env.DESK_OWNERS = owners;
  }
});

await section('People loaded for a caller without members.manage empties the panel and asks nothing', async () => {
  await world();
  await start(OWNER);
  const as = (subject, role) => ({ me: { ok: true, signedIn: true, subject, role }, gen: 7, call: (name) => server.run('query', name, {}, `tok:${subject}`) });
  const held = hold('members:list');
  const late = peopleMod.load(as(OWNER, 'owner'));
  await settle();
  const from = server.calls.length;
  await peopleMod.load(as(EDITOR, 'editor'));
  eq([$('people').innerHTML, names(from)], ['', []], 'an editor gets an empty panel, and nothing is asked');
  held();
  await late;
  eq($('people').innerHTML, '', "and an owner's load still on its way draws nothing");
});

await section('an access request with no name on the account says so, and Grant a role leaves the label to type', async () => {
  await world();
  await server.db.insert('accessRequests', { subject: 'user_noname', label: '', email: null, note: null, requestedAt: Date.now() - MIN });
  await start(OWNER);
  const nameOf = (subject) => $('people').querySelector(`[data-act="use-request"][data-subject="${subject}"]`).closest('li').querySelector('strong').textContent;
  eq([nameOf('user_noname'), nameOf(ASKER)], ['No name on the account', `Asker ${BREAK}`], 'the request says there is no name, not an empty one; a named request keeps its name');
  await click($('people').querySelector('[data-act="use-request"][data-subject="user_noname"]'));
  const field = (name) => $('people').querySelector(`[data-form="grant"] [name="${name}"]`);
  eq([field('subject').value, field('label').value], ['user_noname', ''], 'Grant a role fills the account id and leaves the label for the owner to type');
});

await section('a new story refused at the pending cap says so, not that access requests are full', async () => {
  await world();
  const mine = server.db.rows('drafts').filter((d) => d.submittedBy === SUBMITTER && d.status === 'pending');
  const [model] = mine;
  for (let i = mine.length; i < 20; i += 1) {
    const { _id, _creationTime, ...rest } = model;
    const id = `2026-09-15-cap-${i}`;
    await server.db.insert('drafts', { ...rest, storyId: id, post: { ...rest.post, id } });
  }
  await start(SUBMITTER);
  await click($('newStoryBtn'));
  const form = $('newStory');
  const set = (f, v) => { const n = form.querySelector(`[data-field="${f}"]`); n.value = v; fire(n, 'input'); };
  set('date', '2026-09-20');
  set('id', '2026-09-20-one-too-many');
  set('title', 'One too many');
  set('summary', 'It waits.');
  set('body', 'First.');
  set('tags', 'desk');
  await click(form.querySelector('[data-act="submit-new"]'));
  eq($('deskNotice').textContent, 'You already have 20 stories waiting on the desk. Submit this one once a reviewer decides one of them.', 'the per-person cap is named, with the number the server sent');
  eq(server.db.rows('drafts').some((d) => d.storyId === '2026-09-20-one-too-many'), false, 'and nothing was added');
});

if (stop) stop();
console.log(T.failed ? `\ndesk flow (more): ${T.failed} of ${T.checks} checks failed` : `\ndesk flow (more): all ${T.checks} checks pass`);
process.exit(T.failed ? 1 : 0);
