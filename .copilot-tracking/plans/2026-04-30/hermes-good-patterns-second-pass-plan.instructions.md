<!-- markdownlint-disable-file -->

# Hermes Good Patterns Second Pass Plan

Date: 2026-04-30

## User Requests

* "All, I want to take all that is good from hermes."

## Objectives

* Add model catalog caching and validation inspired by Hermes.
* Add safe extension manifest discovery inspired by Hermes plugins.
* Improve automation lifecycle helpers inspired by Hermes cron jobs.
* Improve session search index freshness reporting inspired by Hermes searchable state.

## Context Summary

* Project conventions: `.github/skills/harness-conventions/SKILL.md`
* Testing conventions: `.github/skills/testing/SKILL.md`
* Research: `.copilot-tracking/research/2026-04-30/hermes-good-patterns-second-pass-research.md`
* Prior pass: `.copilot-tracking/plans/2026-04-30/hermes-borrowed-patterns-plan.instructions.md`

## Implementation Checklist

* [x] Phase 1: Add model catalog cache and tests. <!-- parallelizable: false -->
* [x] Phase 2: Add extension manifest discovery and tests. <!-- parallelizable: false -->
* [x] Phase 3: Extend automation lifecycle helpers and tests. <!-- parallelizable: false -->
* [x] Phase 4: Add session search metadata/freshness and tests. <!-- parallelizable: false -->
* [x] Phase 5: Export APIs, validate, and update tracking. <!-- parallelizable: false -->

## Dependencies

* Existing TypeScript/Jest toolchain.
* Existing `.harness/` runtime state convention.
* Existing `src/extensibility`, `src/automation`, and `src/persistence` subsystems.

## Success Criteria

* New behavior is covered by focused tests.
* No dynamic plugin code execution is introduced.
* Runtime metadata remains under `.harness/`.
* `npm run typecheck`, full Jest, and `npm run build` pass.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%