<!-- markdownlint-disable-file -->

# Agent Harness Improvements Plan

## User Requests

* Continue with all suggested work items from the prior Phase 5 output.
* Follow the attached RPI prompt with `continue=all`.

## Objectives

* Harden the local UI/API surface for a tool-capable agent harness.
* Remove divergent production and tested tool execution paths.
* Improve context safety by bounding file/search tool output.
* Add query loop runtime tests for the behavior the UI and CLI use.
* Keep runtime-generated local state out of source control.

## Context Summary

* Project conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Review checklist loaded from `.github/skills/code-review/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing instructions loaded from HVE Core instruction files.
* Existing repo memory notes warn that compaction checkpoints must be reflected in resume logic.

## Implementation Checklist

* [x] Phase 1: Tracking artifacts <!-- parallelizable: false -->
* [x] Phase 2: Web server hardening <!-- parallelizable: false -->
* [x] Phase 3: Tool execution unification <!-- parallelizable: false -->
* [x] Phase 4: Bounded tool output <!-- parallelizable: false -->
* [x] Phase 5: Query loop runtime tests <!-- parallelizable: false -->
* [x] Phase 6: Runtime artifact ignores <!-- parallelizable: true -->
* [x] Phase 7: Validation and review <!-- parallelizable: false -->

## Dependencies

* Jest and ts-jest for tests.
* TypeScript strict mode.
* Existing Express server and local tool system.

## Success Criteria

* All implementation checklist items complete.
* `npm test -- --runInBand` passes.
* `npm run typecheck` passes.
* Review confirms all five follow-up items are addressed.
