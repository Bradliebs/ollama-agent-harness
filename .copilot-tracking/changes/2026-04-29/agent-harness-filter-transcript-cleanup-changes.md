<!-- markdownlint-disable-file -->

# Agent Harness Filter Transcript Cleanup Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/agent-harness-filter-transcript-cleanup-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all three requested follow-up items: trace filtering, session transcript context, and runtime cleanup controls.

## Added

* `.copilot-tracking/research/2026-04-29/agent-harness-filter-transcript-cleanup-research.md`
* `.copilot-tracking/plans/2026-04-29/agent-harness-filter-transcript-cleanup-plan.instructions.md`
* `.copilot-tracking/details/2026-04-29/agent-harness-filter-transcript-cleanup-details.md`
* `.copilot-tracking/plans/logs/2026-04-29/agent-harness-filter-transcript-cleanup-log.md`

## Modified

* `scripts/ui-smoke.js`
* `src/persistence/semanticMemory.ts`
* `src/persistence/semanticMemory.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `ui/app.js`
* `ui/index.html`

## Removed

* No files removed.

## Deviations

* Cleanup controls do not delete session transcripts. This is intentional because session transcripts are append-only source-of-truth data.

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 72 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Static UI smoke passed against `http://127.0.0.1:4304/`.
* Live browser validation passed against `http://127.0.0.1:4304/`.
