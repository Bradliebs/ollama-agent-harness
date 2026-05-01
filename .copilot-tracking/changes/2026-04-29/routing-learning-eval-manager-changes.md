<!-- markdownlint-disable-file -->

# Routing Learning Eval Manager Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/routing-learning-eval-manager-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all four continuation items: routing metrics dashboard, learning candidate review queue, eval dataset manager, and policy calibration tests.

## Added

No new source files were added in this cycle; existing learning, routing, eval, web, UI, and smoke modules were extended.

## Modified

* `src/agents/modelRouting.ts`
* `src/agents/modelRouting.test.ts`
* `src/index.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `scripts/ui-smoke.js`
* `ui/app.js`

## Removed

None.

## Deviations

* Candidate promotion is no longer automatic after web chat. This is intentional because the requested review queue requires explicit promote/reject decisions.
* Eval tag/delete operations rewrite the eval JSONL file. Session transcripts remain append-only; eval examples are curated runtime dataset artifacts.

## Validation

* `npm test -- --runInBand src/web/server.test.ts src/agents/modelRouting.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`: passed, 4 suites and 30 tests.
* `npm test -- --runInBand`: passed, 18 suites and 93 tests.
* `npm run typecheck`: passed.
* VS Code diagnostics for changed source, UI, and smoke files: no errors found.
* `npm run smoke:ui -- http://127.0.0.1:4306/`: passed in static mode against a live local server.

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
