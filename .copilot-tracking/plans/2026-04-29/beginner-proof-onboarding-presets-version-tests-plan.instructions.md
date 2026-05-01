<!-- markdownlint-disable-file -->

# Beginner Proof Onboarding Presets Version Tests Plan

## User Requests

1. Continue all prior suggested work items.
2. Keep the result beginner-proof in every aspect.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Research: `.copilot-tracking/research/2026-04-29/beginner-proof-onboarding-presets-version-tests-research.md`.

## Implementation Checklist

### Phase A: Guided Walkthrough <!-- parallelizable: false -->

* [x] Add welcome and Settings checklist UI.
* [x] Add walkthrough actions that open the correct panels or tabs.
* [x] Keep checklist copy concise and task-oriented.

### Phase B: Profile Preset Import Export <!-- parallelizable: false -->

* [x] Add visible preset export and import controls.
* [x] Add browser handlers that download/import preset JSON and reuse existing profile save validation.
* [x] Add clear status messages for import/export outcomes.

### Phase C: Installed Version Panel <!-- parallelizable: false -->

* [x] Add `/api/about` endpoint with version and provenance.
* [x] Add release provenance generation to the release workflow and archive contents.
* [x] Add Settings/About UI rendering.

### Phase D: Interaction Coverage <!-- parallelizable: false -->

* [x] Extend UI smoke for guided profile creation interactions.
* [x] Extend API/server tests for about metadata.
* [x] Update release smoke for provenance file checks.

### Phase E: Docs, Release, Review <!-- parallelizable: false -->

* [x] Update README and CHANGELOG.
* [x] Run focused tests, typecheck, full Jest, build, UI smoke, release notes, and release smoke.
* [x] Commit, tag, push, verify GitHub CI and Release.
* [x] Record changes, review, and discovery.

## Success Criteria

* All four selected follow-ups are implemented through visible beginner-facing controls.
* Release provenance is visible from installed builds and included in release archives.
* Interaction smoke proves the guided profile form can create and save a profile.
* Local and remote validation pass.