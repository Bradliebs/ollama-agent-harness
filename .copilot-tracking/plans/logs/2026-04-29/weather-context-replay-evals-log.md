<!-- markdownlint-disable-file -->

# Weather Context Replay Evals Planning Log

## Discrepancy Log

No discrepancies at planning time.

## Implementation Paths Considered

* Selected: improve existing `web_read` sparse-content handling instead of adding provider-specific weather APIs.
* Selected: expose context metadata through existing settings payloads because the browser already polls settings after chat.
* Selected: add deterministic replayable eval checks for prompt, expected fragments, and tool names before adding live model replay.

## Validation Plan

* Focused Jest for web reading, eval traces, web settings, and Ollama context behavior.
* Full Jest suite.
* TypeScript typecheck.
* VS Code diagnostics for changed files.
* UI smoke against a live local server.

## Suggested Follow-On Work

* Add live replay adapters for eval cases with mocked and real local model modes.
* Add explicit weather-source ranking if fallback search results remain inconsistent.

## Validation Iterations

* Focused Jest via `npm test -- --runInBand src/tools/webSearchTool.test.ts src/learning/evalTrace.test.ts src/web/server.test.ts src/core/ollamaClient.test.ts`: passed, 4 suites and 29 tests.
* Full Jest via `npm test -- --runInBand`: passed, 20 suites and 104 tests.
* Typecheck via `npm run typecheck`: passed.
* VS Code diagnostics: no errors in changed source, UI, or smoke files after adding a Jest type reference to the new tool test.
* UI smoke via `npm run smoke:ui -- http://127.0.0.1:3107/`: passed in static mode against a live local server.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: implementation, validation iterations, review, and discovery
* In-progress step: present suggested next work
* Remaining steps: none