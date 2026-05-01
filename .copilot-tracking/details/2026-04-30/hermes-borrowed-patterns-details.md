<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Details

Date: 2026-04-30

## Context References

* Research: `.copilot-tracking/research/2026-04-30/hermes-borrowed-patterns-research.md`
* Plan: `.copilot-tracking/plans/2026-04-30/hermes-borrowed-patterns-plan.instructions.md`
* Planning log: `.copilot-tracking/plans/logs/2026-04-30/hermes-borrowed-patterns-log.md`

## Step Details

1. Add `src/cli/commands.ts` with command metadata, alias resolution, help generation, and option metadata.
2. Update `src/cli/index.ts` to use registry metadata for help and doctor command detection.
3. Add `src/tools/registry.ts` with tool entries, toolset grouping, snapshots, lookup, and built-in registration.
4. Update `src/tools/index.ts` to return tools through the registry.
5. Add `src/automation/jobs.ts` and `src/automation/runner.ts` for schedule parsing, job JSON storage, optional script execution, prompt context construction, and output persistence.
6. Extend `src/setup/health.ts` with local Node/package/session/tool/automation diagnostics.
7. Add `src/persistence/sessionSearchIndex.ts` for derived session search index rebuild and query.
8. Add focused Jest coverage beside changed modules.

## Validation

* `npm test -- --runInBand src/cli/commands.test.ts src/cli/index.test.ts src/tools/registry.test.ts src/automation/jobs.test.ts src/setup/health.test.ts src/persistence/sessionSearchIndex.test.ts`: passed, 6 suites and 13 tests.
* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 32 suites and 213 tests.
* `npm run build`: passed.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%
