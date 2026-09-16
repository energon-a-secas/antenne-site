.DEFAULT_GOAL := help

PORT = 8873

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve         Start dev server → http://localhost:$(PORT)"
	@echo "  make kill          Kill this project's HTTP server"
	@echo "  make feed          Validate posts.json, regenerate feed.xml, stamp the feed into index.html"
	@echo "  make check         Validate posts.json and that the stamped feed is current"
	@echo "  make validate      Run every test, then build-feed.py --check and --selftest (plain node and python3, no install)"
	@echo "  make test          Same as make validate"
	@echo ""

# ── Dev server ────────────────────────────────────────────────────────────────
# CORS-enabled so the hub popup on localhost:8800 can fetch data/posts.json
# cross-origin, matching what GitHub Pages sends in production.
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@PORT=$(PORT) python3 scripts/serve-cors.py

# ── Kill ──────────────────────────────────────────────────────────────────────
.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"

# ── Feed ──────────────────────────────────────────────────────────────────────
.PHONY: feed check
feed:
	@python3 scripts/build-feed.py

check:
	@python3 scripts/build-feed.py --check

# ── Validate ──────────────────────────────────────────────────────────────────
# Plain node tests/<name>.test.mjs and python3 tests/test_<name>.py scripts, one
# line each, no install. The .github/workflows/check.yml job runs this target.
.PHONY: validate test
validate:
	@node tests/post-mirror.test.mjs
	@node tests/desk-publish.test.mjs
	@node tests/data-archive.test.mjs
	@node tests/convex-access.test.mjs
	@node tests/convex-drafts.test.mjs
	@node tests/convex-members.test.mjs
	@node tests/convex-contract.test.mjs
	@python3 tests/test_build_feed.py
	@python3 scripts/build-feed.py --check
	@python3 scripts/build-feed.py --selftest

test: validate
