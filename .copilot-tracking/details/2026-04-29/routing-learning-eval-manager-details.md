<!-- markdownlint-disable-file -->

# Routing Learning Eval Manager Details

## References

* Research: `.copilot-tracking/research/2026-04-29/routing-learning-eval-manager-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/routing-learning-eval-manager-plan.instructions.md`
* Log: `.copilot-tracking/plans/logs/2026-04-29/routing-learning-eval-manager-log.md`

## File Operations

* Modify `src/learning/sessionLearning.ts` for review records and reviewed candidate listings.
* Modify `src/learning/sessionLearning.test.ts` for promote/reject review behavior.
* Modify `src/learning/evalTrace.ts` for dataset download/update/delete helpers.
* Modify `src/learning/evalTrace.test.ts` for eval management behavior.
* Modify `src/agents/modelRouting.ts` for calibration suggestions.
* Modify `src/agents/modelRouting.test.ts` for policy calibration tests.
* Modify `src/web/server.ts` for routing metrics, candidate review, and eval management endpoints.
* Modify `src/web/server.test.ts` for API coverage.
* Modify `ui/app.js` and `ui/index.html` for Learning panel controls.
* Modify `scripts/ui-smoke.js` to assert new UI hooks.

## Validation Commands

* `npm test -- --runInBand src/web/server.test.ts src/agents/modelRouting.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`
* `npm test -- --runInBand`
* `npm run typecheck`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Validation Results

* Focused Jest: passed, 4 suites and 30 tests.
* Full Jest: passed, 18 suites and 93 tests.
* Typecheck: passed.
* Diagnostics: no errors in changed source, UI, or smoke files.
* UI smoke: passed at `http://127.0.0.1:4306/`.

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
