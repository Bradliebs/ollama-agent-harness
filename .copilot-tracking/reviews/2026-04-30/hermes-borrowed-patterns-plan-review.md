<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-30/hermes-borrowed-patterns-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-30

## User Request Fulfillment

* Continue with all suggested work items from the prior Phase 5 output: complete.
* Follow `rpi.prompt.md` with `continue=all`: complete.

## Work Item Fulfillment

* CLI command registry: complete. Command metadata, aliases, options, and help generation now live in `src/cli/commands.ts` and are covered by focused tests.
* Tool registry metadata: complete. Built-in tools flow through `ToolRegistry` while preserving existing exports and tool ordering.
* Local automations: complete. Job creation, schedule parsing, persisted job storage, script context, and run preparation helpers are available under `src/automation/`.
* Richer doctor diagnostics: complete. Setup health now includes additional local readiness checks with targeted test coverage.
* Searchable session index: complete. A derived search index can rebuild from JSONL session transcripts and return ranked matches without replacing append-only storage.

## Validation Results

```text
npm test -- --runInBand src/cli/commands.test.ts src/cli/index.test.ts src/tools/registry.test.ts src/automation/jobs.test.ts src/setup/health.test.ts src/persistence/sessionSearchIndex.test.ts
PASS: 6 suites, 13 tests

npm run typecheck
PASS: tsc --noEmit

npm test -- --runInBand
PASS: 32 suites, 213 tests

npm run build
PASS: tsc
```

## Quality Findings

* Placement is appropriate: CLI metadata stays in `src/cli`, tool metadata stays in `src/tools`, automation primitives stay in `src/automation`, setup health stays in `src/setup`, and derived search stays under `src/persistence`.
* JSONL session transcripts remain authoritative; the search index is derived state.
* Existing tool exports and ordering are preserved to avoid compatibility regressions.
* The only implementation correction was the pre-validation circular import fix in `src/tools/registry.ts`.

## Overall Status

Complete.

## Suggested Next Work

1. Expose command and tool registry metadata in the browser so users can inspect available commands and tools.
2. Add cron expression support to automation schedules if local automations become a regular workflow.
3. Add optional index freshness metadata and rebuild controls for the session search index.