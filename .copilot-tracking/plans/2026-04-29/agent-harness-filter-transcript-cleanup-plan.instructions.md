<!-- markdownlint-disable-file -->

# Agent Harness Filter Transcript Cleanup Plan

## User Requests

* Follow `#prompt:rpi.prompt.md` with `continue=all`.
* Continue all prior suggested work items: Trace Filtering, Session Transcript Panel, and Runtime Cleanup Controls.

## Objectives

* Add filtering to the trace inspector.
* Add transcript context around palace memory anchors.
* Add runtime storage summary and cleanup controls.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Browser validation guidance loaded from `vscode-playwright` skill.
* Markdown and prompt-builder instructions loaded for `.copilot-tracking` artifacts.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Trace filtering <!-- parallelizable: false -->
* [x] Phase 3: Transcript panel <!-- parallelizable: false -->
* [x] Phase 4: Runtime cleanup controls <!-- parallelizable: false -->
* [x] Phase 5: Tests and validation <!-- parallelizable: false -->
* [x] Phase 6: Review and discovery <!-- parallelizable: false -->

## Dependencies

* Existing Express server and browser UI.
* Existing append-only `SessionStorage` transcript files.
* Existing trace export and semantic memory storage under `.harness/`.
* Jest and TypeScript validation.

## Success Criteria

* All checklist items complete.
* `npm run typecheck` passes.
* `npm test -- --runInBand` passes.
* VS Code diagnostics are clean for changed files.
* Browser smoke verifies filter, transcript, and cleanup surfaces.
