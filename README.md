<div align="center">

# Antenne

Fleet launches, features, and updates as a news feed

[![Live][badge-site]][url-site]
[![HTML5][badge-html]][url-html]
[![CSS3][badge-css]][url-css]
[![JavaScript][badge-js]][url-js]
[![Claude Code][badge-claude]][url-claude]
[![License][badge-license]](LICENSE)

[badge-site]:    https://img.shields.io/badge/live_site-0063e5?style=for-the-badge&logo=googlechrome&logoColor=white
[badge-html]:    https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white
[badge-css]:     https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white
[badge-js]:      https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[badge-claude]:  https://img.shields.io/badge/Claude_Code-CC785C?style=for-the-badge&logo=anthropic&logoColor=white
[badge-license]: https://img.shields.io/badge/license-MIT-404040?style=for-the-badge

[url-site]:   https://dispatch.neorgon.com/
[url-html]:   #
[url-css]:    #
[url-js]:     #
[url-claude]: https://claude.ai/code

</div>

---

## Overview

Antenne reports what shipped across the Neorgon fleet: launches, features, and
fixes as short news stories, drafted from the fleet's own work logs. Every story
passes through an approval desk before it publishes, so the feed carries what a
human decided was worth telling, not a firehose of commits. The same feed powers
an embeddable strip for the hub's corner popup and an RSS feed.

**Live:** [dispatch.neorgon.com](https://dispatch.neorgon.com/)

---

## Features

- **News feed** -- stories with kind badges (launch, feature, fix, note), a hero
  slot for the latest, filters, and full-text search
- **Approval desk** -- `desk.html` reads uncommitted drafts from `data/drafts/`,
  lets you edit and approve each one, and writes the merged `data/posts.json`
- **Embed strip** -- `?embed=1&limit=N` renders a compact headline list for
  iframes, with no storage writes and an attribution link back to the full site;
  add `&brand=0` to drop the strip's own masthead when the host chrome already
  names the site (the hub's corner popup does)
- **Chrome toggle** -- the header auto-hides while you read, and `h` hides the
  header and footer entirely
- **Deep links** -- `#p=<story-id>` opens a story directly; RSS at `feed.xml`
- **NEW markers** -- stories newer than your last visit get flagged, remembered
  per browser

---

## Publishing pipeline

```
/newsroom (Claude Code command)          desk.html (localhost)
  reads fleet git logs, plans,             edit, approve, spike
  registry, harness ledger      ──────▶    each draft
  writes data/drafts/*.json                     │ publish
        (gitignored)                            ▼
                                          data/posts.json  ──▶  make feed
                                          (committed)           feed.xml
                                                                index.html
```

Drafts never reach the repo; only approved stories do. On the public site,
`data/drafts/` 404s and the desk explains itself.

**Publish writes one path, `data/posts.json`, and nothing else is read.** The
browser's save dialog cannot be told a directory (a `suggestedName` may not carry
a separator), so the desk passes a stable picker `id` instead, which makes the
dialog reopen where it last saved, and every message names the full path rather
than the file. On 2026-09-11 it did neither: twelve approved stories went to the
repo root over a stale tracked `posts.json` nothing reads, and nothing was live
until they were copied across by hand. Wording alone cannot stop that, so
`make check` fails while a `posts.json` sits at the root
(`tests/desk-publish.test.mjs` covers the desk end, `tests/test_build_feed.py`
the other).

**The page fetches nothing: `make feed` stamps the archive into `index.html`.**
Four `<!-- gen:NAME -->` regions are filled at publish time, three of them
rendered (`edition`, `chips`, `feed`) and one the archive itself (`archive`, a
`application/json` block holding the same object as `data/posts.json`). The page
reads that block instead of fetching, so the visitor's own context (NEW markers,
an open `#p=` story, the edition line) lands in the first render rather than a
round trip later: queue #43 was that context popping in over an already-painted
page. `make check` fails while any region is stale, which is what makes the copy
safe. Two rules the stamp depends on: every `<` in the archive is written as
`\u003c` so no story can end the script element it sits in, and the `gen:archive`
markers sit *outside* that element, because a script's content is raw text and a
marker inside it would be part of the JSON the page parses.

The edition line is dated by the archive's own `updated` field, not by the
visitor's clock. `scripts/build-feed.py` `edition_line` and `js/render.js`
`editionLine` render the same string from it, and they have to agree or the date
changes once the page loads.

---

## Running locally

ES modules require an HTTP server (not `file://`):

```bash
make serve        # http://localhost:8873
make feed         # validate posts.json, regenerate feed.xml, stamp the feed and the archive into index.html
make check        # fail if either stamp is stale against posts.json
make drafts-clean # delete consumed drafts
```

---

## Architecture

![Architecture](docs/architecture.svg)

```
dispatch-site/
├── index.html          # News feed shell
├── desk.html           # Approval desk (noindex; does real work only where drafts exist)
├── feed.xml            # Generated RSS (make feed)
├── data/
│   ├── posts.json      # Published stories, the single source the feed renders
│   └── drafts/         # GITIGNORED: /newsroom output awaiting approval
├── scripts/
│   └── build-feed.py   # posts.json validator + RSS generator
├── css/
│   └── style.css       # Feed, embed strip, and desk styles
├── js/
│   ├── app.js          # Entry point, embed detection
│   ├── state.js        # Prefs + read watermark, storage-free in embed mode
│   ├── data.js         # Post schema: normalize, validate, read the stamped archive
│   ├── render.js       # Feed cards + embed strip (desk reuses renderCard)
│   ├── events.js       # Filters, search, keyboard, chrome toggle
│   ├── desk.js         # Draft loading, overlay state, publish
│   ├── desk-ui.js      # Desk forms, previews, verdicts
│   └── utils.js        # Shared helpers
├── favicon.ico
├── robots.txt          # Disallows /desk.html
├── sitemap.xml
├── CNAME
├── Makefile
└── README.md
```

---

<div align="center">
<sub>Part of <a href="https://neorgon.com/">Neorgon</a></sub>
</div>
