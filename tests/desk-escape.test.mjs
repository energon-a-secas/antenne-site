// Plain node, no install. Run with: make validate
//
// Story text on the desk stays text (docs/plans/2026-09-15-antenne-desk.md
// sections 1 and 7; review F11). One draft carries attribute and element
// breakouts, </textarea> included, in its title, summary, body paragraphs,
// link label and link url, and in the url of a link check. The desk draws its
// card, opens it in the editor, types the same text into the New story form,
// and then draws both forms again from what was typed. Every piece of markup
// the desk wrote on the way is swept for an <img>, a <script> or an on*
// attribute, and the text is checked to arrive exactly as written. A second
// draft, and server answers rewritten on their way to the desk, carry the same
// breakouts in the fields only the server fills: the draft id, the rev, the
// story's site, and an error code the banner repeats. Last, renderCard and the
// feed's embed are called directly with a breakout in a story id, an embed
// title and the page's own address.
//
// The escHtml calls under guard, each of which turns this red when removed
// (queue #134 swept all 36 in js/render.js and js/desk-ui.js):
// js/render.js renderCard (body paragraphs, link url, link label, the site
// chip, the story id in data-id, id and the toggle's data-id, title, summary)
// and renderEmbed (each story's link and title, the Open in Antenne link); and
// js/desk-ui.js editorHtml (the form key, input values, textareas), linkChip
// (the check's url, as title and as text), flagsHtml (a note), draftCard (the
// draft id, the story id, the rev, who holds it), actButton (draft id and rev),
// renderGate (the banner copy) and confirmDialog (its items, held by
// tests/desk-flow.test.mjs). The url fails the desk rules, so the row is written
// directly, as older code or a bug on the server could leave one: the desk
// escapes what it is sent, whatever the server let in, and the New story
// preview draws what is typed before any rule runs.
//
// Not pinned, because no input from outside the code can reach them, so a
// removal changes nothing a test could see: js/render.js renderCard's
// datetime (read mode admits only a YYYY-MM-DD date, and a row with a breakout
// date previews as not publishable, checked below); and in js/desk-ui.js
// problemsHtml (problemText looks the field and the code up in fixed tables,
// indexes as numbers), linkChip's status words (fixed words, or a number),
// draftCard's status (STATUS_TEXT) and note (blockedNote's fixed sentences),
// actButton's act and label (literals at every call), agoHtml and untilHtml
// (the words of a number of minutes), and renderGate's button ("Sign in").

import { fire, loadPage, parseHtml, writes } from './support/fakedom.mjs';
import { $, EDITOR, HTML, MIN, all, btn, checker, click, contentHash, focus, server, start, stop, world } from './support/deskflow.mjs';
import { newDraft } from '../convex/lib/draftsCore.ts';
import { postToValues } from '../js/desk-ui.js';
import { render, renderCard } from '../js/render.js';

const T = checker();
const { eq, section } = T;

const IMG = (n) => `<img src=x onerror=alert(${n})>`;
const OUT = (n) => `">${IMG(n)}`; // closes a double-quoted attribute, then its tag
const URL_EVIL = `https://a.neorgon.com/${OUT(1)}`;
const EVIL = {
  id: '2026-09-15-evil', date: '2026-09-15', kind: 'feature', site: null,
  title: `Title ${OUT(2)}`,
  summary: `Summary </textarea>${IMG(3)}`,
  body: [`First </textarea>${IMG(4)} then ${OUT(5)}`, `Second </TEXTAREA ><script>alert(6)</script> '" onmouseover="alert(7)`],
  links: [{ label: `Label </textarea>${OUT(8)}`, url: URL_EVIL }],
  tags: ['desk'],
};

/** A story read mode accepts as it stands: a valid id and date, one paragraph, no link. */
const validStory = () => ({ id: '2026-09-15-direct', date: '2026-09-15', kind: 'feature', site: null, title: 'Direct', summary: 'S', body: ['B'], links: [], tags: ['desk'] });
/** Every element in markup, the root's own children included. */
const nodesOf = (html) => parseHtml(html).querySelectorAll('*');
/** What a sweep finds: any <img> or <script>, and any attribute that starts with on. */
function sweep(markup) {
  const found = [];
  for (const html of markup) {
    for (const n of nodesOf(html)) {
      if (n.tagName === 'IMG' || n.tagName === 'SCRIPT') found.push(n.tagName);
      for (const a of Object.keys(n.attributes)) if (a.startsWith('on')) found.push(`${n.tagName} ${a}`);
    }
  }
  return found;
}
const set = (node, value) => { node.value = value; fire(node, 'input'); };

await section('a draft full of breakouts is drawn, edited and typed as a new story, and every piece stays text', async () => {
  await world();
  const draftId = await server.db.insert('drafts', {
    ...newDraft({ post: EVIL, hash: await contentHash(EVIL), external: false, source: 'machine', submittedBy: 'key:local', assignee: null, now: Date.now() - 20 * MIN }),
    linkChecks: [{ url: URL_EVIL, status: 404, blocking: false }],
  });
  await start(EDITOR);
  const lanes = $('lanes');
  const card = () => lanes.querySelector(`article[data-draft="${draftId}"]`);
  eq(card() !== null, true, 'the card is on the desk');
  const chip = card().querySelector('.desk-chip[title]');
  eq([chip && chip.getAttribute('title'), chip && chip.textContent.startsWith(URL_EVIL.replace('https://', ''))], [URL_EVIL, true], "the link check's url is the chip's title and text, as written");

  // The card's own preview, then the editor on it.
  const preview = (key) => (key === 'new' ? $('newStory') : lanes).querySelector(`[data-preview="${key}"]`);
  const previewed = (key) => {
    const box = preview(key);
    const a = box ? box.querySelector('.post__links a') : null;
    return [box ? box.querySelectorAll('.post__body p').map((p) => p.textContent) : null, a && a.getAttribute('href'), a && a.textContent];
  };
  const asWritten = [EVIL.body, URL_EVIL, `${EVIL.links[0].label} ↗`];
  eq(previewed(draftId), asWritten, "the card's preview holds the paragraphs, the link url and the link label as written");
  await click(btn('edit', draftId));
  const values = postToValues(EVIL);
  const form = (key) => (key === 'new' ? $('newStory') : lanes);
  const field = (key, name) => form(key).querySelector(`[data-form="${key}"][data-field="${name}"]`);
  const shown = (key) => ['title', 'summary', 'body', 'links'].map((name) => { const f = field(key, name); return f ? f.value : null; });
  const expected = [values.title, values.summary, values.body, values.links];
  eq(shown(draftId), expected, 'the editor holds the title, the summary, the body and the links as written');
  set(field(draftId, 'body'), values.body);
  eq(previewed(draftId), asWritten, "the editor's preview, drawn again on a keystroke, holds them as written");

  // The same text typed into New story: its preview follows each keystroke.
  await click($('newStoryBtn'));
  for (const [name, value] of Object.entries(values)) if (field('new', name)) set(field('new', name), value);
  eq(previewed('new'), asWritten, 'the New story preview holds what was typed as written');

  // Cancel the edit: the lanes redraw, and New story is drawn again from what was typed. Then the editor again.
  await click(btn('cancel-edit', draftId));
  eq(shown('new'), expected, 'New story, drawn again from what was typed, holds it as written');
  await click(btn('edit', draftId));
  eq(shown(draftId), expected, 'and so does the editor, opened again');

  const markup = writes();
  eq(markup.length > 10, true, 'the desk wrote markup for all of it');
  eq(sweep(markup), [], 'no <img>, no <script> and no on* attribute in any markup the desk wrote');
  eq(sweep([lanes.innerHTML, $('newStory').innerHTML]), [], 'nor in the lanes and New story as they stand');
  eq(markup.some((w) => w.includes('&lt;/textarea&gt;&lt;img src=x onerror=alert(4)&gt;')), true, 'a </textarea> in a paragraph arrives escaped, as text');
  eq(server.errors, [], "and every call the desk made passed the functions' declared args");
});

await section('breakouts in what only the server fills (draft id, rev, site, an error code) stay text', async () => {
  await world();
  const SITE = `x-site${OUT(10)}`;
  const shown = { ...EVIL, id: '2026-09-15-from-server', site: SITE };
  const rowId = await server.db.insert('drafts', newDraft({ post: shown, hash: await contentHash(shown), external: false, source: 'machine', submittedBy: 'key:local', assignee: null, now: Date.now() - 20 * MIN }));
  const badDate = { ...EVIL, id: '2026-09-15-bad-date', date: `2026-09-15${OUT(11)}` };
  await server.db.insert('drafts', newDraft({ post: badDate, hash: await contentHash(badDate), external: false, source: 'machine', submittedBy: 'key:local', assignee: null, now: Date.now() - 20 * MIN }));
  const [ID, REV, CODE] = [`${rowId}${OUT(12)}`, `1${OUT(13)}`, OUT(14)];
  const real = server.run;
  let failMe = false;
  server.run = async (kind, name, args, token) => {
    if (name === 'desk:me' && failMe) return { ok: false, code: CODE };
    const answer = await real(kind, name, args, token);
    if (name !== 'desk:queue' || !answer.ok) return answer;
    return { ...answer, drafts: answer.drafts.map((d) => (d.draftId === rowId ? { ...d, draftId: ID, rev: REV } : d)) };
  };
  try {
    await start(EDITOR);
    const lanes = $('lanes');
    const card = all('article[data-draft]').find((a) => a.getAttribute('data-draft') === ID);
    eq(card ? [card.querySelector('.draft__rev').textContent, card.querySelector('code.post__site').textContent] : null, [`rev ${REV}`, shown.id], "a card's data-draft holds the id as sent, and its rev reads as sent");
    const buttons = card ? card.querySelectorAll('button[data-act]') : [];
    eq([buttons.length > 0, buttons.every((b) => b.dataset.draft === ID && b.dataset.rev === REV)], [true, true], "every button on it carries the id and the rev as sent");
    eq(all('[data-preview] .post__site', lanes).map((n) => n.textContent).includes(SITE), true, "the preview's site chip reads as stored");
    const dated = all('article[data-draft]').find((a) => a.querySelector('code.post__site')?.textContent === badDate.id);
    eq(dated ? dated.querySelector('[data-preview]').textContent.startsWith('Not publishable yet') : null, true, 'a stored date that is not YYYY-MM-DD previews as not publishable, never through renderCard');
    const edit = card ? card.querySelectorAll('[data-act="edit"]')[0] : null;
    eq(!!edit, true, 'the editor can open on it');
    if (edit) await click(edit);
    const form = all('[data-editor]').find((n) => n.getAttribute('data-editor') === ID);
    eq(form ? form.querySelectorAll('[data-field]').every((f) => f.getAttribute('data-form') === ID) : null, true, "the editor's form key is the id as sent, on every field");
    failMe = true;
    await focus();
    eq([$('deskBanner').dataset.state, $('deskBanner').textContent], ['error', `The desk refused that (${CODE}).`], 'an error code the desk does not know is repeated in the banner as text');
  } finally {
    server.run = real;
  }
  eq(sweep(writes()), [], 'no <img>, no <script> and no on* attribute in any markup the desk wrote');
});

await section('renderCard and the embed, called directly: a story id, an embed title and the page address stay text', async () => {
  const card = renderCard({ ...validStory(), id: `2026-09-15-direct${OUT(15)}` }, { open: true });
  const article = parseHtml(card).querySelector('article');
  eq([sweep([card]), article.getAttribute('data-id'), article.getAttribute('id'), article.querySelector('.post__toggle').getAttribute('data-id')],
    [[], `2026-09-15-direct${OUT(15)}`, `post-2026-09-15-direct${OUT(15)}`, `2026-09-15-direct${OUT(15)}`], 'the id in data-id, id and the toggle stays one attribute value each');
  if (stop) stop(); // the desk's listeners come off its page before the embed gets one of its own
  loadPage('<main id="main"></main>');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  // No browser hands over a path with a raw quote or bracket; this one stands in for one, so the escape is what holds.
  const page = { origin: 'https://antenne.neorgon.com', pathname: `/embed${OUT(16)}` };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: page });
  try {
    const story = { ...validStory(), title: `Embed ${OUT(17)}` };
    render({ embed: true, brand: false, limit: 5, posts: [story] });
    const main = document.getElementById('main');
    const full = page.origin + page.pathname;
    const links = main.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.textContent]);
    eq([sweep([main.innerHTML]), links], [[], [[`${full}#p=${story.id}`, story.title], [full, 'Open in Antenne ↗']]], "the embed's story link, its title and the Open in Antenne link stay text");
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
    loadPage(HTML);
  }
});

if (stop) stop();
console.log(T.failed ? `\ndesk escape: ${T.failed} of ${T.checks} checks failed` : `\ndesk escape: all ${T.checks} checks pass`);
process.exit(T.failed ? 1 : 0);
