<!-- markdownlint-disable-file -->

# Skill Visibility Followups Plan

## User Requests

* Continue all suggested work items from the prior Phase 5 output.
* Address the side note that saved skills should be visible under Skills.

## Objectives

* Make successful skill saves easier to navigate to from chat.
* Show skipped or malformed runtime skill folders in the UI.
* Show repo customization skills separately from runtime skills.

## Context Summary

* Project instructions: `.github/copilot-instructions.md`
* Markdown instructions: `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/instructions/hve-core/markdown.instructions.md`
* Research: `.copilot-tracking/research/2026-04-30/skill-visibility-followups-research.md`

## Implementation Checklist

* [x] Phase 1: Add skill loader diagnostics. <!-- parallelizable: false -->
* [x] Phase 2: Extend Skills API source payload. <!-- parallelizable: false -->
* [x] Phase 3: Render chat action, diagnostics, and repo skills. <!-- parallelizable: false -->
* [x] Phase 4: Add tests and smoke coverage. <!-- parallelizable: false -->
* [x] Phase 5: Validate, review, and discover follow-ups. <!-- parallelizable: false -->

## Success Criteria

* `/api/skills` returns runtime skills, repo skills, and diagnostics.
* Skills tab renders each bucket with stable IDs.
* Skill-mutating tool results include an Open Skills action.
* Validation passes.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%