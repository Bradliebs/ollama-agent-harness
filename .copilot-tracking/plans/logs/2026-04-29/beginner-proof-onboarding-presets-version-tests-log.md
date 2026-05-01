<!-- markdownlint-disable-file -->

# Beginner Proof Onboarding Presets Version Tests Planning Log

## Discrepancy Log

No discrepancies at planning time.

## Implementation Notes

* UI smoke initially clicked the new walkthrough `Check setup` text instead of the first-run setup doctor button because the visible text was duplicated.
* Resolution: tightened the smoke selector to `#firstRunSetup button:has-text("Check setup")` and reran UI smoke successfully.

## Implementation Paths Considered

* Selected: browser-level preset import/export through existing custom profile API, avoiding a second profile persistence path.
* Selected: release archive provenance file plus `/api/about`, avoiding runtime network calls to GitHub for installed metadata.
* Selected: extend existing smoke script rather than adding a separate UI test harness.

## Validation Plan

Focused web server tests, typecheck, full Jest, build, UI smoke, release notes generation, release archive smoke, GitHub CI, and GitHub Release.

## Validation Results

* Focused web server tests passed: 28 tests.
* TypeScript typecheck passed.
* Full Jest passed: 24 suites, 143 tests.
* Build passed.
* UI smoke passed locally at `http://127.0.0.1:4320/`, including guided profile creation.
* Release notes generation and release archive smoke passed locally for v0.1.11.
* GitHub Release 25110968666 passed, including published asset verification.
* GitHub CI 25110966048 passed, including browser UI smoke.