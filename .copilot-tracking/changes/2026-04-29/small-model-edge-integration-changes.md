<!-- markdownlint-disable-file -->

# Small Model Edge Integration Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/small-model-edge-integration-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all five continuation items: routing configuration surface, learning candidate promotion, eval trace UI/API export, subagent runtime metrics, and model policy tests with persisted settings.

## Added

No new source files were added in this cycle; new behavior extends existing modules.

## Modified

* `src/agents/subagent.ts`
* `src/agents/subagent.test.ts`
* `src/cli/index.ts`
* `src/index.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `scripts/ui-smoke.js`
* `ui/app.js`
* `ui/index.html`

## Removed

None.

## Deviations

No functional deviations. Learning promotion writes reviewable memory entries under `.harness/memory/patterns.md`; it does not automatically retrain models or mutate source instructions.

## Validation

* `npm test -- --runInBand src/web/server.test.ts src/agents/subagent.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`: passed, 4 suites and 23 tests.
* `npm test -- --runInBand`: passed, 18 suites and 87 tests.
* `npm run typecheck`: passed.
* `npm run smoke:ui -- http://127.0.0.1:4305/`: passed in static mode against a live local server.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: implementation and validation
* In-progress step: discovery
* Remaining steps: present suggested next work
