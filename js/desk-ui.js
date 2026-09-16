// ── Desk rendering + events ──────────────────────────────────
// Form fields write straight into the overlay (parsed to canonical
// types), so effectivePost() is always the merge of file + edits.
// Only the preview re-renders while typing, never the form itself.

import {
  desk, draftId, effectivePost, verdict, setVerdict, setEdit,
  approvedPosts, publish, docJson, resetOverlay, PUBLISH_TARGET,
} from './desk.js';
import { renderCard } from './render.js';
import { KINDS, KIND_LABELS } from './data.js';
import { $, escHtml, fmtDate, showToast } from './utils.js';

const bodyToText = (body) => (Array.isArray(body) ? body.join('\n\n') : '');
const textToBody = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const linksToText = (links) => (Array.isArray(links)
  ? links.map((l) => l.label + ' | ' + l.url).join('\n') : '');
const textToLinks = (text) => text.split('\n').map((line) => {
  const i = line.indexOf('|');
  if (i === -1) return null;
  return { label: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
}).filter((l) => l && l.label && l.url);
const tagsToText = (tags) => (Array.isArray(tags) ? tags.join(', ') : '');
const textToTags = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);

const PARSERS = {
  title: (v) => v,
  date: (v) => v,
  kind: (v) => v,
  site: (v) => (v.trim() ? v.trim() : null),
  summary: (v) => v,
  body: textToBody,
  links: textToLinks,
  tags: textToTags,
};

function field(file, name, label, control) {
  const wide = name === 'summary' || name === 'body' || name === 'links';
  return '<div class="draft__field' + (wide ? ' draft__field--wide' : '') + '">'
    + '<label for="f-' + file + '-' + name + '">' + label + '</label>' + control + '</div>';
}

function draftCard(d) {
  const o = desk.overlay[draftId(d)] || {};
  const v = Object.assign({}, d.raw, o.edits || {});
  const status = verdict(d);
  const fid = (n) => 'f-' + escHtml(d.file) + '-' + n;
  const attr = (n) => 'id="' + fid(n) + '" data-file="' + escHtml(d.file) + '" data-field="' + n + '"';
  return '<article class="card draft draft--' + status + '" data-draft="' + escHtml(d.file) + '">'
    + '<div class="post__meta">'
    + '<code class="post__site">' + escHtml(d.file) + '</code>'
    + '<span class="draft__status">' + status + '</span>'
    + '</div>'
    + '<div class="draft__grid">'
    + field(escHtml(d.file), 'title', 'Title',
      '<input type="text" ' + attr('title') + ' value="' + escHtml(v.title || '') + '">')
    + field(escHtml(d.file), 'date', 'Date',
      '<input type="date" ' + attr('date') + ' value="' + escHtml(v.date || '') + '">')
    + field(escHtml(d.file), 'kind', 'Kind',
      '<select ' + attr('kind') + '>' + KINDS.map((k) =>
        '<option value="' + k + '"' + (v.kind === k ? ' selected' : '') + '>'
        + KIND_LABELS[k] + '</option>').join('') + '</select>')
    + field(escHtml(d.file), 'site', 'Site (blank = fleet-wide)',
      '<input type="text" ' + attr('site') + ' value="' + escHtml(v.site || '') + '" placeholder="floorplan-site">')
    + field(escHtml(d.file), 'tags', 'Tags (comma separated)',
      '<input type="text" ' + attr('tags') + ' value="' + escHtml(tagsToText(v.tags)) + '">')
    + field(escHtml(d.file), 'summary', 'Summary',
      '<textarea ' + attr('summary') + '>' + escHtml(v.summary || '') + '</textarea>')
    + field(escHtml(d.file), 'body', 'Body (blank line between paragraphs)',
      '<textarea ' + attr('body') + '>' + escHtml(bodyToText(v.body)) + '</textarea>')
    + field(escHtml(d.file), 'links', 'Links (one per line: Label | https://url)',
      '<textarea ' + attr('links') + '>' + escHtml(linksToText(v.links)) + '</textarea>')
    + '</div>'
    + '<div class="toolbar">'
    + '<button type="button" class="btn btn--secondary btn--sm" data-approve="' + escHtml(d.file) + '">'
    + (status === 'approved' ? 'Withdraw approval' : 'Approve') + '</button>'
    + '<button type="button" class="btn btn--ghost btn--sm" data-reject="' + escHtml(d.file) + '">'
    + (status === 'rejected' ? 'Restore' : 'Spike') + '</button>'
    + '</div>'
    + '<div class="draft__preview">'
    + '<p class="draft__preview-label">Preview</p>'
    + '<div data-preview="' + escHtml(d.file) + '">' + previewHtml(d) + '</div>'
    + '</div>'
    + '</article>';
}

function previewHtml(d) {
  const post = effectivePost(d);
  if (!post) {
    return '<div class="feed-empty card">Not publishable yet: a story needs an id, '
      + 'a title, a YYYY-MM-DD date, and a valid kind.</div>';
  }
  return renderCard(post, { open: true });
}

function banner() {
  if (!desk.manifestOk) {
    return 'No drafts here. Drafts live in <code>data/drafts/</code>, which never '
      + 'gets committed, so the public site has nothing to show. On your machine, '
      + 'run <code>/newsroom</code> in Claude Code to draft stories from recent '
      + 'fleet work, then reload this page.';
  }
  if (!desk.drafts.length) {
    return 'The drafts folder is empty. Run <code>/newsroom</code> to draft new '
      + 'stories, then reload.';
  }
  const n = desk.drafts.length;
  return n + (n === 1 ? ' draft waits' : ' drafts wait') + ' for a verdict. Edit '
    + 'in place, approve what should ship, spike what should not, then publish.';
}

function refreshBar() {
  const ok = approvedPosts().length;
  $('publishBar').hidden = !desk.drafts.length;
  if (!desk.publishedOk) {
    $('publishCount').textContent = 'data/posts.json failed to load; publishing is off so the archive cannot be overwritten';
  } else {
    $('publishCount').textContent = ok
      ? ok + (ok === 1 ? ' story' : ' stories') + ' approved and ready'
      : 'Nothing approved yet';
  }
  $('publishBtn').disabled = !ok || !desk.publishedOk;
  $('copyJsonBtn').disabled = !desk.publishedOk;
}

export function renderDesk() {
  $('deskBanner').innerHTML = banner();
  $('draftsSection').hidden = !desk.manifestOk || !desk.drafts.length;
  $('drafts').innerHTML = desk.drafts.map(draftCard).join('');
  $('published').innerHTML = !desk.publishedOk
    ? '<li>data/posts.json failed to load. Fix the file and reload; publishing stays disabled until it parses.</li>'
    : desk.published.length
      ? desk.published.map((p) =>
          '<li><time datetime="' + escHtml(p.date) + '">' + fmtDate(p.date) + '</time>'
          + '<span>' + escHtml(p.title) + '</span></li>').join('')
      : '<li>Nothing published yet.</li>';
  refreshBar();
  bindOnce();
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;

  $('drafts').addEventListener('input', (e) => {
    const el = e.target;
    const file = el.dataset.file;
    const fieldName = el.dataset.field;
    if (!file || !fieldName) return;
    const d = desk.drafts.find((x) => x.file === file);
    if (!d) return;
    setEdit(d, fieldName, PARSERS[fieldName](el.value));
    const preview = document.querySelector('[data-preview="' + CSS.escape(file) + '"]');
    if (preview) preview.innerHTML = previewHtml(d);
    refreshBar();
  });

  $('drafts').addEventListener('click', (e) => {
    const approve = e.target.closest('[data-approve]');
    const reject = e.target.closest('[data-reject]');
    if (!approve && !reject) return;
    const file = approve ? approve.dataset.approve : reject.dataset.reject;
    const d = desk.drafts.find((x) => x.file === file);
    if (!d) return;
    if (approve && verdict(d) !== 'approved' && !effectivePost(d)) {
      showToast('Fix the highlighted fields first: this draft is not publishable.');
      return;
    }
    setVerdict(d, approve ? 'approved' : 'rejected');
    renderDesk();
  });

  $('publishBtn').addEventListener('click', () => publish());

  $('copyJsonBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(docJson());
      // Same reason as the publish toast: the copy is only worth anything in
      // one file, so name it rather than leaving the operator to remember.
      showToast(`Copied. It goes in ${PUBLISH_TARGET}, nothing else is read.`, 6000);
    } catch { showToast('Clipboard blocked. Use Publish instead.'); }
  });

  $('resetDeskBtn').addEventListener('click', () => {
    resetOverlay();
    renderDesk();
    showToast('Desk reset: edits and verdicts cleared.');
  });
}
