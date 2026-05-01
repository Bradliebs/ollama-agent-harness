<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Changes

Date: 2026-04-30

Related plan: `.copilot-tracking/plans/2026-04-30/hermes-discovery-surfaces-plan.instructions.md`

## Summary

Implemented all three follow-up items from the prior Phase 5 output: browser discovery panels, extension activation policy settings, and team model catalog settings.

## Modified

* `src/web/server.ts`: added model catalog and extension activation settings, discovery aggregation, catalog refresh, session search index rebuild, and activation policy descriptions.
* `src/web/server.test.ts`: added API coverage for persisted discovery settings, discovery payloads, catalog refresh, and search index rebuild.
* `ui/index.html`: added the Discovery tab, Discovery view container, Team Model Catalog settings, and Extension Activation Policy settings.
* `ui/app.js`: added discovery loading/rendering, catalog refresh, session search rebuild, and setting update helpers.
* `scripts/ui-smoke.js`: added smoke checks for the Discovery tab, panels, settings controls, and discovery functions.

## Validation

* `npm test -- --runInBand src/web/server.test.ts`: passed, 1 suite and 50 tests.
* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 34 suites and 225 tests.
* `npm run build`: passed.
* `npm run smoke:ui`: passed after fixing a smoke script assertion issue.
* VS Code diagnostics: no errors in changed source/test/script files; one pre-existing inline-style warning remains in `ui/index.html`.

## Deviations

* Executable plugin loading remains unimplemented by design. The new extension policy records the trust boundary and explains why activation is blocked.