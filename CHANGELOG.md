---
title: Ollama Agent Harness Changelog
description: Release notes generated from local RPI changes logs for Ollama Agent Harness
author: Bradliebs
ms.date: 2026-04-29
ms.topic: reference
keywords:
	- ollama
	- release notes
	- changelog
estimated_reading_time: 8
---

## Ollama Agent Harness v0.1.6

## Changes

### Output Validation Profiles And Trends Changes

Added output-validation documentation, custom deterministic profile authoring, validation trend summaries in the Learning panel, and release validation for the output-validation feature set.

* `README.md` - documented output-validation profiles, CLI usage, custom profile JSON, and structural validation limits.
* `src/core/outputValidation.ts` - added custom profile definitions with deterministic text and length checks.
* `src/core/queryLoop.ts` - pairs custom profile instructions with the final-answer validation path.
* `src/learning/evalTrace.ts` - summarizes output-validation run trends by profile and validation status.
* `src/web/server.ts` - exposes custom profile APIs, loads `.harness/output-validation-profiles.json`, and includes validation trend payloads.
* `ui/app.js` and `ui/index.html` - add custom profile editing controls and output-validation trend rendering.
* `scripts/ui-smoke.js` - validates the new profile authoring and trend UI hooks.

## Validation

* Focused output-validation Jest suites and TypeScript typecheck passed locally before release packaging.

## Ollama Agent Harness v0.1.5

## Changes

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

### Vision Audio Replay Links GitHub Changes

Completed all requested follow-up work and pushed the repository to GitHub.

* `src/tools/multimodalTools.ts`
* `src/tools/multimodalTools.test.ts`
* GitHub remote: `https://github.com/Bradliebs/ollama-agent-harness.git`
* `src/tools/index.ts`
* `src/index.ts`

### Replay Multimodal Beginner UX Changes

Implemented all latest follow-ups plus the beginner-focused multimodal and recovery UX request: live/mock replay adapter support, weather source ranking, replay source links, model media capability hints, image/audio attachment affordances, and clearer Resume/Fork recovery copy.

* `.copilot-tracking/research/2026-04-29/replay-multimodal-beginner-ux-research.md`
* `.copilot-tracking/plans/2026-04-29/replay-multimodal-beginner-ux-plan.instructions.md`
* `.copilot-tracking/details/2026-04-29/replay-multimodal-beginner-ux-details.md`
* `.copilot-tracking/plans/logs/2026-04-29/replay-multimodal-beginner-ux-log.md`
* `src/learning/evalTrace.ts`

### Weather Context Replay Evals Changes

Implemented all three continuation items: sparse weather fallback extraction, detected context visibility, and replayable eval examples for weather regressions.

* `src/tools/webSearchTool.test.ts`
* `src/tools/webSearchTool.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/web/server.ts`

### Eval Runner Provenance Calibration Smoke Changes

Implemented all four continuation items: eval runner and trends, candidate provenance details, apply-calibration workflow, and expanded Learning panel smoke coverage.

* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`
* `src/web/server.ts`

## Validation

* Typecheck, tests, build, and release archive smoke are expected to pass before publishing.
