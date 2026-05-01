<!-- markdownlint-disable-file -->

# Routing Learning Eval Manager Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all latest suggested work items: Routing Metrics Dashboard, Learning Candidate Review Queue, Eval Dataset Manager, and Policy Calibration Tests.

## Objectives

* Add an inspectable routing metrics dashboard for helper model decisions.
* Turn learning promotion into an explicit review queue with promote/reject actions.
* Add eval dataset management: list, download, tag, and delete.
* Add policy calibration tests and helper logic that replay stored metrics into threshold suggestions.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core for `.copilot-tracking` artifacts.
* Previous integration cycle added routing settings, eval example creation, candidate promotion, and subagent metrics.

## Implementation Checklist

### Phase A: Learning Candidate Review Queue <!-- parallelizable: false -->

* [x] Add candidate review record helpers and status merging.
* [x] Add promote/reject API endpoints.
* [x] Stop automatic promotion from the web chat post-session hook.
* [x] Render review actions in the Learning panel.

### Phase B: Routing Metrics Dashboard <!-- parallelizable: false -->

* [x] Add routing metric summary and policy calibration helpers.
* [x] Add API endpoint for routing metrics and calibration.
* [x] Render routing metrics and calibration suggestions in the Learning panel.

### Phase C: Eval Dataset Manager <!-- parallelizable: false -->

* [x] Add eval example update/delete/download helpers.
* [x] Add API endpoints for download, tagging, and deletion.
* [x] Render eval dataset controls in the Learning or Settings panel.

### Phase D: Tests And Validation <!-- parallelizable: false -->

* [x] Add focused tests for review queue, eval management, routing metrics, and calibration.
* [x] Run focused tests, full Jest suite, typecheck, diagnostics, and UI smoke.

## Validation Results

* `npm test -- --runInBand src/web/server.test.ts src/agents/modelRouting.test.ts src/learning/sessionLearning.test.ts src/learning/evalTrace.test.ts`: passed, 4 suites and 30 tests.
* `npm test -- --runInBand`: passed, 18 suites and 93 tests.
* `npm run typecheck`: passed.
* VS Code diagnostics for changed source, UI, and smoke files: no errors found.
* `npm run smoke:ui -- http://127.0.0.1:4306/`: passed in static mode against a live local server.

## Dependencies

* `src/agents/modelRouting.ts`
* `src/agents/subagent.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/evalTrace.ts`
* `src/web/server.ts`
* `ui/app.js`
* `ui/index.html`
* `scripts/ui-smoke.js`

## Success Criteria

* All four work items have code-level and UI/API support.
* Promotion is explicit and reviewable.
* Eval examples can be managed without editing JSONL manually.
* Policy calibration is covered by tests.
* Validation passes.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none
