<!-- markdownlint-disable-file -->

# Eval Runner Provenance Calibration Smoke Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all latest suggested work items: Evaluation Runner, Candidate Provenance Detail, Apply Calibration Workflow, and Dynamic Learning Panel Smoke.

## Objectives

* Add a trace eval runner and trend reporting over curated eval examples.
* Add candidate provenance detail from source session events.
* Add an explicit workflow to apply routing calibration suggestions to settings.
* Add dynamic Learning panel smoke coverage while preserving static fallback smoke.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Prior cycle completed routing metrics, candidate review, eval dataset management, and calibration suggestions.

## Implementation Checklist

### Phase A: Evaluation Runner <!-- parallelizable: false -->

* [x] Add eval run result and trend helpers.
* [x] Add eval run API endpoints and Learning payload fields.
* [x] Render eval run controls and trend summary.

### Phase B: Candidate Provenance Detail <!-- parallelizable: false -->

* [x] Add candidate provenance lookup helpers.
* [x] Add candidate provenance API endpoint.
* [x] Render candidate detail inspection in the Learning panel.

### Phase C: Apply Calibration Workflow <!-- parallelizable: false -->

* [x] Add apply-calibration API endpoint that persists sanitized routing settings.
* [x] Render apply action and current suggested policy in the Learning panel.
* [x] Refresh settings after applying calibration.

### Phase D: Dynamic Smoke And Tests <!-- parallelizable: false -->

* [x] Add focused Jest coverage for eval runs, provenance, calibration apply, and endpoints.
* [x] Extend UI smoke dynamic and static checks for new Learning panel functions.
* [x] Run focused tests, full Jest, typecheck, diagnostics, and UI smoke.

## Validation Results

* `npm test -- --runInBand src/web/server.test.ts src/learning/evalTrace.test.ts src/learning/sessionLearning.test.ts src/agents/modelRouting.test.ts`: passed, 4 suites and 34 tests after one assertion-only fix.
* `npm test -- --runInBand`: passed, 18 suites and 97 tests.
* `npm run typecheck`: passed.
* VS Code diagnostics for changed source, UI, and smoke files: no errors found.
* `npm run smoke:ui -- http://127.0.0.1:4307/`: passed in static fallback mode.

## Dependencies

* `src/learning/evalTrace.ts`
* `src/learning/sessionLearning.ts`
* `src/agents/modelRouting.ts`
* `src/web/server.ts`
* `src/index.ts`
* `ui/app.js`
* `scripts/ui-smoke.js`

## Success Criteria

* Eval examples can be executed into a recorded run with pass/fail trends.
* Candidate provenance can be inspected without mutating transcripts.
* Routing calibration suggestions can be explicitly applied to persisted settings.
* UI smoke verifies the new Learning panel controls in Playwright mode and static mode.
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
* Completed steps: research, planning, implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none
