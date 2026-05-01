<!-- markdownlint-disable-file -->

# Output Validation Profiles Evals UX Details

## References

* Research: `.copilot-tracking/research/2026-04-29/output-validation-profiles-evals-ux-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/output-validation-profiles-evals-ux-plan.instructions.md`

## File Operations

* Modify `src/core/outputValidation.ts` and tests for additional profiles and prompt instructions.
* Modify `src/core/queryLoop.ts`, `src/types/loop.ts`, and tests for prompt pairing.
* Modify `src/learning/evalTrace.ts` for validation eval run persistence.
* Modify `src/web/server.ts` and tests for settings sanitization and validation run persistence.
* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js` for selection and grouped output.

## Validation Commands

* `npm test -- --runInBand src/core/outputValidation.test.ts src/core/queryLoop.test.ts src/web/server.test.ts src/learning/evalTrace.test.ts src/cli/index.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Validation Results

* Focused Jest passed, 5 suites and 53 tests.
* TypeScript typecheck passed.
* Full Jest passed, 24 suites and 132 tests.
* Build passed.
* Playwright UI smoke passed against `http://127.0.0.1:4317/`.

## Success Criteria

* Profile behavior is covered by unit tests.
* Query loop prompt pairing is covered by behavior tests.
* Web chat records output-validation eval runs.
* UI smoke verifies profile options and grouped formatting hooks.
