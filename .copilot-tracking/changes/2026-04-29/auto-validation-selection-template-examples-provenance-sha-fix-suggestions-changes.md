<!-- markdownlint-disable-file -->
# Auto Validation Selection Template Examples Provenance SHA Fix Suggestions Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/auto-validation-selection-template-examples-provenance-sha-fix-suggestions-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented v0.1.13 validation guidance and release provenance improvements.

## Added

* `scripts/release-manifest.js` - generates a companion JSON manifest for final release archive SHA-256.

## Modified

* `src/core/outputValidation.ts` - adds deterministic profile suggestion, template examples, and finding suggestions.
* `src/core/outputValidation.test.ts` - covers profile suggestion, examples, and suggestions.
* `src/web/server.ts` - adds auto-select settings, suggestion API, chat auto-selection, and companion manifest reads.
* `src/web/server.test.ts` - covers suggestion API, template examples, and preview fix suggestions.
* `ui/index.html` - adds auto-select toggle and template-example styling.
* `ui/app.js` - renders examples and suggestions, persists auto-select, and updates profile before send.
* `scripts/ui-smoke.js` - verifies auto-select controls, template examples, and suggestions.
* `scripts/release-smoke.js` - validates a companion SHA manifest when provided.
* `.github/workflows/release.yml` - generates, uploads, downloads, and smoke-tests the companion manifest.
* `package.json` and `package-lock.json` - bump to 0.1.13 and add `release:manifest`.
* `README.md` - documents auto-selection, examples, fix suggestions, and companion manifests.
* `CHANGELOG.md` - adds v0.1.13 release notes.

## Removed

None.

## Validation

* `npm test -- --runInBand src/core/outputValidation.test.ts src/web/server.test.ts` - passed, 49 tests.
* `npm run typecheck` - passed.
* `npm test -- --runInBand` - passed, 24 suites and 151 tests.
* `npm run build` - passed.
* `npm run smoke:ui -- http://127.0.0.1:4320/` - passed.
* Local release archive plus `*.zip.sha256.json` manifest smoke - passed.

## Deviations

* Used a companion manifest rather than embedding final zip SHA in the zip because embedding changes the final digest.

## Percent Complete

100% - implementation and local validation complete.
