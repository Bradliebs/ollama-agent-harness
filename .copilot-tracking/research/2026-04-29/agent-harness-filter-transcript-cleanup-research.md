<!-- markdownlint-disable-file -->

# Agent Harness Filter Transcript Cleanup Research

## Scope

Continue with all latest suggested work items:

1. Trace Filtering
2. Session Transcript Panel
3. Runtime Cleanup Controls

## Assumptions

* Keep the local-first, dependency-light approach already used by the harness.
* Do not delete session transcripts as part of cleanup controls; only remove derived/runtime data that can be regenerated or is explicitly trace-export state.
* Preserve append-only session storage and use read-only transcript APIs for drill-down.

## Evidence Log

* `ui/app.js` now renders trace export details, but the inspector has no filter state or narrowing controls.
* `src/persistence/semanticMemory.ts` can load a single semantic memory entry by id, but cannot yet return surrounding transcript context.
* `src/web/server.ts` stores trace exports under `.harness/traces` and semantic index data under `.harness/memory/semantic-index.json`.
* `scripts/ui-smoke.js` validates trace and palace surfaces but does not yet assert cleanup controls or filter hooks.

## Selected Approach

* Keep trace filtering client-side over the downloaded export payload.
* Add a focused semantic memory context helper that returns a bounded event window around a memory entry.
* Add local runtime storage summary and cleanup endpoints for trace exports and the semantic index.
* Add right-panel runtime controls and extend smoke coverage for the new UI affordances.

## Success Criteria

* Trace inspector can filter spans/events by name, status, error text, or attributes.
* Palace entry detail includes a transcript context panel with surrounding session events.
* Runtime controls can summarize and clean trace exports and semantic index data without touching sessions.
* Typecheck, Jest, diagnostics, smoke script, and live browser validation pass.

## Implementation Findings

* Trace filtering is simplest and fastest as a client-side operation over the active export payload.
* Session transcript context should remain bounded around the selected anchor to protect browser readability and avoid exposing whole transcripts by default.
* Runtime cleanup should distinguish derived state from source-of-truth state; trace exports and semantic indexes are safe to clean, while session transcripts are preserved.
* Static smoke remains useful in dependency-light installs, and live browser tooling covers dynamic behavior that static checks cannot validate.
