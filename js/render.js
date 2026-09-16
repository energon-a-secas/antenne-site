// ── DOM rendering ────────────────────────────────────────────
// Rebuilds the feed (or the embed strip) from state. renderCard is
// also imported by the desk for live draft previews.

import { escHtml, $, fmtDate, longDate } from './utils.js';
import { KIND_LABELS } from './data.js';

// scripts/build-feed.py edition_line mirrors this, dated by the archive's own
// updated field; change them together. It used to read the visitor's clock,
// which made the stamped line and the rendered line disagree on every day after
// publication, so the date visibly changed once the page loaded (queue #43).
// An edition is dated when it was published, not when it is read.
function editionLine(posts, updated) {
  const n = posts.length;
  return 'Edition of ' + (longDate(updated) || 'today') + ' · ' + n + (n === 1 ? ' story' : ' stories');
}

function siteChip(post) {
  if (!post.site) return '<span class="post__site post__site--fleet">fleet-wide</span>';
  return '<span class="post__site">' + escHtml(post.site.replace(/-site$/, '')) + '</span>';
}

/** One story card. `opts`: { open, isNew, hero }.
    scripts/build-feed.py mirrors this markup (default state: closed, not new)
    for the publish-time stamp; change them together. */
export function renderCard(post, opts = {}) {
  const open = !!opts.open;
  const cls = 'post card' + (opts.hero ? ' post--hero' : '') + (open ? ' post--open' : '');
  const bodyHtml = post.body.map((p) => '<p>' + escHtml(p) + '</p>').join('')
    + (post.links.length
      ? '<div class="post__links">' + post.links.map((l) =>
          '<a class="btn btn--ghost btn--sm" href="' + escHtml(l.url)
          + '" target="_blank" rel="noopener noreferrer">' + escHtml(l.label) + ' ↗</a>'
        ).join('') + '</div>'
      : '');
  return '<article class="' + cls + '" data-id="' + escHtml(post.id) + '" id="post-' + escHtml(post.id) + '">'
    + '<div class="post__meta">'
    + '<time datetime="' + escHtml(post.date) + '">' + fmtDate(post.date) + '</time>'
    + '<span class="badge badge--' + post.kind + '">' + KIND_LABELS[post.kind] + '</span>'
    + siteChip(post)
    + (opts.isNew ? '<span class="post__new">NEW</span>' : '')
    + '</div>'
    + '<h3 class="post__title"><button type="button" class="post__toggle" data-id="'
    + escHtml(post.id) + '" aria-expanded="' + open + '">' + escHtml(post.title) + '</button></h3>'
    + '<p class="post__summary">' + escHtml(post.summary) + '</p>'
    + '<div class="post__body"' + (open ? '' : ' hidden') + '>' + bodyHtml + '</div>'
    + '</article>';
}

function applyFilters(s) {
  const q = s.query.trim().toLowerCase();
  return s.posts.filter((p) => {
    if (s.filter !== 'all' && p.kind !== s.filter) return false;
    if (!q) return true;
    const hay = [p.title, p.summary, p.site || '', p.tags.join(' '), p.body.join(' ')]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// scripts/build-feed.py mirrors this markup (filter fixed to all) for the
// publish-time stamp; change them together.
function renderChips(s) {
  const counts = { all: s.posts.length, launch: 0, feature: 0, fix: 0, note: 0 };
  s.posts.forEach((p) => { counts[p.kind] += 1; });
  const labels = { all: 'All', launch: 'Launches', feature: 'Features', fix: 'Fixes', note: 'Notes' };
  $('feedChips').innerHTML = Object.keys(labels).map((k) =>
    '<button type="button" class="chip' + (s.filter === k ? ' chip--active' : '')
    + '" data-filter="' + k + '" aria-pressed="' + (s.filter === k) + '">' + labels[k]
    + ' <span class="chip__count">' + counts[k] + '</span></button>'
  ).join('');
}

function renderFeed(s) {
  // Not "the wire is down" any more: there is no wire to be down, the archive
  // travels inside this page, so the only way to get here is a broken publish.
  $('editionLine').textContent = s.error
    ? 'This edition was published broken'
    : editionLine(s.posts, s.updated);
  renderChips(s);
  const shown = applyFilters(s);
  const feed = $('feed');
  if (s.error) {
    // The archive is stamped into this page, so a failure here is a broken
    // publish rather than a bad connection, and reloading will not fix it. Say
    // so instead of sending the reader to their network tab, and point at the
    // feed, which is built from the same archive and is not stamped.
    feed.innerHTML = '<div class="feed-empty card">This page was published with a broken archive, '
      + 'so the stories cannot be read. <a href="feed.xml">The RSS feed</a> carries the same '
      + 'stories.</div>';
    return;
  }
  if (!shown.length) {
    feed.innerHTML = '<div class="feed-empty card">No stories match. Clear the search or pick another filter.</div>';
    return;
  }
  feed.innerHTML = shown.map((p, i) => renderCard(p, {
    open: s.openId === p.id,
    isNew: !s.embed && !!s.prevSeen && p.date > s.prevSeen,
    hero: i === 0 && s.filter === 'all' && !s.query.trim(),
  })).join('');
}

function renderEmbed(s) {
  const posts = s.posts.slice(0, s.limit);
  const full = location.origin + location.pathname;
  document.getElementById('main').innerHTML =
    '<div class="embed">'
    + (s.brand
      ? '<div class="embed__masthead"><span class="embed__brand">Antenne</span>'
        + '<span class="embed__tag">fleet news</span></div>'
      : '')
    + (posts.length
      ? '<ul class="embed__list">' + posts.map((p) =>
          '<li class="embed__item">'
          + '<span class="embed__dot embed__dot--' + p.kind + '" title="' + KIND_LABELS[p.kind] + '"></span>'
          + '<div class="embed__text">'
          + '<a class="embed__title" href="' + escHtml(full + '#p=' + p.id)
          + '" target="_blank" rel="noopener noreferrer">' + escHtml(p.title) + '</a>'
          + '<span class="embed__date">' + fmtDate(p.date) + '</span>'
          + '</div></li>'
        ).join('') + '</ul>'
      : '<div class="embed__empty">No stories yet.</div>')
    + '<a class="embed__open" href="' + escHtml(full) + '" target="_blank" rel="noopener noreferrer">'
    + 'Open in Antenne ↗</a>'
    + '</div>';
}

/** Main render function — rebuilds the UI from state. */
export function render(s) {
  if (s.embed) { renderEmbed(s); return; }
  renderFeed(s);
}
