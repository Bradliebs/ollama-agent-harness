<!-- markdownlint-disable-file -->
# Validation Trends About Manifest Auto Notice Public Exports Release Assertion Plan

## User Requests

1. Follow `rpi.prompt.md` with `continue=all`.
2. Implement all prior Phase 5 suggested work items.
3. Commit, tag, push, and verify the completed release when validated.

## Overview

Implement v0.1.14 as a focused usability and provenance follow-up to v0.1.13. The work improves output validation observability, makes release manifests visible in the UI, explains automatic profile changes, exposes new validation APIs to package consumers, and hardens release manifest verification.

## Context Summary

* Repository instructions: `.github/copilot-instructions.md`.
* Skills used: `.github/skills/harness-conventions/SKILL.md`, `.github/skills/testing/SKILL.md`.
* Markdown instructions: HVE Core markdown instructions.
* Commit instructions: HVE Core commit message instructions.
* Research: `.copilot-tracking/research/2026-04-29/validation-trends-about-manifest-auto-notice-public-exports-release-assertion-research.md`.

## Implementation Checklist

### Phase 1 - Validation Trends <!-- parallelizable: false -->

- [x] Add validation selection source metadata.
- [x] Summarize and export trends by selection source.
- [x] Add focused eval trace tests.

### Phase 2 - API and UI <!-- parallelizable: false -->

- [x] Include auto-selection source/reason in chat stream.
- [x] Render auto-selection notice in chat activity.
- [x] Render manifest link in About panel.
- [x] Render validation trend drill-down in Learning tab.
- [x] Update server and UI smoke tests.

### Phase 3 - Public Exports and Release Checks <!-- parallelizable: false -->

- [x] Export validation suggestion and template APIs.
- [x] Add export coverage.
- [x] Harden release manifest smoke assertions.
- [x] Update release workflow to smoke manifest before publish.

### Phase 4 - Docs and Version <!-- parallelizable: false -->

- [x] Update README.
- [x] Update CHANGELOG.
- [x] Bump package version to 0.1.14.

### Phase 5 - Validation and Release <!-- parallelizable: false -->

- [x] Run focused tests.
- [x] Run typecheck, full tests, build, UI smoke, and release smoke.
- [ ] Commit, tag, push, and verify GitHub CI/release.

## Dependencies

* Jest for TypeScript tests.
* Playwright/static UI smoke in `scripts/ui-smoke.js`.
* GitHub Actions release workflow for remote validation.

## Success Criteria

All five follow-up items are implemented, local validation passes, v0.1.14 is pushed/tagged, and GitHub release verification completes.

## Percent Complete

100% - committed (8d7c486), tagged v0.1.14, pushed; CI run 25115352616 and Release run 25115356049 both completed successfully.
