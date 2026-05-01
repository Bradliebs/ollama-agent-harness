<!-- markdownlint-disable-file -->
# Auto Validation Selection Template Examples Provenance SHA Fix Suggestions Details

## Context References

* Plan: `.copilot-tracking/plans/2026-04-29/auto-validation-selection-template-examples-provenance-sha-fix-suggestions-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-29/auto-validation-selection-template-examples-provenance-sha-fix-suggestions-research.md`
* Planning log: `.copilot-tracking/plans/logs/2026-04-29/auto-validation-selection-template-examples-provenance-sha-fix-suggestions-log.md`

## Phase Details

### Phase 1 - Validation Core

* Modify `src/core/outputValidation.ts` to add `suggestOutputValidationProfile`, `OutputValidationProfileTemplate`, template examples, and finding suggestions.
* Update `src/core/outputValidation.test.ts` for selector behavior, examples, and fix suggestions.

### Phase 2 - Web API and UI

* Modify `src/web/server.ts` to persist `autoSelect`, expose `/api/output-validation/suggest-profile`, apply effective validation profile during chat, and read companion manifests.
* Modify `ui/index.html` and `ui/app.js` to expose auto-select, template examples, and validation fix suggestions.
* Update `scripts/ui-smoke.js` for static and Playwright coverage.
* Update `src/web/server.test.ts` for suggestion API, examples, and preview suggestions.

### Phase 3 - Release Manifest

* Add `scripts/release-manifest.js`.
* Update `package.json` with `release:manifest`.
* Update `.github/workflows/release.yml` to generate and publish `*.zip.sha256.json`.
* Update `scripts/release-smoke.js` to verify the companion manifest when provided.

### Phase 4 - Docs and Version

* Update `README.md` for auto-select, examples, suggestions, and companion manifests.
* Update `CHANGELOG.md` with v0.1.13.
* Bump `package.json` and `package-lock.json`.

### Phase 5 - Validation and Release

* Run focused tests, typecheck, full tests, build, UI smoke, release manifest generation, and release smoke.
* Commit tracked source changes only.
* Tag and push `v0.1.13`.
* Verify GitHub CI and release workflow completion.
* Commit `92ddf0aec8233b4213b015e5155b4faa65b4ea34` pushed to `master`.
* CI run `25114367461` completed successfully.
* Release run `25114371020` completed successfully.
* Release published: `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.13`.
* Release assets published: `ollama-agent-harness-v0.1.13.zip` and `ollama-agent-harness-v0.1.13.zip.sha256.json`.

## Percent Complete

100% - details captured through remote release verification.
