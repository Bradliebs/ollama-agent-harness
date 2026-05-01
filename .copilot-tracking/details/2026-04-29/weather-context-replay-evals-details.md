<!-- markdownlint-disable-file -->

# Weather Context Replay Evals Details

## References

* Research: `.copilot-tracking/research/2026-04-29/weather-context-replay-evals-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/weather-context-replay-evals-plan.instructions.md`

## File Operations

* Modify `src/tools/webSearchTool.ts` to detect sparse weather page extraction and append fallback search context.
* Add `src/tools/webSearchTool.test.ts` for weather fallback and readable extraction behavior.
* Modify `src/web/server.ts` and `src/web/server.test.ts` for context metadata and replayable eval endpoints.
* Modify `src/learning/evalTrace.ts` and `src/learning/evalTrace.test.ts` for replayable example fields and deterministic checks.
* Modify `src/index.ts` exports for any new eval helpers.
* Modify `ui/app.js`, `ui/index.html`, and `scripts/ui-smoke.js` for detected-context display and replayable eval controls.

## Validation Commands

* `npm test -- --runInBand src/tools/webSearchTool.test.ts src/learning/evalTrace.test.ts src/web/server.test.ts src/core/ollamaClient.test.ts`
* `npm test -- --runInBand`
* `npm run typecheck`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Per-Phase Success Criteria

* Phase A succeeds when sparse weather reads include fallback search information and tests cover the behavior.
* Phase B succeeds when API settings include context metadata and UI smoke can detect the display hook.
* Phase C succeeds when replayable eval examples can be created and evaluated without live model calls.
* Phase D succeeds when validation passes and review artifacts record fulfillment.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: file operations, implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none