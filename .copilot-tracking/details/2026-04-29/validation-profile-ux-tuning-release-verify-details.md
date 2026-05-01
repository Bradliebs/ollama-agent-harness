<!-- markdownlint-disable-file -->

# Validation Profile UX Tuning Release Verify Details

## References

* Research: `.copilot-tracking/research/2026-04-29/validation-profile-ux-tuning-release-verify-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/validation-profile-ux-tuning-release-verify-plan.instructions.md`

## File Operations

* Modify `src/core/outputValidation.ts` and tests for validation errors and tuning fields.
* Modify `src/web/server.ts` and tests for 400 responses on invalid custom profiles.
* Modify `ui/app.js` and `scripts/ui-smoke.js` for inline editor validation feedback.
* Modify `.github/workflows/ci.yml` for published zip verification.
* Modify `README.md` and `CHANGELOG.md` for documented behavior.

## Validation Commands

* `npm test -- --runInBand src/core/outputValidation.test.ts src/web/server.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`
* `npm run smoke:release -- release/ollama-agent-harness-v0.1.6.zip`
