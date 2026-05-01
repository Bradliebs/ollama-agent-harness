<!-- markdownlint-disable-file -->

# Eval Runner Provenance Calibration Smoke Changes

## Summary

Implemented all four continuation items: eval runner and trends, candidate provenance details, apply-calibration workflow, and expanded Learning panel smoke coverage.

## Added

No new source files were added; existing learning, web, UI, smoke, and test modules were extended.

## Modified

* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `src/index.ts`
* `ui/app.js`
* `scripts/ui-smoke.js`

## Deviations

* Eval execution validates curated trace-example status instead of replaying model conversations. Full replay remains future work because current examples store trace status and metadata, not model inputs and expected output assertions.
* UI smoke passed in static fallback mode because Playwright is not available in the current dependency set.

## Validation

* `npm test -- --runInBand src/web/server.test.ts src/learning/evalTrace.test.ts src/learning/sessionLearning.test.ts src/agents/modelRouting.test.ts`: passed, 4 suites and 34 tests.
* `npm test -- --runInBand`: passed, 18 suites and 97 tests.
* `npm run typecheck`: passed.
* VS Code diagnostics for changed source, UI, and smoke files: no errors found.
* `npm run smoke:ui -- http://127.0.0.1:4307/`: passed in static fallback mode.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none
