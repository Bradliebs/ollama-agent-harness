<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Changes

Date: 2026-04-30

Related plan: `.copilot-tracking/plans/2026-04-30/hermes-borrowed-patterns-plan.instructions.md`

## Summary

Implemented all Hermes-inspired follow-up items as small TypeScript primitives that preserve Harness architecture: command metadata, tool registry metadata, local automation helpers, richer setup health diagnostics, and a derived session search index.

## Added

* `src/cli/commands.ts`: typed CLI command registry, aliases, option metadata, and help generation helpers.
* `src/cli/commands.test.ts`: command registry coverage.
* `src/tools/registry.ts`: typed built-in tool registry with lookup, toolset grouping, and compatibility ordering.
* `src/tools/registry.test.ts`: tool registry coverage.
* `src/automation/jobs.ts`: local automation job creation, schedule parsing, storage, listing, and output persistence helpers.
* `src/automation/runner.ts`: script-before-agent prompt context preparation helpers.
* `src/automation/jobs.test.ts`: automation storage and schedule coverage.
* `src/persistence/sessionSearchIndex.ts`: derived session search index rebuild and query helpers.
* `src/persistence/sessionSearchIndex.test.ts`: session search index coverage.

## Modified

* `src/cli/index.ts`: uses command registry metadata for help and command detection.
* `src/cli/index.test.ts`: covers updated command/help behavior.
* `src/tools/index.ts`: returns built-in tools through the typed registry while preserving existing exports.
* `src/setup/health.ts`: adds actionable local diagnostics beyond the existing Ollama/media checks.
* `src/setup/health.test.ts`: covers richer setup health output.
* `src/index.ts`: exports the new registry, automation, and session search APIs.

## Validation

* Targeted Jest passed: 6 suites and 13 tests.
* `npm run typecheck` passed.
* Full Jest passed: 32 suites and 213 tests.
* `npm run build` passed.

## Deviations

* The initial tool registry edit was corrected before validation to avoid a circular import through the aggregate `src/tools` barrel. The final registry imports concrete tool modules directly and preserves the old built-in tool order.