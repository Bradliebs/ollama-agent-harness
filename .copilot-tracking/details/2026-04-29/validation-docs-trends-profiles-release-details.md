<!-- markdownlint-disable-file -->

# Validation Docs Trends Profiles Release Details

## References

* Research: `.copilot-tracking/research/2026-04-29/validation-docs-trends-profiles-release-research.md`
* Plan: `.copilot-tracking/plans/2026-04-29/validation-docs-trends-profiles-release-plan.instructions.md`

## File Operations

* Modify `src/core/outputValidation.ts` and tests for custom profile definitions.
* Modify `src/core/queryLoop.ts` and types so custom profile definitions flow into validation and prompt pairing.
* Modify `src/learning/evalTrace.ts` and tests for output-validation trend summaries.
* Modify `src/web/server.ts` and tests for custom profile loading, saving, and settings exposure.
* Modify `ui/index.html`, `ui/app.js`, and `scripts/ui-smoke.js` for custom profile authoring and validation trends.
* Modify `README.md`, `CHANGELOG.md`, `package.json`, and `package-lock.json` for release readiness.

## Validation Commands

* `npm test -- --runInBand src/core/outputValidation.test.ts src/core/queryLoop.test.ts src/learning/evalTrace.test.ts src/web/server.test.ts src/cli/index.test.ts`
* `npm run typecheck`
* `npm test -- --runInBand`
* `npm run build`
* `npm run smoke:ui -- http://127.0.0.1:<port>/`
* `npm run release:notes -- --version v0.1.6 --output release/release-notes.md`
* `npm run smoke:release -- release/ollama-agent-harness-v0.1.6.zip`

## Release Steps

* Commit source, docs, package, changelog, and workflow-support changes.
* Tag `v0.1.6`.
* Push `master` and tag.
* Verify GitHub CI and release workflow.
