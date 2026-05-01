<!-- markdownlint-disable-file -->

# Output Validation Profiles Evals UX Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-29/output-validation-profiles-evals-ux-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-29

## User Request Fulfillment

* Follow `#prompt:rpi.prompt.md` with `continue=all`: complete.
* Continue all prior suggested work items: complete.
* Summarize completion with phases, artifacts, and validation status: complete.

## Work Item Fulfillment

* Validation Profiles: complete. Output validation now supports `oracle-prime`, `factual-answer`, `coding-answer`, and `tool-result-summary`, with metadata, parsing, prompt instructions, and focused tests.
* Prompt Pairing: complete. The query loop appends profile-specific validation instructions to the system prompt only when output validation is enabled.
* Eval Integration: complete. Validation results can be converted into eval runs and web chat validation events are persisted to local eval run history.
* Validator UX: complete. Browser Settings exposes all profiles and streamed validation events render grouped pass, warn, and fail findings.

## Validation Results

```text
npm test -- --runInBand src/core/outputValidation.test.ts src/core/queryLoop.test.ts src/web/server.test.ts src/learning/evalTrace.test.ts src/cli/index.test.ts
PASS: 5 test suites, 53 tests

npm run typecheck
PASS: tsc --noEmit

npm test -- --runInBand
PASS: 24 test suites, 132 tests

npm run build
PASS

npm run smoke:ui -- http://127.0.0.1:4317/
PASS: Playwright mode, all validation profiles and grouped renderer present
```

## Quality Findings

* Placement is appropriate: profile validation stays in `src/core/outputValidation.ts`, eval run conversion stays in `src/learning/evalTrace.ts`, and web/UI layers only sanitize settings, persist events, and render results.
* Validation remains optional and deterministic. It checks answer structure and discipline rather than claiming to prove factual correctness.
* Prompt pairing is scoped to enabled validation, so normal chat behavior is unchanged unless the user opts in.

## Overall Status

Complete