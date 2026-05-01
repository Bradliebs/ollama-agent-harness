<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Plan

## User Requests

* Continue all suggested next work items from the prior Phase 5 output.
* Follow `rpi.prompt.md` requirements, including artifact paths, completion percentages, and final validation status.

## Objectives

* Expose model catalog, extension manifests, due automations, and session search index freshness in the browser.
* Add safe extension activation policy settings without enabling plugin code execution.
* Add team model catalog settings for custom catalog URL and refresh cadence.

## Context Summary

* Project instructions: `.github/copilot-instructions.md`
* Markdown instructions: `c:/Users/Brad/.vscode/extensions/ise-hve-essentials.hve-core-3.2.2/.github/instructions/hve-core/markdown.instructions.md`
* Harness conventions skill: `.github/skills/harness-conventions/SKILL.md`
* Testing skill: `.github/skills/testing/SKILL.md`
* Research: `.copilot-tracking/research/2026-04-30/hermes-discovery-surfaces-research.md`

## Implementation Checklist

* [x] Phase 1: Add web settings and discovery API endpoints. <!-- parallelizable: false -->
* [x] Phase 2: Add browser Discovery tab and settings controls. <!-- parallelizable: false -->
* [x] Phase 3: Add API and smoke tests. <!-- parallelizable: false -->
* [x] Phase 4: Validate and update tracking artifacts. <!-- parallelizable: false -->
* [x] Phase 5: Review and discover follow-up work. <!-- parallelizable: false -->

## Dependencies

* `src/models/modelCatalog.ts`
* `src/extensibility/extensionManifest.ts`
* `src/automation/jobs.ts`
* `src/persistence/sessionSearchIndex.ts`
* Existing Express server and browser UI patterns

## Success Criteria

* Discovery API returns catalog, extensions, automations, and session index status.
* Settings API persists model catalog and extension activation policy settings.
* Browser renders discovery panels and settings controls with stable IDs.
* Validation passes: targeted Jest, typecheck, full Jest, build, UI smoke, diagnostics.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%