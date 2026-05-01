<!-- markdownlint-disable-file -->

# Setup Flow CI Release Assets Details

## References

* Research: `.copilot-tracking/research/2026-04-29/setup-flow-ci-release-assets-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/setup-flow-ci-release-assets-plan.instructions.md`

## File Operations

* Modify `ui/index.html`.
* Modify `ui/app.js`.
* Modify `scripts/ui-smoke.js`.
* Add `.github/workflows/ci.yml`.

## Validation Commands

* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`

## Release Asset Commands

* Build project with `npm run build`.
* Package selected files into a zip under `release/`.
* Upload the zip to `v0.1.0` with `gh release upload --clobber`.
