<!-- markdownlint-disable-file -->

# Validation Profile UX Tuning Release Verify Research

## Scope

Continue all suggested work items from the prior Phase 5 output:

1. Profile Schema UX.
2. Validator Tuning.
3. Published Zip Verification.

## Assumptions

* RPI workflow state remains under `.copilot-tracking/`.
* Custom validation profiles stay deterministic and local-first.
* The profile editor should report schema errors instead of silently dropping malformed profiles.
* Published zip verification belongs in CI because it validates the latest GitHub Release asset after a release exists.

## Evidence Log

* `src/core/outputValidation.ts` normalizes custom profiles and silently discards invalid entries.
* `ui/app.js` only reports JSON parse or server errors from the custom profile editor.
* Custom checks support severity but have fixed score penalties through `completeValidationResult`.
* `.github/workflows/ci.yml` validates source, build, and UI smoke, but does not verify the latest published release archive.
* `scripts/release-smoke.js` can smoke-test a local zip path and can be reused after downloading a published asset.

## Selected Approach

* Add a core validation helper that returns normalized custom profiles plus structured schema errors.
* Have the profile save API reject invalid profile JSON with a 400 response and clear error payload.
* Add editor-side schema validation messages before save and render server validation errors when present.
* Add custom check `scorePenalty` and custom profile `warnBelowScore`/`failBelowScore` thresholds for deterministic tuning.
* Add a CI job that discovers the latest release asset, downloads the zip, and runs `npm run smoke:release` against it.

## Success Criteria

* Malformed custom profile JSON produces actionable editor/API errors.
* Custom checks can tune score penalties and profile thresholds without arbitrary code execution.
* Documentation includes the new schema/tuning fields.
* CI verifies the latest published zip asset with the existing release smoke script.
* Focused tests, typecheck, full tests, build, UI smoke, and remote CI pass.
