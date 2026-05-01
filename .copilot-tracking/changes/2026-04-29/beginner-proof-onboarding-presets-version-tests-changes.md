<!-- markdownlint-disable-file -->

# Beginner Proof Onboarding Presets Version Tests Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/beginner-proof-onboarding-presets-version-tests-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all selected follow-up items and released v0.1.11 with remote CI and Release verification.

## Added

* First-run walkthrough checklist in the welcome screen.
* Walkthrough navigation actions for setup, validation, learning trends, and About.
* Profile preset download/import controls and handlers.
* `/api/about` endpoint for installed version and release provenance metadata.
* Settings About panel.
* Release archive provenance file generation in the Release workflow.
* Release smoke validation for `release-provenance.json`.
* UI smoke interaction coverage for guided profile creation.

## Modified

* `README.md` and `CHANGELOG.md` for the new beginner-facing workflows.
* `src/web/server.test.ts` for About API coverage.
* `scripts/ui-smoke.js` for new UI controls and Playwright interactions.
* Package metadata to version 0.1.11.

## Validation

* Local focused web server tests, typecheck, full Jest, build, UI smoke, release notes generation, and release smoke passed.
* Remote GitHub CI 25110966048 passed.
* Remote GitHub Release 25110968666 passed.

## Release Summary

v0.1.11 adds visible onboarding, profile preset import/export, installed-version metadata, release archive provenance, and guided form interaction coverage.