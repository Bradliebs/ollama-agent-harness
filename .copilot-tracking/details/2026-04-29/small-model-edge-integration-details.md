<!-- markdownlint-disable-file -->

# Small Model Edge Integration Details

## References

* Research: `.copilot-tracking/research/2026-04-29/small-model-edge-integration-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/small-model-edge-integration-plan.instructions.md`
* Log: `.copilot-tracking/plans/logs/2026-04-29/small-model-edge-integration-log.md`

## File Operations

* Modify `src/web/server.ts` for routing settings, learning promotion, eval example endpoints, and learning summaries.
* Modify `src/cli/index.ts` for helper model routing options.
* Modify `src/agents/subagent.ts` for routing metric persistence.
* Modify `src/learning/sessionLearning.ts` for candidate promotion/listing helpers.
* Modify `src/learning/evalTrace.ts` for listing helpers.
* Modify `ui/index.html` and `ui/app.js` for settings and eval controls.
* Update tests in `src/web/server.test.ts`, `src/agents/subagent.test.ts`, `src/learning/sessionLearning.test.ts`, and `src/learning/evalTrace.test.ts`.

## Validation Commands

* `npm test -- --runInBand src/web/server.test.ts src/agents/subagent.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`
* `npm test -- --runInBand`
* `npm run typecheck`

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%

## Current Phase State

* Last phase before compaction: Phase 2 Plan
* Completed steps: file operation mapping, validation commands
* In-progress step: planning log creation
* Remaining steps: implement, validate, review, discover
