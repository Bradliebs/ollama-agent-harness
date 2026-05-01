<!-- markdownlint-disable-file -->

# Agent Harness Improvements Changes

## Related Plan

`.copilot-tracking/plans/2026-04-28/agent-harness-improvements-plan.instructions.md`

## Implementation Date

2026-04-28

## Summary

Implemented all five requested follow-up items from the prior discovery pass: local web server hardening, unified tool dispatch, bounded file/search output, query loop runtime tests, and runtime artifact ignore rules.

## Added

* `.copilot-tracking/research/2026-04-28/agent-harness-improvements-research.md`
* `.copilot-tracking/plans/2026-04-28/agent-harness-improvements-plan.instructions.md`
* `.copilot-tracking/details/2026-04-28/agent-harness-improvements-details.md`
* `.copilot-tracking/plans/logs/2026-04-28/agent-harness-improvements-log.md`
* `src/core/queryLoop.test.ts`

## Modified

* `.gitignore`
* `src/core/queryLoop.ts`
* `src/tools/dispatcher.ts`
* `src/tools/fileTools.ts`
* `src/tools/grepTool.ts`
* `src/web/server.ts`

## Removed

* No files removed.

## Deviations

* The first query loop compaction test fixture was adjusted after validation showed it did not meet the production auto-compaction minimum conversation length.

## Validation

* `npm test -- --runInBand`: passed, 9 test suites and 41 tests.
* `npm run typecheck`: passed.
* VS Code diagnostics for edited TypeScript files: no errors found.
* UI server smoke test: started successfully at `http://127.0.0.1:4300/` with `NO_OPEN=1`.
