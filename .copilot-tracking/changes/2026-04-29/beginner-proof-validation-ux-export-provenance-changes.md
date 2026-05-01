<!-- markdownlint-disable-file -->

# Beginner Proof Validation UX Export Provenance Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/beginner-proof-validation-ux-export-provenance-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Completed the beginner-proof validation experience, release provenance, and follow-up release-note pruning and extraction hardening iterations. Published and verified v0.1.8, then corrected and hardened the release-note fallback behavior through v0.1.10.

## Added

* Guided custom validation profile form controls in `ui/index.html`.
* Form serialization, profile picker, validation trend download, and supporting handlers in `ui/app.js`.
* Output-validation trend export payload in `src/learning/evalTrace.ts`.
* Download endpoint at `/api/learning/output-validation-trends/download` in `src/web/server.ts`.
* Release provenance output in generated release notes.

## Modified

* `src/learning/evalTrace.test.ts` and `src/web/server.test.ts` for trend export coverage.
* `scripts/ui-smoke.js` for guided form and trend export smoke checks.
* `.github/workflows/release.yml` to pass release asset and commit details into release notes.
* `README.md` and `CHANGELOG.md` for user-facing documentation.
* `package.json` and `package-lock.json` to release v0.1.8 and v0.1.9.
* `scripts/release-notes.js` to add provenance, prune changelog fallback output to the requested version section, and parse fallback sections by heading boundaries.

## Removed

No source files removed.

## Validation

* Local v0.1.8 validation: focused Jest, typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke.
* Remote v0.1.8 validation: GitHub CI 25110065588 and Release 25110067017 passed.
* Local v0.1.9 validation: release notes fallback generation, typecheck, full Jest, build, release notes generation, and release archive smoke.
* Remote v0.1.9 validation: GitHub CI 25110242257 and Release 25110243703 passed.
* Local v0.1.10 validation: release notes fallback generation, typecheck, full Jest, build, release notes generation, and release archive smoke.
* Remote v0.1.10 validation: GitHub CI 25110437920 and Release 25110439736 passed.

## Release Summary

* v0.1.8: beginner-friendly validation profile authoring, validation trend export, and release provenance.
* v0.1.9: concise CI fallback release notes and corrected published release-note experience.
* v0.1.10: hardened fallback extraction and corrected published v0.1.8/v0.1.9 release bodies.