<!-- markdownlint-disable-file -->

# Replay Multimodal Beginner UX Research

## Scope

Continue all latest suggested work items and the new beginner UX request:

1. Live Replay Adapters
2. Weather Source Ranking
3. Replay Failure Links
4. Improve image/audio affordances for models that support them
5. Clarify the recoverable session Resume/Fork banner

## Assumptions

* Keep the harness dependency-light and local-first.
* Do not add provider-specific weather APIs or API keys.
* Treat model image/audio support as best-effort capability hints from Ollama list details and model-name heuristics.
* Make beginner-facing UI copy concrete without turning the app into a landing page.

## Evidence Log

* `src/learning/evalTrace.ts` supports replay examples but only evaluates stored `actualResponse` and `actualTools`.
* `src/tools/webSearchTool.ts` now appends fallback weather snippets, but fallback results are not ranked or labeled by source trust.
* `ui/app.js` renders replay examples but does not show source trace/session links.
* `/api/models` only returns name, family, and parameter size; the main page does not explain whether a model is text-only, vision-capable, or audio-related.
* Attachments are shown as generic file chips and the prompt says only to read attached files.
* The recovery banner currently says `Recoverable session found` with unexplained `Resume` and `Fork` actions.

## Selected Approach

* Add replay run options with a pluggable replay adapter. Unit tests will use a mock adapter; the web API will expose a live local-model adapter that fills response text from Ollama.
* Add trusted weather-source ranking labels to fallback search snippets.
* Add optional source trace/session metadata to replay eval examples and run results, and render the links in the eval dataset UI.
* Add model capability hints using Ollama model details plus model-name heuristics, then render a compact beginner-facing capability panel near the model selector.
* Classify uploaded files as image/audio/text/data/other, show distinct chips, and tailor the attachment prompt.
* Rewrite the recovery banner copy to explain Resume versus Fork in plain terms.

## Validation Plan

* Focused Jest for eval traces, web search, and web server APIs.
* Full Jest suite.
* TypeScript typecheck.
* VS Code diagnostics for changed files.
* UI smoke against a live local server.
