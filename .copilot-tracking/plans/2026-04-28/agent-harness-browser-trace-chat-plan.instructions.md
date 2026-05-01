<!-- markdownlint-disable-file -->

# Agent Harness Browser Trace Chat Plan

## User Requests

* Continue with all latest suggested work items.
* Follow the attached RPI prompt with `continue=all`.

## Objectives

* Add browser automation for the externalized UI script.
* Persist trace snapshots for longer debugging sessions.
* Add direct permission prompt broker edge-case tests.
* Make chat streaming testable without a live Ollama model.

## Context Summary

* Project conventions and testing skill were loaded.
* Browser workflow guidance was loaded from the VS Code Playwright skill.
* The current UI file was reread because user or formatter edits occurred after the prior cycle.
* Prior observability/UI/tests artifacts are complete and validated.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Persistent trace exports <!-- parallelizable: false -->
* [x] Phase 3: Prompt broker tests <!-- parallelizable: true -->
* [x] Phase 4: Injectable chat dependencies and SSE tests <!-- parallelizable: false -->
* [x] Phase 5: Browser automation script and smoke validation <!-- parallelizable: false -->
* [x] Phase 6: Validation and review <!-- parallelizable: false -->

## Dependencies

* Jest and ts-jest for unit and API tests.
* Existing Express app and browser UI.
* Optional Playwright package for the browser smoke script when installed.

## Success Criteria

* `npm run typecheck` passes.
* `npm test -- --runInBand` passes.
* VS Code diagnostics are clean for changed source and UI files.
* Browser smoke validation confirms the UI loads and external script is active.
* Review confirms all four requested follow-ups are complete.