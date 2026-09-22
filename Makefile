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
	@echo "  Owner steps (they reach Convex or GitHub; nothing in make validate runs them):"
	@echo "  make convex        npx convex dev, refused while .env.local selects production"
	@echo "  make deploy        npx convex deploy: push convex/ to production"
	@echo "  make publish-now   Run the publish workflow on GitHub now"
	@echo "  make publish-dryrun  Run it as a dry run: merge and build, push nothing, release the claim"
	@echo "  make status        The desk queue by id and age, and the last publish run"
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
	@node tests/desk-api.test.mjs
	@node tests/desk-flow.test.mjs
	@node tests/desk-flow-more.test.mjs
	@node tests/desk-escape.test.mjs
	@node tests/data-archive.test.mjs
	@node tests/convex-access.test.mjs
	@node tests/convex-drafts.test.mjs
	@node tests/convex-members.test.mjs
	@node tests/convex-contract.test.mjs
	@node tests/convex-submit.test.mjs
	@node tests/convex-publish.test.mjs
	@node tests/convex-publish-wired.test.mjs
	@python3 tests/test_build_feed.py
	@python3 tests/test_sign.py
	@python3 tests/test_submit_drafts.py
	@python3 tests/test_publish_approved.py
	@python3 scripts/build-feed.py --check
	@python3 scripts/build-feed.py --selftest

test: validate

# ── Owner steps: Convex and GitHub ────────────────────────────────────────────
# Each of these reaches a deployment or a repository, so none is part of make
# validate, and no implementing agent runs them (docs/plans/2026-09-15-antenne-desk.md
# sections 1 and 9). Recipes use neither $(MAKE) nor a leading +, so
# `make -n publish-dryrun` (scripts/setup-antenne.sh stage 12) only prints.
.PHONY: convex deploy publish-now publish-dryrun status

# Owner step. npx convex dev pushes this folder's code to whichever deployment
# it selects. After setup-antenne.sh stage 2, .env.local selects production
# (CONVEX_DEPLOYMENT=prod:<name>), so this refuses that, a prod deployment in
# the shell's CONVEX_DEPLOYMENT, or a prod deploy key, rather than push
# unreviewed code to the live desk. Any prod line refuses, even one a later
# line overrides. Point .env.local at a dev deployment to use it.
convex:
	@if grep -Eqs '^[[:space:]]*(export[[:space:]]+)?CONVEX_DEPLOYMENT[[:space:]]*=[[:space:]]*[^[:alnum:]]?prod:' .env.local \
	  || case "$$CONVEX_DEPLOYMENT" in prod:*) true;; *) false;; esac \
	  || case "$$CONVEX_DEPLOY_KEY" in prod:*) true;; *) false;; esac; then \
	  echo "make convex refuses to run: it would push this folder's code to the production deployment that .env.local or the shell selects, so use make deploy for production or point .env.local at a dev deployment." >&2; \
	  exit 1; \
	fi
	npx convex dev

# Owner step: push convex/ to the production deployment, the command
# setup-antenne.sh stage 3 runs behind a confirm.
deploy:
	npx convex deploy

# Owner step: dispatch .github/workflows/publish.yml on main. It publishes the
# approvals that are due; Convex dispatches it by itself after an approval.
publish-now:
	gh workflow run publish.yml

# Owner step (setup-antenne.sh stage 12 runs it): the same workflow as a dry
# run. It claims, merges and builds, then releases the claim with reason
# dry-run and pushes nothing.
publish-dryrun:
	gh workflow run publish.yml -f dry_run=true

# Owner step: the queue by id and age, and the last publish run, over the
# signed /status route (ANTENNE_KEY, else ~/.config/antenne/submit-key).
status:
	python3 scripts/submit-drafts.py --status
