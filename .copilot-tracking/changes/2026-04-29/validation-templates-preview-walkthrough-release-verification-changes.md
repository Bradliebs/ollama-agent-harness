<!-- markdownlint-disable-file -->

# Validation Templates Preview Walkthrough Release Verification Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/validation-templates-preview-walkthrough-release-verification-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all four follow-up items and released v0.1.12 with local and remote validation.

## Added

* Installable validation templates in `src/core/outputValidation.ts`.
* Template list/install and validation preview APIs in `src/web/server.ts`.
* Persisted walkthrough completion in `.harness/settings.json` through web settings.
* Release verification API and About-panel verification UI.
* UI smoke checks for template install, preview rendering, walkthrough completion, and release verification.

## Modified

* `ui/index.html` and `ui/app.js` for visible beginner controls.
* `src/web/server.test.ts` for API coverage.
* `README.md` and `CHANGELOG.md` for v0.1.12 documentation.
* Package metadata to version 0.1.12.

## Validation

* Focused server tests, typecheck, full Jest, build, UI smoke, release notes generation, and release smoke passed locally.
* GitHub CI 25111929853 passed.
* GitHub Release 25111933218 passed.

## Release Summary

v0.1.12 adds one-click validation templates, pasted-answer validation preview, persisted walkthrough progress, and release verification guidance.