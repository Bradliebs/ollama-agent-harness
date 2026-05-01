<!-- markdownlint-disable-file -->

# Agent Harness Observability UI Tests Changes

## Related Plan

`.copilot-tracking/plans/2026-04-28/agent-harness-observability-ui-tests-plan.instructions.md`

## Implementation Date

2026-04-28

## Summary

Implemented all five requested follow-up items from the latest discovery pass: API server tests, runtime tracing, UI script modularization, file tool tests, and web permission prompts.

## Added

* `src/core/tracing.ts`
* `src/core/tracing.test.ts`
* `src/permissions/promptBroker.ts`
* `src/tools/fileTools.test.ts`
* `src/tools/grepTool.test.ts`
* `src/web/server.test.ts`
* `ui/app.js`

## Modified

* `src/core/queryLoop.ts`
* `src/core/queryLoop.test.ts`
* `src/index.ts`
* `src/tools/dispatcher.ts`
* `src/tools/dispatcher.test.ts`
* `src/web/server.ts`
* `ui/index.html`
* `.copilot-tracking/plans/2026-04-28/agent-harness-observability-ui-tests-plan.instructions.md`
* `.copilot-tracking/plans/logs/2026-04-28/agent-harness-observability-ui-tests-log.md`

## Removed

* Removed the legacy inline browser script block from `ui/index.html` after moving active behavior to `ui/app.js`.

## Deviations

* No functional deviations from the plan. The API test setup required one correction to wait for the HTTP listener before reading the assigned port.

## Validation

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 13 suites and 59 tests.
* VS Code HTML diagnostics for `ui/index.html`: no errors found.
* UI smoke test: passed at `http://127.0.0.1:4301/`; `ui/app.js` loaded, legacy inline script removed, permission panel exists, and no duplicate ids are present.