<!-- markdownlint-disable-file -->

# Output Validation Profiles Evals UX Research

## Scope

Continue all latest suggested work items from the prior Phase 5 output:

1. Validation Profiles
2. Eval Integration
3. Prompt Pairing
4. Validator UX

## Assumptions

* Output validation should remain optional and deterministic.
* Validators check structure and discipline, not absolute truth.
* Prompt pairing should guide the model only when validation is enabled.
* Eval integration should reuse existing local JSONL eval run history.

## Evidence Log

* `src/core/outputValidation.ts` currently supports only the `oracle-prime` profile.
* `src/core/queryLoop.ts` emits `output_validation` before final text and records a tracing event.
* `src/learning/evalTrace.ts` already stores eval runs and trends as local JSONL artifacts.
* `src/web/server.ts` persists `outputValidation` settings and streams validation events to the browser.
* `ui/app.js` renders output validation as one compact tool row, which hides useful finding detail.

## Selected Approach

* Add lighter profiles for factual answers, coding answers, and tool-result summaries.
* Add exported prompt instructions per profile and append them to the system prompt when validation is enabled.
* Convert each validation event into an eval run record tagged by profile and status.
* Render grouped validation findings in the browser stream with pass, warn, and fail counts.

## Success Criteria

* All profiles validate deterministically with focused Jest coverage.
* Enabling validation appends the matching prompt contract to the system prompt.
* Validation outcomes are persisted into eval run history.
* Browser Settings can select all supported profiles and render grouped validation details.
* Typecheck, focused tests, full Jest, build, and UI smoke pass.
