<!-- markdownlint-disable-file -->

# Beginner Proof Validation UX Export Provenance Plan

## User Requests

1. Continue all prior suggested work items.
2. Make the result beginner-proof in every aspect.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Research: `.copilot-tracking/research/2026-04-29/beginner-proof-validation-ux-export-provenance-research.md`.

## Implementation Checklist

### Phase A: Guided Profile Form <!-- parallelizable: false -->

* [x] Add beginner-friendly profile form markup and stable element IDs.
* [x] Add form-to-profile serialization and JSON synchronization.
* [x] Add load/reset/add check actions.

### Phase B: Trend Export <!-- parallelizable: false -->

* [x] Add output-validation trend export payload helper.
* [x] Add web API download endpoint.
* [x] Add Learning panel download button.

### Phase C: Release Provenance <!-- parallelizable: false -->

* [x] Extend release notes generation with commit and asset provenance.
* [x] Pass asset and commit details from the release workflow.

### Phase D: Docs, Tests, Release <!-- parallelizable: false -->

* [x] Update README, changelog, smoke checks, and package version.
* [x] Run focused tests, typecheck, full Jest, build, UI smoke, release notes, and release smoke.
* [x] Commit, tag, push, and verify GitHub CI and Release.

### Phase F: Release Note Pruning Iteration <!-- parallelizable: false -->

* [x] Fix changelog fallback release notes to include only the requested version section.
* [x] Correct the published v0.1.8 release body with matching published-asset provenance.
* [x] Commit, tag, push, and verify v0.1.9 CI and Release.
* [x] Harden changelog fallback extraction with line-based section parsing.
* [x] Correct the published v0.1.8 and v0.1.9 release bodies after the extraction hardening.
* [x] Commit, tag, push, and verify v0.1.10 CI and Release.

### Phase E: Review And Discover <!-- parallelizable: false -->

* [x] Record changes and review artifacts.
* [x] Complete Phase 5 discovery.

## Success Criteria

* Custom profiles can be authored through controls without JSON knowledge.
* Validation trends can be exported from the UI and API.
* Release notes include provenance for the commit and release asset.
* Local and remote validation pass.
