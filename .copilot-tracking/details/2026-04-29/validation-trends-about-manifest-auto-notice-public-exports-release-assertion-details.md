<!-- markdownlint-disable-file -->
# Validation Trends About Manifest Auto Notice Public Exports Release Assertion Details

## Context References

* Plan: `.copilot-tracking/plans/2026-04-29/validation-trends-about-manifest-auto-notice-public-exports-release-assertion-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-29/validation-trends-about-manifest-auto-notice-public-exports-release-assertion-research.md`
* Planning log: `.copilot-tracking/plans/logs/2026-04-29/validation-trends-about-manifest-auto-notice-public-exports-release-assertion-log.md`

## Phase Details

### Phase 1 - Validation Trends

* Modify `src/learning/evalTrace.ts` to include selection source metadata in output validation runs and trend summaries.
* Update `src/learning/evalTrace.test.ts` for auto/manual source summary and export data.

### Phase 2 - API and UI

* Modify `src/web/server.ts` to compute an effective validation profile with source/reason metadata and stream an auto-selection event.
* Modify `ui/app.js` to render the auto-selection event, manifest link, and source drill-down.
* Update `src/web/server.test.ts` and `scripts/ui-smoke.js` for the new API/UI behavior.

### Phase 3 - Public Exports and Release Checks

* Modify `src/index.ts` to export `suggestOutputValidationProfile`, `OUTPUT_VALIDATION_PROFILE_TEMPLATES`, and related template types.
* Modify `scripts/release-smoke.js` to assert companion manifest fields beyond digest matching.
* Update `.github/workflows/release.yml` so release manifest smoke runs before publish as well as after download.

### Phase 4 - Docs and Version

* Update `README.md` to describe validation source trends, manifest link, auto-selection notices, public exports, and stricter manifest checks.
* Update `CHANGELOG.md` with v0.1.14.
* Bump `package.json` and `package-lock.json`.

### Phase 5 - Validation and Release

* Run focused tests first, then typecheck, full Jest, build, UI smoke, and release smoke.
* Commit tracked source changes only.
* Tag and push `v0.1.14`.
* Verify GitHub CI and release workflow completion.

## Percent Complete

100% - all phases executed; remote release verified (Release run 25115356049 success, including Verify published release asset).
