<!-- markdownlint-disable-file -->

# Hermes Good Patterns Second Pass Changes

Date: 2026-04-30

Related plan: `.copilot-tracking/plans/2026-04-30/hermes-good-patterns-second-pass-plan.instructions.md`

## Summary

Added four more Hermes-inspired, Harness-fitting primitives: model catalog caching, safe extension manifest discovery, automation due/run lifecycle helpers, and session search index freshness metadata.

## Added

* `src/models/modelCatalog.ts`: model catalog manifest validation, cache read/write/status, stale fallback, and built-in Ollama presets.
* `src/models/modelCatalog.test.ts`: model catalog validation, cache, fallback, and freshness coverage.
* `src/extensibility/extensionManifest.ts`: manifest-only plugin and skill discovery under `.harness/` without executing plugin code.
* `src/extensibility/extensionManifest.test.ts`: plugin and skill discovery coverage.

## Modified

* `src/automation/jobs.ts`: added cron next-run calculation, due job listing, run-completion updates, one-shot disabling, and run log appends.
* `src/automation/jobs.test.ts`: added due-job, cron, interval, and one-shot completion tests.
* `src/persistence/sessionSearchIndex.ts`: added metadata-backed index file format, backward-compatible reads, freshness status, and rebuild summaries.
* `src/persistence/sessionSearchIndex.test.ts`: added metadata and stale-index coverage.
* `src/index.ts`: exported model catalog, extension manifest, automation lifecycle, and session search metadata APIs.

## Validation

* Focused Jest passed: 4 suites and 13 tests.
* `npm run typecheck` passed.
* Full Jest passed: 34 suites and 222 tests.
* `npm run build` passed.
* VS Code diagnostics reported no errors for changed source and test files.

## Deviations

* Full dynamic plugin loading was not implemented. This is intentional: manifest-only discovery captures Hermes' useful metadata pattern while avoiding arbitrary project code execution and sandboxing concerns.