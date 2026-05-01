<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Planning Log

## Selected Path

Use one consolidated discovery endpoint and one browser tab rather than scattering each new primitive across separate screens.

## Alternatives Considered

* Add panels only to Settings. Rejected because discovery is operational status, not just configuration.
* Add several dedicated pages. Rejected because the current UI is a single-page app with left tabs and right settings.
* Enable plugin activation. Rejected for this pass because execution policy needs a separate trust model.

## Discrepancy Log

* No unresolved discrepancies. The UI smoke script initially failed due to assertion plumbing, not product behavior; it was fixed and rerun successfully.

## Validation Results

* Targeted web Jest passed: 1 suite and 50 tests.
* Typecheck passed.
* Full Jest passed: 34 suites and 225 tests.
* Build passed.
* UI smoke passed after the smoke assertion fix.
* Diagnostics passed for changed source, test, and script files. `ui/index.html` still reports one pre-existing inline-style warning unrelated to this change.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%