<!-- markdownlint-disable-file -->

# Bootstrapper Interactive Smoke Doctor Notes Details

## References

* Research: `.copilot-tracking/research/2026-04-29/bootstrapper-interactive-smoke-doctor-notes-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/bootstrapper-interactive-smoke-doctor-notes-plan.instructions.md`

## File Operations

* Modify `start.bat`.
* Modify `scripts/release-smoke.js`.
* Modify `scripts/ui-smoke.js`.
* Add `scripts/release-notes.js`.
* Modify `ui/index.html` and `ui/app.js`.
* Modify `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
* Modify `package.json` and `package-lock.json`.
* Update README if needed.

## Validation Commands

* `npm install` or equivalent dependency update for Playwright.
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`
* `npm run release:notes -- --version v<version> --output release/release-notes.md`
* `npm run smoke:release -- release/ollama-agent-harness-v<version>.zip`

## Publish Steps

* Commit and push to `master`.
* Bump package patch version for a fresh release.
* Tag the new version and verify GitHub CI plus release workflow.
