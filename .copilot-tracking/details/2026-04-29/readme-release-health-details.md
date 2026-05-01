<!-- markdownlint-disable-file -->

# README Release Health Details

## References

* Research: `.copilot-tracking/research/2026-04-29/readme-release-health-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/readme-release-health-plan.instructions.md`

## File Operations

* Modify `README.md`.
* Modify `src/web/server.ts` and `src/web/server.test.ts`.
* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js`.
* Add `.github/workflows/release.yml`.
* Bump package metadata to `0.1.2`.

## Validation Commands

* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Publish Steps

* Commit and push to `master`.
* Tag `v0.1.2`.
* Push tag and verify GitHub release workflow.
