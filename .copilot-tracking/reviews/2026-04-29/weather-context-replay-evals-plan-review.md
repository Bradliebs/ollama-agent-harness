<!-- markdownlint-disable-file -->

# Weather Context Replay Evals Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-29/weather-context-replay-evals-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-29

## User Request Fulfillment

* Follow `#prompt:rpi.prompt.md` with `continue=all`: complete.
* Continue all latest suggested work items: complete.

## Work Item Fulfillment

* Improve Weather Extraction: complete. `web_read` detects sparse weather pages and appends a weather fallback block using search-derived forecast snippets when the primary page exposes only sparse/navigation text.
* Show Detected Context: complete. `/api/settings` now exposes configured, detected, and effective context token counts, and the Settings panel renders those values.
* Add Replayable Evals: complete. Eval examples can now store replay prompt/expectation metadata, run deterministic response/tool checks, and create a Bracknell weather regression through API and UI.

## Validation Results

```text
npm test -- --runInBand src/tools/webSearchTool.test.ts src/learning/evalTrace.test.ts src/web/server.test.ts src/core/ollamaClient.test.ts
PASS: 4 test suites, 29 tests

npm test -- --runInBand
PASS: 20 test suites, 104 tests

npm run typecheck
PASS: tsc --noEmit

VS Code diagnostics
PASS: no errors in changed source, UI, or smoke files

npm run smoke:ui -- http://127.0.0.1:3107/
PASS: static mode against live local server
```

## Quality Findings

* Placement is appropriate: web extraction behavior stays in the web tool, replay eval logic stays in `src/learning/evalTrace.ts`, context metadata stays in the web settings surface, and browser affordances stay in `ui/` plus smoke coverage.
* Existing trace-status evals remain compatible because replay mode is optional and trace examples are still created with `mode: 'trace'`.
* Remaining risk: weather fallback quality depends on search-result snippets when the source page is sparse. This is still better than returning only navigation text, but ranking and source trust can be improved later.

## Overall Status

Complete

## Suggested Next Work

1. Add live replay adapters for eval cases with mocked and real local model modes.
2. Add weather source ranking and freshness metadata for fallback results.
3. Add saved trace or session links from replay eval failures back to source context.
