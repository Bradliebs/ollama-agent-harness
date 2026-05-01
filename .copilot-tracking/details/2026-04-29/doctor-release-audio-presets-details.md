<!-- markdownlint-disable-file -->

# Doctor Release Audio Presets Details

## References

* Research: `.copilot-tracking/research/2026-04-29/doctor-release-audio-presets-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/doctor-release-audio-presets-plan.instructions.md`

## File Operations

* Add `src/setup/health.ts` and tests.
* Modify `src/web/server.ts` and `src/web/server.test.ts`.
* Modify `src/cli/index.ts` and add tests as needed.
* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js`.
* Add `scripts/release-smoke.js`.
* Modify `.github/workflows/release.yml`, `package.json`, and `start.bat`.
* Add `docs/MODEL-PRESETS.md` and update `README.md`.

## Validation Commands

* `npm test -- --runInBand src/setup/health.test.ts src/web/server.test.ts src/cli/index.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`
* `npm run smoke:release -- release/ollama-agent-harness-v<version>.zip` when a local package is available

## Publish Steps

* Commit and push to `master`.
* If package version changes, tag the new release and verify GitHub CI plus release workflow.
