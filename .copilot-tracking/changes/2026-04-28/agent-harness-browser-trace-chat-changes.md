<!-- markdownlint-disable-file -->

# Agent Harness Browser Trace Chat Changes

## Related Plan

`.copilot-tracking/plans/2026-04-28/agent-harness-browser-trace-chat-plan.instructions.md`

## Implementation Date

2026-04-28

## Summary

Implemented all four requested follow-up items: persistent trace exports, prompt broker edge-case tests, injectable chat streaming dependencies, and reusable browser smoke automation.

## Added

* `scripts/ui-smoke.js`
* `src/permissions/promptBroker.test.ts`

## Modified

* `package.json`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `.copilot-tracking/plans/2026-04-28/agent-harness-browser-trace-chat-plan.instructions.md`
* `.copilot-tracking/plans/logs/2026-04-28/agent-harness-browser-trace-chat-log.md`
* `.copilot-tracking/research/2026-04-28/agent-harness-browser-trace-chat-research.md`

## Removed

* No files removed.

## Deviations

* Playwright remains an optional script-time dependency. The script exits with a clear install message when Playwright is not installed, and this run used VS Code browser tooling for live validation.

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 65 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Live browser smoke: passed at `http://127.0.0.1:4301/`.