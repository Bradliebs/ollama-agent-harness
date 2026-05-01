<!-- markdownlint-disable-file -->
# Auto Validation Selection Template Examples Provenance SHA Fix Suggestions Research

## Scope

Continue all selected v0.1.13 follow-up work items:

1. Automatic validation profile selection with visible override.
2. Template result examples.
3. Release provenance final asset SHA through a companion manifest.
4. Validation fix suggestions after preview failure.

## Assumptions

* Output validation remains deterministic structural validation, not truth verification.
* The final SHA-256 of a zip cannot be embedded inside the same zip without changing the digest.
* A companion manifest uploaded beside the release zip is the honest final-asset digest path.
* Beginner-proof UI should expose automatic behavior and a manual override.

## Evidence Log

* `src/core/outputValidation.ts` contains built-in and custom profile validation logic and is the right home for deterministic profile suggestion and finding suggestions.
* `src/web/server.ts` already owns settings, templates, preview, chat configuration, and About provenance APIs.
* `ui/index.html` and `ui/app.js` already render Output Validation settings, template install, and preview flows.
* `.github/workflows/release.yml` packages the zip before release notes and can generate a post-package companion SHA manifest.
* `scripts/release-smoke.js` validates release archives and can verify a companion manifest when supplied.

## Selected Approach

* Add `suggestOutputValidationProfile` to the validation core with deterministic prompt-intent rules.
* Persist `outputValidation.autoSelect` and apply auto-selection in the server chat path and UI before send.
* Add template `examples.good` and `examples.bad` metadata to installable validation templates.
* Enrich output validation findings with plain-English `suggestion` text.
* Add `scripts/release-manifest.js` and publish `*.zip.sha256.json` beside the release zip.

## Success Criteria

* Users can leave validation on auto-select or turn it off and choose a profile manually.
* Templates show good and bad examples in Settings.
* Preview failures show concrete fix suggestions.
* Release workflow uploads a companion SHA manifest and post-publish smoke validates it.
* Focused tests, typecheck, full tests, build, UI smoke, and release smoke pass.

## Percent Complete

100% - research complete for the v0.1.13 implementation cycle.
