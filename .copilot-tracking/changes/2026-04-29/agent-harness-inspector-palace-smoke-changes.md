<!-- markdownlint-disable-file -->

# Agent Harness Inspector Palace Smoke Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/agent-harness-inspector-palace-smoke-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all three requested follow-up items: trace inspector, palace drill-down, and stronger browser regression smoke coverage.

## Added

* `.copilot-tracking/research/2026-04-29/agent-harness-inspector-palace-smoke-research.md`
* `.copilot-tracking/plans/2026-04-29/agent-harness-inspector-palace-smoke-plan.instructions.md`
* `.copilot-tracking/details/2026-04-29/agent-harness-inspector-palace-smoke-details.md`
* `.copilot-tracking/plans/logs/2026-04-29/agent-harness-inspector-palace-smoke-log.md`

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

* Browser smoke now has a static fallback when Playwright is unavailable. Full browser checks still run when Playwright is installed, and dynamic validation was completed with VS Code browser tooling.

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 70 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Live browser validation passed at `http://127.0.0.1:4303/`.
* `npm run smoke:ui -- http://127.0.0.1:4303/`: passed in static mode.
