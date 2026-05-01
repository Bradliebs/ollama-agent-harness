<!-- markdownlint-disable-file -->

# Agent Harness Improvements Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-28/agent-harness-improvements-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-28

## User Request Fulfillment

* Continue with all suggested work items: complete.
* Follow attached RPI prompt with `continue=all`: complete.

## Work Item Fulfillment

* Harden Local Web Server: complete. The server now defaults to `default` permission mode, validates mutable settings and local ids, restricts file tree browsing to the project root, and binds to a configurable host defaulting to `127.0.0.1`.
* Unify Tool Execution Path: complete. `queryLoop` now uses `ToolDispatcher`, and dispatcher owns permission, hook, error-boundary, and optional usage tracking behavior.
* Add Query Loop Runtime Tests: complete. `src/core/queryLoop.test.ts` covers text completion, tool calls, permission denial, hook mutation, session persistence calls, and context events.
* Bound Tool Output and File Reads: complete. File tools now constrain paths to the project root, support line ranges and read byte caps, and limit write size. Grep now constrains paths and skips large files.
* Ignore Runtime Artifacts: complete. `.harness/` was added to `.gitignore`.

## Validation Results

```text
npm test -- --runInBand
PASS: 9 test suites, 41 tests

npm run typecheck
PASS: tsc --noEmit

UI server smoke test
PASS: served http://127.0.0.1:4300/
```

## Quality Findings

* Placement is appropriate: security and HTTP input validation stayed in `src/web/server.ts`; dispatch behavior moved into `src/tools/dispatcher.ts`; loop tests live beside `src/core/queryLoop.ts`.
* The project convention of a simple agent loop is preserved. The loop delegates operational details to surrounding harness code.
* Remaining risk: UI JavaScript is still a single large inline script without browser automation coverage.

## Overall Status

Complete

## Suggested Next Work

1. Add API-level server tests using an HTTP test harness so settings validation, path constraints, and local id validation are covered outside the browser.
2. Add structured runtime tracing for model calls, tool calls, permission checks, compaction events, and session writes.
3. Split the inline browser script in `ui/index.html` into testable modules and add UI smoke tests for settings, recovery, and context HUD flows.
4. Add file tool tests for root path enforcement, line ranges, truncation, and large-file grep skipping.
5. Add a permission prompt flow for the web UI so `ask` decisions can be confirmed or denied interactively instead of being treated as denial by the adapter.
