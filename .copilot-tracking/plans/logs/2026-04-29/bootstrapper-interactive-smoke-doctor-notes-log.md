<!-- markdownlint-disable-file -->

# Bootstrapper Interactive Smoke Doctor Notes Planning Log

## Decisions

* Keep the bootstrapper in `start.bat` because the release archive is currently Windows-oriented and already includes that file.
* Add Playwright as an explicit dev dependency so smoke is interactive by default in CI.
* Reuse `/api/setup/health` for the Settings doctor rather than creating another health endpoint.
* Generate release notes from `.copilot-tracking/changes` when available and use a fallback when those local artifacts are absent in CI.

## Status

Implementation, validation, push, tag, release verification, and release-note correction complete.

## Validation Iterations

* Local `npm run typecheck` passed.
* Local `npm test -- --runInBand` passed, 23 suites and 118 tests.
* Local `npm run build` passed.
* Local interactive UI smoke passed in Playwright mode.
* Local release notes generation passed from `.copilot-tracking/changes` and from the tracked `CHANGELOG.md` fallback.
* Local release archive smoke passed for `v0.1.5`.
* GitHub CI run `25100958315` passed for commit `791822d`.
* GitHub CI run `25101205312` passed for final generator cleanup commit `95a93ee`.
* GitHub Release run `25100969755` passed for `v0.1.5`.

## Publish

* Commit `ba34dd6` added the release bootstrapper, Playwright smoke, Settings doctor, and release-note workflow integration.
* Commit `791822d` added tracked `CHANGELOG.md` fallback support so GitHub Actions can publish changelog-derived notes without local `.copilot-tracking` files.
* Tag `v0.1.5` was pushed and published.
* Release `v0.1.5` is available at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.5`.
* Release asset `ollama-agent-harness-v0.1.5.zip` was uploaded.

## Corrective Notes

* Release `v0.1.4` technically passed but used the latest-commit fallback body because `.copilot-tracking/changes` is local-only in CI.
* The tracked `CHANGELOG.md` fallback corrected that gap for `v0.1.5`.
* A final generator cleanup commit `95a93ee` prevents duplicate `Validation` sections when release notes are generated from `CHANGELOG.md`.
* GitHub CI passed for commit `95a93ee` after the cleanup was pushed.
* The published `v0.1.5` release body was edited in place after regeneration and now has changelog content, no latest-commit fallback, and one `Validation` heading.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%
