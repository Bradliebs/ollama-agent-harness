<!-- markdownlint-disable-file -->

# Agent Harness Observability UI Tests Plan

## User Requests

* Continue with all latest suggested work items.
* Follow the attached RPI prompt with `continue=all`.

## Objectives

* Make the web server testable without starting a process on import.
* Add interactive permission prompts for `ask` decisions.
* Add structured runtime tracing that preserves the simple loop architecture.
* Move UI logic out of inline HTML.
* Cover the newly hardened file and API boundaries with Jest.

## Context Summary

* Project conventions, code-review, and testing skills were loaded.
* Prior cycle artifacts are complete and show green validation.
* The current implementation already has localhost binding, bounded file tools, and query loop runtime tests.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Runtime tracing <!-- parallelizable: false -->
* [x] Phase 3: Permission prompt broker and server refactor <!-- parallelizable: false -->
* [x] Phase 4: UI script modularization and prompt UI <!-- parallelizable: false -->
* [x] Phase 5: API and file tool tests <!-- parallelizable: false -->
* [x] Phase 6: Validation and review <!-- parallelizable: false -->

## Dependencies

* Jest and ts-jest for behavior-focused tests.
* Existing Express server, browser UI, permission engine, and tool dispatcher.
* Project skills: `harness-conventions` and `testing`.

## Success Criteria

* `npm test -- --runInBand` passes.
* `npm run typecheck` passes.
* UI smoke test passes after script extraction.
* Review confirms all five requested follow-ups are complete.
