<!-- markdownlint-disable-file -->

# Agent Harness Inspector Palace Smoke Research

## Scope

Continue with all latest suggested work items:

1. Trace Inspector
2. Palace Drill-Down
3. Browser Regression Tests

## Assumptions

* Keep the harness local-first and dependency-light.
* Do not add a mandatory browser test dependency because Playwright is currently optional in `scripts/ui-smoke.js`.
* Preserve the existing trace export and semantic memory APIs as the source of truth.

## Evidence Log

* `src/web/server.ts` already exports trace snapshots and saved trace JSON, but the UI only lists export ids and sizes.
* `ui/app.js` already loads trace exports and palace rooms, but trace rows and palace anchors do not expose detail views.
* `src/persistence/semanticMemory.ts` includes session and event ids in palace anchors, which is enough to route users to session context.
* `scripts/ui-smoke.js` checks core DOM presence but does not assert trace controls, palace tab behavior, or detail containers.

## Selected Approach

* Reuse `/api/traces/exports/:id` for the browser trace inspector and render spans/events client-side.
* Add a focused `/api/memory/entries/:id` endpoint for palace anchor drill-down to avoid loading whole transcripts in the browser.
* Extend the palace UI to render anchor buttons that load the source memory entry detail.
* Extend the optional Playwright smoke script to click settings and palace controls and verify detail containers exist.

## Success Criteria

* Trace exports can be expanded in the browser into spans and events.
* Palace anchors can reveal source session, event id, kind, timestamp, and text.
* API tests cover the new memory entry endpoint and trace export detail shape.
* The optional UI smoke script asserts trace controls, palace tab rendering, and no duplicate ids.
* Typecheck, Jest, diagnostics, and browser smoke validation pass or any unavailable optional dependency is clearly reported.

## Implementation Findings

* The trace inspector can stay entirely client-side because saved trace exports already include enough span and event detail for initial inspection.
* Palace drill-down benefits from a narrow memory-entry endpoint instead of exposing entire transcript files to the browser.
* Optional browser automation should still return useful signal without Playwright installed; static smoke now validates the page shell, script hooks, inspector container, palace container, and duplicate ids.
* Live browser tooling remains valuable for dynamic checks that static smoke cannot perform, such as clicking palace anchors and inspecting rendered detail text.
