<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Details

## Phase 1 Web API

* Extend `WebSettings` with model catalog and extension activation settings.
* Sanitize and persist both settings through `/api/settings`.
* Add `/api/discovery` to aggregate model catalog status, extension manifests, due automations, and session search index status.
* Add `/api/models/catalog/refresh` for explicit catalog refresh.
* Add `/api/sessions/search-index/rebuild` for explicit index rebuild.

## Phase 2 Browser UI

* Add a Discovery tab to the left panel.
* Render model catalog, extension manifests, due automations, and session search index status.
* Add Team Model Catalog settings in the right panel.
* Add Extension Activation Policy settings in the right panel.

## Phase 3 Tests

* Add server API coverage for settings persistence and discovery payloads.
* Extend UI smoke coverage with Discovery IDs and functions.

## Validation Plan

* `npm test -- --runInBand src/web/server.test.ts`: passed, 1 suite and 50 tests.
* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 34 suites and 225 tests.
* `npm run build`: passed.
* `npm run smoke:ui`: failed once because the smoke script did not pass `discoveryTabVisible` into `page.evaluate`; fixed and reran successfully.
* VS Code diagnostics on changed files: no errors in changed source/test/script files; one pre-existing inline-style warning remains in `ui/index.html` outside this change.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%