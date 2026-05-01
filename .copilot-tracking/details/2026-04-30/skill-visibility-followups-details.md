<!-- markdownlint-disable-file -->

# Skill Visibility Followups Details

## File Operations

* `src/extensibility/skillLoader.ts`: add diagnostic scan types and helpers.
* `src/web/server.ts`: return runtime and repo skill sources plus diagnostics from `/api/skills`.
* `ui/app.js`: render runtime skills, diagnostics, repo skills, and Open Skills action.
* `scripts/ui-smoke.js`: assert new UI helpers and surfaces.
* Tests: add loader diagnostics coverage and API assertions.

## Validation Plan

* Targeted Jest for skill loader and web server: passed, 2 suites and 52 tests.
* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 36 suites and 228 tests.
* `npm run build`: passed.
* `npm run smoke:ui`: passed in Playwright mode.
* Diagnostics on changed files: no errors found.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%