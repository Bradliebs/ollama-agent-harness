<!-- markdownlint-disable-file -->

# Weather Context Replay Evals Plan

## User Requests

1. Follow `#prompt:rpi.prompt.md` with `continue=all`.
2. Continue all latest suggested work items: Improve Weather Extraction, Show Detected Context, and Add Replayable Evals.

## Objectives

* Improve `web_read` behavior for sparse weather forecast pages.
* Expose detected model context and effective chat context to the web UI.
* Add replayable eval metadata and a weather regression eval path.

## Context Summary

* Harness conventions loaded from `.github/skills/harness-conventions/SKILL.md`.
* Testing conventions loaded from `.github/skills/testing/SKILL.md`.
* Markdown and writing-style instructions loaded from HVE Core.
* Repository memory notes confirm context continuity and resume behavior must remain aligned with compaction boundaries.

## Implementation Checklist

### Phase A: Weather Extraction Fallback <!-- parallelizable: false -->

* [x] Add sparse-content detection and weather-page detection helpers.
* [x] Add fallback search summary for weather forecast pages when page extraction is sparse.
* [x] Add focused Jest coverage for weather fallback behavior.

### Phase B: Detected Context Visibility <!-- parallelizable: false -->

* [x] Add configured/detected/effective context metadata to web settings.
* [x] Render detected and effective context information in the Settings panel.
* [x] Extend API/UI smoke tests for the new context display hook.

### Phase C: Replayable Evals <!-- parallelizable: false -->

* [x] Add replayable eval fields and deterministic result checks.
* [x] Add API and UI creation path for the weather/context regression case.
* [x] Update exports and focused eval tests.

### Phase D: Validation And Review <!-- parallelizable: false -->

* [x] Run focused Jest for touched modules.
* [x] Run full Jest and TypeScript typecheck.
* [x] Run diagnostics and UI smoke.
* [x] Update changes and review artifacts.

## Dependencies

* `src/tools/webSearchTool.ts`
* `src/tools/webSearchTool.test.ts`
* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `src/index.ts`
* `ui/app.js`
* `ui/index.html`
* `scripts/ui-smoke.js`

## Success Criteria

* Weather forecast reads no longer return only navigation-like sparse content.
* Detected and effective context token counts are available through API and visible in the browser.
* Replayable eval examples can check expected response fragments and expected tool use.
* Validation passes.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: research, planning, implementation, validation, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none