<!-- markdownlint-disable-file -->

# Weather Context Replay Evals Research

## Scope

Continue all latest suggested work items from the previous Phase 5 output:

1. Improve Weather Extraction
2. Show Detected Context
3. Add Replayable Evals

## Assumptions

* Keep the harness local-first and dependency-light.
* Improve weather extraction without adding API keys or external paid services.
* Preserve the existing `web_search` and `web_read` tool names so model prompts and tool schemas remain stable.
* Extend eval trace support in place instead of replacing existing trace-status evals.

## Evidence Log

* `src/tools/webSearchTool.ts` contains `WebReadTool`, whose HTML extraction strips tags but does not detect sparse JavaScript-heavy pages or provide weather-specific fallback content.
* `src/web/server.ts` already resolves active context tokens through `resolveContextMaxTokens`, but settings responses only expose `contextMaxTokens` and do not distinguish configured versus detected context.
* `ui/app.js` loads and displays configured `contextMaxTokens`, but it does not show detected model context or effective context in the Settings panel.
* `src/learning/evalTrace.ts` stores trace examples and run history, but the runner only validates expected trace status rather than replaying prompt/expected response checks.
* `scripts/ui-smoke.js` has static and Playwright modes that can be extended with detected-context and replayable-eval hooks.

## Selected Approach

* Add sparse-content detection to `WebReadTool` and append weather search fallback guidance/results when the URL or content indicates a weather forecast page.
* Add focused weather extraction helpers and Jest coverage beside the web search/read tool module.
* Add detected/effective context metadata to web settings and display it in the Settings panel next to the configured token input.
* Extend eval examples with optional replay fields: prompt, expected response fragments, expected tool names, and a replay mode flag.
* Add a replayable eval creation API and UI action that creates a regression case for the weather/context issue without requiring a live model replay.

## Alternatives

* Use a weather provider API. Deferred because it would require keys or region-specific service choices.
* Run full live model replays in the eval runner. Deferred because deterministic model assertions need a separate mocked/replay adapter to avoid flaky local model dependence.
* Replace `web_read` with a DOM parser dependency. Deferred because the existing regex extractor can be improved enough for this focused issue.

## Success Criteria

* `web_read` returns a useful fallback note and search-derived weather summary when forecast page extraction is sparse.
* Settings responses expose configured, detected, and effective context token counts.
* The browser Settings panel shows detected/effective context information.
* Eval examples can store replay prompts and expected response/tool checks, and the runner validates those fields deterministically.
* Focused Jest, full Jest, typecheck, diagnostics, and UI smoke pass.

## Artifact Status

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%

## Current Phase State

* Last phase before compaction: Phase 1 Research
* Completed steps: inspected web read/search, context settings, eval trace, UI, smoke, and exports
* In-progress step: implementation planning
* Remaining steps: create plan artifacts, implement, validate, review, discover