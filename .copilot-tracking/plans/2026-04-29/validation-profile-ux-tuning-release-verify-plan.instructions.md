<!-- markdownlint-disable-file -->

# Validation Profile UX Tuning Release Verify Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all prior suggested work items: Profile Schema UX, Validator Tuning, and Published Zip Verification.
3. Summarize completion with phases completed, iteration count, artifacts created, and final validation status.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Research: `.copilot-tracking/research/2026-04-29/validation-profile-ux-tuning-release-verify-research.md`.

## Implementation Checklist

### Phase A: Schema UX <!-- parallelizable: false -->

* [x] Add structured custom profile schema validation in the core module.
* [x] Reject invalid custom profile saves from the web API.
* [x] Show inline editor errors in the browser Settings panel.

### Phase B: Validator Tuning <!-- parallelizable: false -->

* [x] Add deterministic scoring fields for custom checks and profiles.
* [x] Add focused tests for penalties and thresholds.
* [x] Document supported tuning fields.

### Phase C: Published Zip Verification <!-- parallelizable: false -->

* [x] Add CI verification for the latest published release zip.
* [x] Keep the release smoke script as the single archive validation path.

### Phase D: Validation And Publish <!-- parallelizable: false -->

* [x] Run focused tests, typecheck, full Jest, build, UI smoke, and release smoke.
* [x] Commit and push relevant source/docs/workflow changes.
* [x] Verify GitHub CI.

### Phase E: Review And Discover <!-- parallelizable: false -->

* [x] Record changes and review artifacts.
* [x] Complete Phase 5 discovery.

## Dependencies

* `src/core/outputValidation.ts`
* `src/core/outputValidation.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `ui/app.js`
* `scripts/ui-smoke.js`
* `.github/workflows/ci.yml`
* `README.md`
* `CHANGELOG.md`

## Success Criteria

* All three continued work items are complete.
* Custom profile validation errors are explicit and test-covered.
* Score tuning remains deterministic and bounded.
* Published release archive verification runs in GitHub CI.
