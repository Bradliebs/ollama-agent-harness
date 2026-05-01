<!-- markdownlint-disable-file -->

# Validation Docs Trends Profiles Release Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all prior suggested work items: Document Output Validation, Validation Trends UI, Profile Authoring, and Release Validation Feature.
3. Summarize completion with phases completed, iteration count, artifacts created, and final validation status.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Research: `.copilot-tracking/research/2026-04-29/validation-docs-trends-profiles-release-research.md`.

## Implementation Checklist

### Phase A: Documentation <!-- parallelizable: false -->

* [x] Add README output-validation profile guidance.
* [x] Document CLI usage and custom profile file shape.
* [x] Update changelog/release notes for the validation feature.

### Phase B: Profile Authoring <!-- parallelizable: false -->

* [x] Add custom profile definition types and deterministic validation checks.
* [x] Load custom profiles from `.harness/output-validation-profiles.json`.
* [x] Add API and UI support to view/save custom profile JSON.
* [x] Add tests for custom profile validation and web settings behavior.

### Phase C: Validation Trends UI <!-- parallelizable: false -->

* [x] Add output-validation trend summary helpers.
* [x] Render profile/status trends and recent validation findings in the Learning panel.
* [x] Extend smoke coverage for validation trend and custom profile hooks.

### Phase D: Release Validation Feature <!-- parallelizable: false -->

* [x] Bump package version and lockfile.
* [x] Generate release notes and archive.
* [x] Run local validation and release archive smoke.
* [x] Commit, tag, push, and verify GitHub CI/release workflow.

### Phase E: Review And Discover <!-- parallelizable: false -->

* [x] Record changes and review artifacts.
* [x] Complete Phase 5 discovery.

## Dependencies

* `src/core/outputValidation.ts`
* `src/core/queryLoop.ts`
* `src/learning/evalTrace.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `ui/app.js`
* `ui/index.html`
* `scripts/ui-smoke.js`
* `README.md`
* `CHANGELOG.md`
* `package.json`
* `package-lock.json`

## Success Criteria

* All four continued work items are complete.
* Validation remains optional and deterministic.
* Custom profiles are configurable without TypeScript edits.
* Local validation and release archive smoke pass.
* GitHub release workflow is verified for the new tag.
