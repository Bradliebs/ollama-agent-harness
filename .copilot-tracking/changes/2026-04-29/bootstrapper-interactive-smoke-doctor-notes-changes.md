<!-- markdownlint-disable-file -->

# Bootstrapper Interactive Smoke Doctor Notes Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/bootstrapper-interactive-smoke-doctor-notes-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Implemented all four continuation items: release bootstrapper, interactive Playwright UI smoke in CI, Settings setup doctor, and release notes generated from changes logs with a tracked changelog fallback. Published `v0.1.5` with changelog-derived release notes and asset `ollama-agent-harness-v0.1.5.zip`.

## Added

* `scripts/release-notes.js` - generates release notes from local `.copilot-tracking/changes` or tracked `CHANGELOG.md` fallback.
* `CHANGELOG.md` - tracked changelog content generated from local RPI changes logs for GitHub Actions release publishing.

## Modified

* `start.bat` - added Node/npm checks, dependency installation, build fallback, default port, and compiled server startup.
* `scripts/release-smoke.js` - validates release notes script and bootstrapper expectations in the archive.
* `scripts/ui-smoke.js` - runs interactive Playwright smoke when installed and validates first-run health, Settings doctor, Learning panel, and duplicate ids.
* `ui/index.html` - added Settings setup doctor controls and result panel.
* `ui/app.js` - added `checkSettingsHealth()` using `/api/setup/health`.
* `.github/workflows/ci.yml` - installs Chromium and runs interactive UI smoke.
* `.github/workflows/release.yml` - generates release notes and publishes them through `body_path`.
* `package.json` and `package-lock.json` - added release scripts, Playwright dependency, and version `0.1.5`.
* `.gitignore` - allowlisted intentional JavaScript assets.

## Removed

* No source files removed.

## Deviations

* `v0.1.4` was published successfully but used the latest-commit fallback release body because `.copilot-tracking/changes` is local-only in GitHub Actions.
* A tracked `CHANGELOG.md` fallback and corrective `v0.1.5` release were added to satisfy release notes from changes logs in CI.
* The published `v0.1.5` release body was edited in place after a generator cleanup to remove a duplicate `Validation` heading.

## Validation

* `npm run typecheck` passed.
* `npm test -- --runInBand` passed, 23 suites and 118 tests.
* `npm run build` passed.
* Interactive UI smoke passed locally in Playwright mode.
* Local release archive smoke passed for `v0.1.5`.
* GitHub CI run `25100958315` passed for commit `791822d`.
* GitHub CI run `25101205312` passed for final generator cleanup commit `95a93ee`.
* GitHub Release run `25100969755` passed for tag `v0.1.5`.
* GitHub release body for `v0.1.5` contains changelog sections, no latest-commit fallback, and one `Validation` section.

## Release Summary

Release `v0.1.5` is published at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.5` with asset `ollama-agent-harness-v0.1.5.zip`.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%
