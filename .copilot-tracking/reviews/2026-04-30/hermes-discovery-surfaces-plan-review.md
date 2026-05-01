<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-30/hermes-discovery-surfaces-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-30

## User Request Fulfillment

* Continue all suggested work items: complete.
* Browser Discovery Panels: complete.
* Extension Activation Policy: complete.
* Team Model Catalog Settings: complete.

## Phase 4 Findings

* Discovery API placement is correct: `src/web/server.ts` already owns browser-facing operational APIs and settings persistence.
* Browser placement is correct: operational discovery belongs in the left panel, while catalog and extension policy controls belong in the right Settings panel.
* Extension activation remains intentionally blocked for executable plugins. The new policy is visible and persisted, but runtime execution still requires a future trust and sandbox design.
* Team model catalog settings are persisted and consumed by the discovery and refresh endpoints.
* The UI smoke failure was limited to test assertion plumbing; the product surface rendered correctly after the smoke script fix.

## Validation Results

```text
npm test -- --runInBand src/web/server.test.ts
PASS: 1 suite, 50 tests

npm run typecheck
PASS: tsc --noEmit

npm test -- --runInBand
PASS: 34 suites, 225 tests

npm run build
PASS: tsc

npm run smoke:ui
PASS: Discovery tab, panels, settings, functions, and duplicate-id checks
```

## Residual Risk

* `ui/index.html` still has a pre-existing inline-style diagnostic warning outside this change.
* The Discovery tab is read-only except for catalog refresh and session index rebuild; due automation execution remains future work.

## Overall Status

Complete.

## Suggested Next Work

1. Add permission-aware automation execution from the Discovery tab.
2. Add model catalog install/pull actions with confirmation and progress streaming.
3. Clean up inline UI styles into shared classes to reduce diagnostics noise.