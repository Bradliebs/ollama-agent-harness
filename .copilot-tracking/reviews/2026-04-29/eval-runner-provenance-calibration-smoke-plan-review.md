<!-- markdownlint-disable-file -->

# Eval Runner Provenance Calibration Smoke Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-29/eval-runner-provenance-calibration-smoke-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-29

## User Request Fulfillment

* Follow `#prompt:rpi.prompt.md` with `continue=all`: complete.
* Continue all latest suggested work items: complete.

## Work Item Fulfillment

* Evaluation Runner: complete. Eval trace examples can be run into JSONL run history, and trends summarize pass rate and tag performance.
* Candidate Provenance Detail: complete. Candidate source events are resolved from session transcripts by `sourceEventIds` and exposed through API and UI detail controls.
* Apply Calibration Workflow: complete. Calibration suggestions can be explicitly applied to sanitized, persisted routing settings.
* Dynamic Learning Panel Smoke: complete. Smoke now checks new Learning panel functions and dynamic controls when Playwright is available, with static fallback coverage when it is not.

## Validation Results

```text
npm test -- --runInBand src/web/server.test.ts src/learning/evalTrace.test.ts src/learning/sessionLearning.test.ts src/agents/modelRouting.test.ts
PASS: 4 test suites, 34 tests

npm test -- --runInBand
PASS: 18 test suites, 97 tests

npm run typecheck
PASS: tsc --noEmit

VS Code diagnostics
PASS: no errors in changed source, UI, or smoke files

npm run smoke:ui -- http://127.0.0.1:4307/
PASS: static fallback mode
```

## Quality Findings

* Placement is appropriate: eval execution stays in `src/learning/evalTrace.ts`, provenance stays in `src/learning/sessionLearning.ts`, and web/UI layers expose the workflows.
* Append-only session transcript behavior remains intact. Provenance reads transcript events without mutation.
* Calibration application uses the existing settings sanitizer and persistence path.
* Remaining risk: eval runner is dataset-status validation, not full model replay. Replayable eval cases are the next logical evolution.

## Overall Status

Complete