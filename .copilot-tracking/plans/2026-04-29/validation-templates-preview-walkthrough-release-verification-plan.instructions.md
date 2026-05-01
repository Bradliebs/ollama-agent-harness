<!-- markdownlint-disable-file -->

# Validation Templates Preview Walkthrough Release Verification Plan

## User Requests

1. Continue all prior suggested work items.
2. Make validation easier and more automatic for beginners.
3. Keep all state managed through `.copilot-tracking/` for RPI workflow records.

## Context Summary

* Project instructions: `.github/copilot-instructions.md`.
* Skills: `.github/skills/harness-conventions/SKILL.md`, `.github/skills/testing/SKILL.md`.
* Research: `.copilot-tracking/research/2026-04-29/validation-templates-preview-walkthrough-release-verification-research.md`.

## Implementation Checklist

### Phase A: Validation Templates <!-- parallelizable: false -->

* [x] Add reusable built-in custom profile templates.
* [x] Add API endpoints to list and install templates.
* [x] Add Settings UI for one-click template installation.

### Phase B: Validator Preview <!-- parallelizable: false -->

* [x] Add API endpoint to preview validation output.
* [x] Add Settings UI textarea, run button, and result rendering.
* [x] Reuse current selected profile and custom profile data.

### Phase C: Walkthrough Progress <!-- parallelizable: false -->

* [x] Persist walkthrough completion in settings.
* [x] Render completed checklist state on the welcome screen.
* [x] Mark relevant steps complete from checklist/actions.

### Phase D: Release Verification <!-- parallelizable: false -->

* [x] Add release verification API endpoint.
* [x] Add About-panel verification action and result rendering.
* [x] Keep messages clear when no packaged SHA is available locally.

### Phase E: Tests, Docs, Release <!-- parallelizable: false -->

* [x] Add API tests and UI smoke checks.
* [x] Update README and CHANGELOG.
* [x] Bump version, validate, commit, tag, push, and verify remote workflows.
* [x] Create changes and review artifacts, then discover next work.

## Success Criteria

* All four follow-up items are visible in the UI.
* Existing profile persistence remains the source of truth.
* Validation preview and template install paths are covered by tests.
* Local and remote validation pass for the release.