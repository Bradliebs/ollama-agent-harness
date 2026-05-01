<!-- markdownlint-disable-file -->

# Output Validation Profiles Evals UX Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all prior suggested work items: Validation Profiles, Eval Integration, Prompt Pairing, and Validator UX.
3. Summarize completion with phases completed, iteration count, artifacts created, and final validation status.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown instructions loaded from HVE Core because this cycle creates `.copilot-tracking` artifacts.
* Research: `.copilot-tracking/research/2026-04-29/output-validation-profiles-evals-ux-research.md`.

## Implementation Checklist

### Phase A: Validation Profiles <!-- parallelizable: false -->

* [x] Extend `OutputValidationProfile` and validators.
* [x] Add profile metadata and prompt instructions.
* [x] Add focused profile tests.

### Phase B: Prompt Pairing <!-- parallelizable: false -->

* [x] Append matching validation instructions to the loop system prompt when enabled.
* [x] Add query loop coverage for prompt pairing.

### Phase C: Eval Integration <!-- parallelizable: false -->

* [x] Add eval run conversion for validation results.
* [x] Persist validation eval runs from the web chat stream.
* [x] Add API test coverage.

### Phase D: Validator UX <!-- parallelizable: false -->

* [x] Add all profiles to Settings.
* [x] Render grouped validation findings in chat activity.
* [x] Extend UI smoke coverage.

### Phase E: Validation And Review <!-- parallelizable: false -->

* [x] Run focused tests.
* [x] Run full Jest, typecheck, build, and UI smoke.
* [x] Record changes and review artifacts.

## Dependencies

* `src/core/outputValidation.ts`
* `src/core/queryLoop.ts`
* `src/learning/evalTrace.ts`
* `src/web/server.ts`
* `ui/app.js`
* `ui/index.html`
* `scripts/ui-smoke.js`

## Success Criteria

* All four requested work items are complete.
* Validation remains optional.
* Local validation passes.
* `.copilot-tracking` contains current plan, changes, and review state.
