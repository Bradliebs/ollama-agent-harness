<!-- markdownlint-disable-file -->

# Output Validation Profiles Evals UX Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/output-validation-profiles-evals-ux-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all four continuation items: additional output-validation profiles, prompt pairing, validation eval run persistence, and grouped validator UX.

## Added

* `src/core/outputValidation.ts`
* `src/core/outputValidation.test.ts`

## Modified

* `scripts/ui-smoke.js`
* `src/cli/index.ts`
* `src/cli/index.test.ts`
* `src/core/queryLoop.ts`
* `src/core/queryLoop.test.ts`
* `src/index.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/types/index.ts`
* `src/types/loop.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `ui/app.js`
* `ui/index.html`

## Removed

No files removed.

## Deviations

* Validation outcomes are recorded as single-example eval runs tagged by profile and status. This reuses existing run history rather than adding a separate validation-history store.
* Browser output validation still keeps a compact formatter for compatibility while using a grouped renderer for streamed validation events.

## Validation

* `npm test -- --runInBand src/core/outputValidation.test.ts src/core/queryLoop.test.ts src/web/server.test.ts src/learning/evalTrace.test.ts src/cli/index.test.ts` passed, 5 suites and 53 tests.
* `npm run typecheck` passed.
* `npm test -- --runInBand` passed, 24 suites and 132 tests.
* `npm run build` passed.
* `npm run smoke:ui -- http://127.0.0.1:4317/` passed in Playwright mode.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%