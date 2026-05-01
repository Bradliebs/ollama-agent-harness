<!-- markdownlint-disable-file -->
# Auto Validation Selection Template Examples Provenance SHA Fix Suggestions Plan

## User Requests

1. Follow `rpi.prompt.md` with `continue=all`.
2. Implement automatic validation profile selection.
3. Add template result examples.
4. Add final release asset SHA provenance through packaged or companion metadata.
5. Add validation fix suggestions.
6. Keep the work beginner-proof.
7. Push the completed release to GitHub when validated.

## Overview

This plan implements v0.1.13 validation usability and release provenance improvements. It keeps validation deterministic, exposes automatic profile selection with a manual override, and uses a companion manifest for final release zip SHA-256.

## Context Summary

* Repository instructions: `.github/copilot-instructions.md`.
* Skills used: `.github/skills/harness-conventions/SKILL.md`, `.github/skills/testing/SKILL.md`.
* Markdown instructions: HVE Core markdown instructions.
* Commit instructions: HVE Core commit message instructions.
* Research: `.copilot-tracking/research/2026-04-29/auto-validation-selection-template-examples-provenance-sha-fix-suggestions-research.md`.

## Implementation Checklist

### Phase 1 - Validation Core <!-- parallelizable: false -->

- [x] Add deterministic profile suggestion.
- [x] Add template good and bad examples.
- [x] Add finding fix suggestions.
- [x] Add focused core tests.

### Phase 2 - Web API and UI <!-- parallelizable: false -->

- [x] Persist auto-select setting.
- [x] Add suggestion API.
- [x] Apply auto-selection for chat runs.
- [x] Add Settings UI auto-select toggle.
- [x] Render template examples and fix suggestions.
- [x] Add focused server and UI smoke checks.

### Phase 3 - Release Manifest <!-- parallelizable: false -->

- [x] Add companion release manifest generator.
- [x] Update release workflow to publish manifest.
- [x] Update release smoke to verify manifest.
- [x] Read local companion manifest in About metadata when present.

### Phase 4 - Docs and Version <!-- parallelizable: false -->

- [x] Update README.
- [x] Update CHANGELOG.
- [x] Bump package version to 0.1.13.

### Phase 5 - Validation and Release <!-- parallelizable: false -->

- [x] Run focused tests.
- [x] Run typecheck, full tests, build, UI smoke, and release smoke.
- [x] Commit, tag, push, and verify GitHub CI/release.

## Dependencies

* Jest for TypeScript tests.
* Playwright/static UI smoke in `scripts/ui-smoke.js`.
* GitHub Actions release workflow for companion manifest publication.

## Success Criteria

All user requests are fulfilled, validation passes, v0.1.13 is pushed/tagged, and GitHub release verification completes.

## Percent Complete

100% - implementation, local validation, commit, tag, push, and remote release verification are complete.
