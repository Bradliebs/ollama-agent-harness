<!-- markdownlint-disable-file -->

# Doctor Release Audio Presets Plan

## User Requests

1. Continue all prior suggested next work.
2. Add CLI Setup Doctor.
3. Smoke Test Release Archive.
4. Improve Audio Readiness.
5. Document Model Presets.
6. Summarize completion with phases completed, iteration count, artifacts created, and final validation status.

## Context Summary

* Workspace: `c:\AI\Harness`.
* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and commit message instructions loaded from HVE Core instruction files.
* Research: `.copilot-tracking/research/2026-04-29/doctor-release-audio-presets-research.md`.

## Checklist

### Phase A: Shared Setup Health And CLI Doctor <!-- parallelizable: false -->

* [x] Extract setup health checks into a shared module.
* [x] Add `harness doctor` CLI command and help text.
* [x] Add CLI tests for doctor output and failure reporting.

### Phase B: Audio Sample Readiness <!-- parallelizable: false -->

* [x] Add optional audio sample validation to setup health.
* [x] Add first-run UI input for an optional audio test file path.
* [x] Add API and smoke coverage for audio sample readiness.

### Phase C: Release Archive Smoke <!-- parallelizable: false -->

* [x] Add compiled-server start script for release archives.
* [x] Add release archive smoke script.
* [x] Run release archive smoke in the release workflow before publishing.

### Phase D: Model Preset Documentation <!-- parallelizable: false -->

* [x] Add beginner model preset docs.
* [x] Link model presets from README.

### Phase E: Validate And Publish <!-- parallelizable: false -->

* [x] Run local validation.
* [x] Commit and push.
* [x] Tag and verify GitHub CI/release workflow if package version changes.

## Dependencies

* `ollama` package for model list checks.
* Existing `AudioTranscribeTool` for audio sample validation.
* GitHub Actions release workflow for archive smoke.

## Success Criteria

* CLI doctor and web setup health use shared health logic.
* Optional audio sample checks execute the configured transcription command and report pass/fail clearly.
* Release archive smoke validates the generated zip before publish.
* Model presets docs are linked from README.
* Local and remote validation pass.
