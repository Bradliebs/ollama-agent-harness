<!-- markdownlint-disable-file -->

# Agent Harness Inspector Palace Smoke Plan

## User Requests

* Follow `#prompt:rpi.prompt.md` with `continue=all`.
* Continue all prior suggested work items: Trace Inspector, Palace Drill-Down, and Browser Regression Tests.

## Objectives

* Add a trace inspector UI for saved trace exports.
* Add palace anchor drill-down to source memory entries.
* Strengthen browser smoke automation around the new UI affordances.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Browser workflow guidance loaded from `vscode-playwright` skill.
* Markdown and prompt-builder instructions loaded for `.copilot-tracking` artifacts.
* Repository memory notes confirmed resume/continuity constraints, not directly touched by this cycle.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Trace inspector <!-- parallelizable: false -->
* [x] Phase 3: Palace drill-down <!-- parallelizable: false -->
* [x] Phase 4: Browser smoke assertions <!-- parallelizable: false -->
* [x] Phase 5: Tests and validation <!-- parallelizable: false -->
* [x] Phase 6: Review and discovery <!-- parallelizable: false -->

## Dependencies

* Existing Express web server and `ui/app.js` browser script.
* Existing semantic memory index and trace export files under `.harness/`.
* Jest and TypeScript for validation.
* Optional Playwright package for `npm run smoke:ui`.

## Success Criteria

* All checklist items complete.
* `npm run typecheck` passes.
* `npm test -- --runInBand` passes.
* VS Code diagnostics are clean for changed files.
* Browser smoke verifies trace and palace UI elements.
