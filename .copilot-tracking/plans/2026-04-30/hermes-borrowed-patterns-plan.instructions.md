<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Plan

Date: 2026-04-30

## User Requests

* Continue with all suggested work items from the prior Phase 5 output.
* Follow `rpi.prompt.md` with `continue=all`.

## Objectives

* Implement a command registry inspired by Hermes command metadata.
* Implement tool registry metadata without destabilizing existing tool constants.
* Add local automation primitives for scheduled or script-backed agent runs.
* Improve setup doctor checks with actionable local diagnostics.
* Add a derived searchable session index while keeping JSONL transcripts authoritative.

## Context Summary

* Project conventions: `.github/skills/harness-conventions/SKILL.md`
* Testing conventions: `.github/skills/testing/SKILL.md`
* Markdown instructions: `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/instructions/hve-core/markdown.instructions.md`
* Writing style instructions: `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/instructions/hve-core/writing-style.instructions.md`
* Prompt instructions: `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/prompts/hve-core/rpi.prompt.md`

## Implementation Checklist

* [x] Phase 1: Add CLI command registry and tests. <!-- parallelizable: false -->
* [x] Phase 2: Add tool registry metadata and tests. <!-- parallelizable: false -->
* [x] Phase 3: Add automation storage and runner helpers with tests. <!-- parallelizable: false -->
* [x] Phase 4: Extend setup doctor diagnostics and tests. <!-- parallelizable: false -->
* [x] Phase 5: Add searchable session index and tests. <!-- parallelizable: false -->
* [x] Phase 6: Run targeted validation and update tracking. <!-- parallelizable: false -->

## Dependencies

* Existing Jest test setup through `npm test`.
* Existing TypeScript compiler through `npm run typecheck`.
* Existing append-only session storage in `src/persistence/sessionStorage.ts`.
* Existing tool constants in `src/tools/**`.

## Success Criteria

* CLI help and parse metadata are generated from command registry data.
* Built-in tools can be queried by name and toolset through a typed registry.
* Automation jobs can be created, listed, run with optional script context, and persist outputs.
* Doctor output includes additional local checks.
* Session search index can rebuild from JSONL sessions and return ranked matches.
* Targeted tests and typecheck pass.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%
