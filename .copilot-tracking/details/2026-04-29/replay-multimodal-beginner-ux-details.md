<!-- markdownlint-disable-file -->

# Replay Multimodal Beginner UX Details

## References

* Research: `.copilot-tracking/research/2026-04-29/replay-multimodal-beginner-ux-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/replay-multimodal-beginner-ux-plan.instructions.md`

## File Operations

* Modify `src/learning/evalTrace.ts` and tests for replay adapters and source links.
* Modify `src/tools/webSearchTool.ts` and tests for weather source ranking.
* Modify `src/web/server.ts` and tests for live replay mode and model capability metadata.
* Modify `src/index.ts` exports for replay run options/types.
* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js` for model capabilities, attachment clarity, replay links, and recovery copy.

## Validation Commands

* `npm test -- --runInBand src/learning/evalTrace.test.ts src/tools/webSearchTool.test.ts src/web/server.test.ts`
* `npm test -- --runInBand`
* `npm run typecheck`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Validation Results

* Focused Jest: passed, 3 suites and 29 tests after one syntax fix in the new web API test.
* Full Jest: passed, 20 suites and 107 tests.
* Typecheck: passed.
* Diagnostics: no errors in changed source, UI, or smoke files.
* UI smoke: passed at `http://127.0.0.1:3108/` in static fallback mode.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: file operations, implementation, validation, and review
* In-progress step: present suggested next work
* Remaining steps: none
