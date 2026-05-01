<!-- markdownlint-disable-file -->

# README Release Health Changes

## Related Plan

`.copilot-tracking/plans/2026-04-29/readme-release-health-plan.instructions.md`

## Implementation Date

2026-04-29

## Summary

Added first-run setup health checks, release badges, and a tag-triggered GitHub release packaging workflow. Published commit `2253926` and verified `v0.1.2` release automation.

## Added

* `.github/workflows/release.yml` - validates, builds, packages, and publishes release zip assets on `v*.*.*` tags.

## Modified

* `README.md` - added CI and release badges plus latest release link.
* `package.json` - bumped version to `0.1.2`.
* `package-lock.json` - bumped lockfile version metadata to `0.1.2`.
* `scripts/ui-smoke.js` - added first-run health element and function checks.
* `src/web/server.ts` - added `/api/setup/health` readiness checks for Ollama, configured vision model, and audio helper configuration.
* `src/web/server.test.ts` - added setup health API tests and increased suite timeout for full-run stability.
* `ui/app.js` - added first-run setup health request and result rendering.
* `ui/index.html` - added first-run setup health button and result container.

## Validation

* `npm test -- --runInBand src/web/server.test.ts` passed.
* `npm run typecheck` passed.
* `npm test -- --runInBand` passed.
* `npm run build` passed.
* `npm run smoke:ui -- http://127.0.0.1:3112/` passed.
* GitHub CI completed successfully on `master`.
* GitHub Release completed successfully for `v0.1.2`.

## Release Summary

Release `v0.1.2` is published at `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.2` with asset `ollama-agent-harness-v0.1.2.zip`.