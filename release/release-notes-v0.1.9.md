# Ollama Agent Harness v0.1.9

## Changes

### Validation Profile UX Tuning Release Verify Changes

Implemented all continued work items: profile schema UX, validator tuning, and published release asset verification.

### Validation Docs Trends Profiles Release Changes

Implemented documentation, validation trend summaries, custom deterministic output-validation profile authoring, and local release validation for v0.1.6.

* `README.md` - added output-validation usage, profile descriptions, CLI example, custom profile JSON format, and structural-validation caveat.
* `CHANGELOG.md` - added v0.1.6 release notes.
* `package.json` - bumped version to 0.1.6.
* `package-lock.json` - bumped version metadata to 0.1.6.
* `src/core/outputValidation.ts` - added custom profile normali

### Output Validation Profiles Evals UX Changes

Implemented all four continuation items: additional output-validation profiles, prompt pairing, validation eval run persistence, and grouped validator UX.

* `src/core/outputValidation.ts`
* `src/core/outputValidation.test.ts`
* `scripts/ui-smoke.js`
* `src/cli/index.ts`
* `src/cli/index.test.ts`

### Bootstrapper Interactive Smoke Doctor Notes Changes

Implemented all four continuation items: release bootstrapper, interactive Playwright UI smoke in CI, Settings setup doctor, and release notes generated from changes logs with a tracked changelog fallback. Published `v0.1.5` with changelog-derived release notes and asset `ollama-agent-harness-v0.1.5.

* `scripts/release-notes.js` - generates release notes from local `.copilot-tracking/changes` or tracked `CHANGELOG.md` fallback.
* `CHANGELOG.md` - tracked changelog content generated from local RPI changes logs for GitHub Actions release publishing.
* `start.bat` - added Node/npm checks, dependency installation, build fallback, default port, and compiled server startup.
* `scripts/release-smoke.js` - validates release notes script and bootstrapper expectations in the archive.
* `scripts/ui-smoke.js` - runs interactive Playwright smoke when installed and validates first-run health, Settings doctor, Learning panel, and duplicate ids.

### Doctor Release Audio Presets Changes

Added a shared setup health module, `harness doctor`, optional audio sample validation, release archive smoke testing, compiled release startup, and beginner model preset documentation. Published commit `c069787` and verified `v0.1.3` release automation.

* `src/setup/health.ts` - shared setup readiness checks for Ollama, vision models, and audio transcription.
* `src/setup/health.test.ts` - coverage for shared setup health and audio sample validation.
* `src/cli/index.test.ts` - coverage for doctor option parsing and terminal output formatting.
* `scripts/release-smoke.js` - release
* `src/cli/index.ts` - added `harness doctor` and reusable CLI parsing/formatting exports.

### README Release Health Changes

Added first-run setup health checks, release badges, and a tag-triggered GitHub release packaging workflow. Published commit `2253926` and verified `v0.1.2` release automation.

* `.github/workflows/release.yml` - validates, builds, packages, and publishes release
* `README.md` - added CI and release badges plus latest release link.
* `package.json` - bumped version to `0.1.2`.
* `package-lock.json` - bumped lockfile version metadata to `0.1.2`.
* `scripts/ui-smoke.js` - added first-run health element and function checks.

### Setup Flow CI Release Assets Changes

Completed all continued work from the prior Suggested Next Work list.

* `.github/workflows/ci.yml`
* First-run setup panel in the browser welcome screen
* Release `v0.1.1` with `ollama-agent-harness-v0.1.1.
* `package.json`
* `package-lock.json`

### Media Settings Release Baseline Changes

Completed all continued work from the prior Suggested Next Work list.

* `README.md`
* Media tool settings in the browser Settings panel
* Git tag and GitHub release: `v0.1.0`
* `src/web/server.ts`
* `src/web/server.test.ts`

## Validation

* Typecheck, tests, build, and release archive smoke are expected to pass before publishing.

## Release Provenance

* Commit: `f93c0731e91aafe119c6d03447e5b0c58c315cda`
* Asset: `ollama-agent-harness-v0.1.9.zip`
* Asset size: 269110 bytes
* Asset SHA-256: `64a244d26ca1631e6d4937f169ff2d1358945407d0ebcbb95080922fd7044238`
