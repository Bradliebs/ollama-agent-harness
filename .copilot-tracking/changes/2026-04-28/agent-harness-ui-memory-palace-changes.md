<!-- markdownlint-disable-file -->

# Agent Harness UI Memory Palace Changes

## Related Plan

`.copilot-tracking/plans/2026-04-28/agent-harness-ui-memory-palace-plan.instructions.md`

## Implementation Date

2026-04-28

## Summary

Implemented options 1 through 3 from the prior discovery list and added a memory palace: browser trace controls, chat cancellation, settings persistence, and a derived palace view over semantic memory.

## Added

* `.copilot-tracking/research/2026-04-28/agent-harness-ui-memory-palace-research.md`
* `.copilot-tracking/plans/2026-04-28/agent-harness-ui-memory-palace-plan.instructions.md`
* `.copilot-tracking/details/2026-04-28/agent-harness-ui-memory-palace-details.md`
* `.copilot-tracking/plans/logs/2026-04-28/agent-harness-ui-memory-palace-log.md`

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

* The memory palace is derived from semantic memory entries instead of saved as separate state. This avoids duplicating memory storage and keeps session transcripts as the source of truth.

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 68 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Live browser smoke: passed at `http://127.0.0.1:4302/`.