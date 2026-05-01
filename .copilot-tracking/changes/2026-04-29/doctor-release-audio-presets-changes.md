<!-- markdownlint-disable-file -->

# Doctor Release Audio Presets Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/doctor-release-audio-presets-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Added a shared setup health module, `harness doctor`, optional audio sample validation, release archive smoke testing, compiled release startup, and beginner model preset documentation. Published commit `c069787` and verified `v0.1.3` release automation.

## Added

* `src/setup/health.ts` - shared setup readiness checks for Ollama, vision models, and audio transcription.
* `src/setup/health.test.ts` - coverage for shared setup health and audio sample validation.
* `src/cli/index.test.ts` - coverage for doctor option parsing and terminal output formatting.
* `scripts/release-smoke.js` - release zip smoke validation for archive contents, CLI help, and compiled web startup.
* `docs/MODEL-PRESETS.md` - beginner model recommendations for coding, helper routing, vision, summarization, and audio transcription.

## Modified

* `src/cli/index.ts` - added `harness doctor` and reusable CLI parsing/formatting exports.
* `src/web/server.ts` - reused shared setup health and accepted optional audio sample paths.
* `src/web/server.test.ts` - validated audio sample transcription through `/api/setup/health`.
* `ui/index.html` and `ui/app.js` - added first-run audio test file input and query parameter handling.
* `scripts/ui-smoke.js` - checked the new first-run audio test file input.
* `.github/workflows/release.yml` - ran archive smoke before release publication.
* `package.json` - added `serve` and `smoke:release`, bumped version to `0.1.3`.
* `package-lock.json` - updated version metadata to `0.1.3`.
* `start.bat` - started the compiled web server with `npm run serve`.
* `README.md` - linked model presets and described audio sample readiness.
* `.gitignore` - allowed `scripts/release-smoke.js` to be tracked.

## Validation

* `npm test -- --runInBand src/setup/health.test.ts src/web/server.test.ts src/cli/index.test.ts` passed.
* `npm run typecheck` passed.
* `npm test -- --runInBand` passed.
* `npm run build` passed.
* `npm run smoke:ui -- http://127.0.0.1:3113/` passed.
* Local release archive smoke passed.
* GitHub CI completed successfully on `master`.
* GitHub Release completed successfully for `v0.1.3` with archive smoke.

## Release Summary

Release `v0.1.3` is published at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.3` with asset `ollama-agent-harness-v0.1.3.zip`.