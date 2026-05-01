<!-- markdownlint-disable-file -->

# Setup Flow CI Release Assets Changes

## Summary

Completed all continued work from the prior Suggested Next Work list.

## Added

* `.github/workflows/ci.yml`
* First-run setup panel in the browser welcome screen
* Release `v0.1.1` with `ollama-agent-harness-v0.1.1.zip`

## Modified

* `package.json`
* `package-lock.json`
* `ui/index.html`
* `ui/app.js`
* `scripts/ui-smoke.js`

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 21 suites and 112 tests.
* `npm run build`: passed.
* `npm run smoke:ui -- http://127.0.0.1:3111/`: passed in static mode.
* Diagnostics: no errors.
* GitHub Actions CI: passed on `master` push.

## GitHub

* Commit: `27e7d3c feat: add setup flow and CI`
* Tag: `v0.1.1`
* Release: `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.1`
* Asset: `ollama-agent-harness-v0.1.1.zip`

## Local-Only Files

* `.copilot-tracking/`
* `2604.14228v1.pdf`
