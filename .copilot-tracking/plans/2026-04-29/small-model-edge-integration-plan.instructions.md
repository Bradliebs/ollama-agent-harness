<!-- markdownlint-disable-file -->

# Small Model Edge Integration Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all latest suggested work items: Routing Configuration Surface, Learning Candidate Promotion, Eval Trace UI/API Export, Subagent Runtime Metrics, and Model Policy Tests With Real Settings.

## Objectives

* Make helper model routing configurable from CLI and web settings.
* Promote accepted learning candidates into reviewable local memory.
* Generate evaluation examples from runtime trace snapshots through API and UI controls.
* Record subagent routing decisions and outcomes for calibration.
* Cover the settings-backed policy path with tests.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Previous small-model-edge cycle added routing, helper presets, learning candidates, and eval trace helpers.
* Current web settings and trace panels provide a natural integration surface.

## Implementation Checklist

### Phase A: Routing Settings <!-- parallelizable: false -->

* [x] Add model routing policy fields to web settings and persistence.
* [x] Add CLI options for small/default/strong helper routing policy.
* [x] Add UI controls in the Settings panel.

### Phase B: Learning Promotion <!-- parallelizable: false -->

* [x] Add promotion helper for accepted session learning candidates.
* [x] Run candidate extraction/promotion after web chat sessions complete.
* [x] Surface candidate counts in `/api/learning`.

### Phase C: Eval Trace Export <!-- parallelizable: false -->

* [x] Add API endpoint to append current trace snapshot as an eval example.
* [x] Add API endpoint to list eval examples.
* [x] Add UI buttons/status for trace eval export.

### Phase D: Subagent Metrics <!-- parallelizable: false -->

* [x] Record preset, selected tier/model, escalation reason, and success for subagent runs.
* [x] Keep metrics append-only under `.harness/learning`.

### Phase E: Tests And Validation <!-- parallelizable: false -->

* [x] Add focused tests for promotion, eval API, settings persistence, and subagent metrics.
* [x] Run targeted tests, full Jest suite, and typecheck.

## Validation Results

* `npm test -- --runInBand src/web/server.test.ts src/agents/subagent.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`: passed, 4 suites and 23 tests.
* `npm test -- --runInBand`: passed, 18 suites and 87 tests.
* `npm run typecheck`: passed.
* `npm run smoke:ui -- http://127.0.0.1:4305/`: passed in static mode against a live local server.

## Dependencies

* `src/agents/modelRouting.ts`
* `src/agents/subagent.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/evalTrace.ts`
* `src/web/server.ts`
* `ui/app.js`
* `ui/index.html`

## Success Criteria

* All five work items have code-level support.
* Tests pass and TypeScript typecheck passes.
* Runtime state remains under `.harness/` and workflow state remains under `.copilot-tracking/`.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: implementation, focused validation, full validation, smoke validation
* In-progress step: discovery
* Remaining steps: present suggested next work
