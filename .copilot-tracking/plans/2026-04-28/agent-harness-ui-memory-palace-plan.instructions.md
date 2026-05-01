<!-- markdownlint-disable-file -->

# Agent Harness UI Memory Palace Plan

## User Requests

* Implement options 1 through 3 from the latest suggested next work.
* Create a memory palace.

## Objectives

* Add a browser trace viewer and export action.
* Add stop/cancel behavior for active chat streams.
* Persist web settings to local runtime storage.
* Build a memory palace from semantic session memory and surface it in the UI.

## Context Summary

* Project conventions, testing guidance, and browser validation guidance were loaded.
* The current server already has trace export APIs and injectable chat dependencies.
* The UI has externalized JavaScript in `ui/app.js`, making browser behavior changes localized.
* Semantic memory already indexes sessions and can be reused as the palace source.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Settings persistence <!-- parallelizable: false -->
* [x] Phase 3: Chat cancellation <!-- parallelizable: false -->
* [x] Phase 4: Trace viewer UI <!-- parallelizable: false -->
* [x] Phase 5: Memory palace API and UI <!-- parallelizable: false -->
* [x] Phase 6: Tests and validation <!-- parallelizable: false -->
* [x] Phase 7: Review and discovery <!-- parallelizable: false -->

## Dependencies

* Jest and ts-jest for API and memory tests.
* Existing Express app, semantic memory index, and browser UI.
* Optional browser tooling for live smoke validation.

## Success Criteria

* `npm run typecheck` passes.
* `npm test -- --runInBand` passes.
* VS Code diagnostics are clean for changed files.
* Browser smoke validation confirms trace controls and memory palace elements render.
* Review confirms all four requested work items are complete.