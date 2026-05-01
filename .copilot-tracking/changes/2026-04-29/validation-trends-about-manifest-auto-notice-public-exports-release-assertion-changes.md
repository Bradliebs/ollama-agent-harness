<!-- markdownlint-disable-file -->
# Validation Trends About Manifest Auto Notice Public Exports Release Assertion Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/validation-trends-about-manifest-auto-notice-public-exports-release-assertion-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented v0.1.14 validation observability and release provenance follow-ups.

## Added

None.

## Modified

* `.github/workflows/release.yml`
* `CHANGELOG.md`
* `README.md`
* `package-lock.json`
* `package.json`
* `scripts/release-smoke.js`
* `scripts/ui-smoke.js`
* `src/core/outputValidation.test.ts`
* `src/index.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/evalTrace.ts`
* `src/web/server.test.ts`
* `src/web/server.ts`
* `ui/app.js`

## Removed

None expected.

## Validation

Focused tests, typecheck, full Jest, build, UI smoke, and local release smoke passed.

## Percent Complete

100% - committed as 8d7c486, tag v0.1.14 pushed, CI (25115352616) and Release (25115356049) workflows completed successfully on Bradliebs/ollama-agent-harness.
