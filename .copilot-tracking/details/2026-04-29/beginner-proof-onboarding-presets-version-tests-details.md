<!-- markdownlint-disable-file -->

# Beginner Proof Onboarding Presets Version Tests Details

## Context References

* Plan: `.copilot-tracking/plans/2026-04-29/beginner-proof-onboarding-presets-version-tests-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-29/beginner-proof-onboarding-presets-version-tests-research.md`

## Phase Details

### Phase A

Update `ui/index.html` and `welcomeMarkup()` in `ui/app.js` with a compact checklist. Add action handlers in `ui/app.js`.

### Phase B

Add import/export buttons and hidden file input under Output Validation. Implement `downloadOutputValidationProfilesPreset`, `importOutputValidationProfilesPreset`, and `handleOutputValidationProfilesPresetFile`.

### Phase C

Add `release-provenance.json` support, `/api/about`, and Settings/About rendering. Update Release workflow and release smoke.

### Phase D

Extend `scripts/ui-smoke.js` with Playwright form interaction checks and static function/id checks. Extend `src/web/server.test.ts` for `/api/about`.

### Phase E

Update docs, validate locally, release, verify remote workflows, then update RPI changes/review artifacts.