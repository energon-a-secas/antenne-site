// Plain node, no install. Run with: make validate
//
// Story text on the desk stays text (docs/plans/2026-09-15-antenne-desk.md
// sections 1 and 7; review F11). One draft carries attribute and element
// breakouts, </textarea> included, in its title, summary, body paragraphs,
// link label and link url, and in the url of a link check. The desk draws its
// card, opens it in the editor, types the same text into the New story form,
// and then draws both forms again from what was typed. Every piece of markup
// the desk wrote on the way is swept for an <img>, a <script> or an on*
// attribute, and the text is checked to arrive exactly as written.
//
// The escHtml calls under guard, each of which turns this red when removed:
// js/render.js renderCard (body paragraphs, link url, link label), through the
// card, editor and New story previews, and js/desk-ui.js editorHtml (input
// values, textareas) and linkChip (the check's url, as title and as text). The
// url fails the desk rules, so the row is written directly, as older code or a
// bug on the server could leave one: the desk escapes what it is sent, whatever
// the server let in, and the New story preview draws what is typed before any
// rule runs.

import { fire, parseHtml, writes } from './support/fakedom.mjs';
import { $, EDITOR, MIN, btn, checker, click, contentHash, server, start, stop, world } from './support/deskflow.mjs';
import { newDraft } from '../convex/lib/draftsCore.ts';
import { postToValues } from '../js/desk-ui.js';

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

if (stop) stop();
console.log(T.failed ? `\ndesk escape: ${T.failed} of ${T.checks} checks failed` : `\ndesk escape: all ${T.checks} checks pass`);
process.exit(T.failed ? 1 : 0);
