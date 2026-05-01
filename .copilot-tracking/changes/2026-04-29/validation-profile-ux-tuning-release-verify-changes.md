<!-- markdownlint-disable-file -->

# Validation Profile UX Tuning Release Verify Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/validation-profile-ux-tuning-release-verify-plan.instructions.md`

## Summary

Implemented all continued work items: profile schema UX, validator tuning, and published release asset verification.

## Modified Files

* `.github/workflows/release.yml`
* `CHANGELOG.md`
* `README.md`
* `package-lock.json`
* `package.json`
* `scripts/ui-smoke.js`
* `src/core/outputValidation.test.ts`
* `src/core/outputValidation.ts`
* `src/web/server.test.ts`
* `src/web/server.ts`
* `ui/app.js`

## Validation

* Focused Jest passed.
* Typecheck passed.
* Full Jest passed.
* Build passed.
* UI smoke passed.
* Local release archive smoke passed.
* GitHub CI passed.
* GitHub Release passed with post-publish asset verification.

## Release Summary

Release `v0.1.7` is published at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.7` with asset `ollama-agent-harness-v0.1.7.zip`.
