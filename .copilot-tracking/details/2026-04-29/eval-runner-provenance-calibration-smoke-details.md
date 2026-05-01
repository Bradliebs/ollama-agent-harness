<!-- markdownlint-disable-file -->

# Eval Runner Provenance Calibration Smoke Details

## Context References

* Research: `.copilot-tracking/research/2026-04-29/eval-runner-provenance-calibration-smoke-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/eval-runner-provenance-calibration-smoke-plan.instructions.md`
* Prior review: `.copilot-tracking/reviews/2026-04-29/routing-learning-eval-manager-plan-review.md`

## File Operations

* Modify `src/learning/evalTrace.ts` and test for eval run execution and trends.
* Modify `src/learning/sessionLearning.ts` and test for source event provenance.
* Modify `src/web/server.ts` and test for new API endpoints.
* Modify `src/index.ts` exports.
* Modify `ui/app.js` for Learning panel controls.
* Modify `scripts/ui-smoke.js` for dynamic and static coverage.

## Validation Commands

* `npm test -- --runInBand src/web/server.test.ts src/learning/evalTrace.test.ts src/learning/sessionLearning.test.ts src/agents/modelRouting.test.ts`
* `npm test -- --runInBand`
* `npm run typecheck`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Validation Results

* Focused Jest: passed, 4 suites and 34 tests after one assertion-only fix.
* Full Jest: passed, 18 suites and 97 tests.
* Typecheck: passed.
* Diagnostics: no errors in changed source, UI, or smoke files.
* UI smoke: passed at `http://127.0.0.1:4307/` in static fallback mode.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 0%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none
