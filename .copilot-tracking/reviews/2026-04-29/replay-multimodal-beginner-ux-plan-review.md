<!-- markdownlint-disable-file -->

# Replay Multimodal Beginner UX Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-04-29/replay-multimodal-beginner-ux-plan.instructions.md`
* Reviewer: GitHub Copilot
* Date: 2026-04-29

## User Request Fulfillment

* Do all latest suggested next work: complete.
* Look at image/audio support because some models support this: complete.
* Make the main page more intuitive for a beginner: complete.
* Clarify the recoverable session message and Resume/Fork actions: complete.

## Work Item Fulfillment

* Live Replay Adapters: complete. `runEvalTraceDataset` accepts a replay adapter, tests cover mock adapter behavior, and `/api/evals/trace-examples/run` supports stored, mock, and live modes.
* Weather Source Ranking: complete. Weather fallback search snippets are ranked and labeled with source types such as official forecast.
* Replay Failure Links: complete. Replay examples and run results can carry trace/session/source context links, and the eval dataset UI renders source links.
* Multimodal Model Affordances: complete. `/api/models` returns conservative text/image/audio capability hints, uploads return `mediaKind`, and the main UI displays model and attachment guidance.
* Beginner Main Page: complete. The welcome area now explains Ask, Attach, and Recover workflows with compact, task-focused copy.
* Recovery Banner: complete. The banner now says an unfinished chat is available and explains that Resume continues it while Fork starts a copy.

## Validation Results

```text
npm test -- --runInBand src/learning/evalTrace.test.ts src/tools/webSearchTool.test.ts src/web/server.test.ts
PASS: 3 suites, 29 tests after one syntax fix

npm run typecheck
PASS: tsc --noEmit

npm test -- --runInBand
PASS: 20 suites, 107 tests

VS Code diagnostics
PASS: no errors in changed source, UI, or smoke files

npm run smoke:ui -- http://127.0.0.1:3108/
PASS: static fallback mode
```

## Quality Findings

* Placement is appropriate: replay logic stays in `src/learning/evalTrace.ts`, weather ranking stays in `src/tools/webSearchTool.ts`, model/upload metadata stays in the web API, and beginner-facing affordances stay in the browser UI.
* The implementation avoids overpromising multimodal support. It explains likely capability and keeps the current file-path attachment behavior.
* Remaining risk: true image reasoning requires passing binary/image data to Ollama chat messages, and audio analysis needs transcription/tooling before most chat models can use it directly.

## Overall Status

Complete

## Suggested Next Work

1. Add true image input handling for vision-capable Ollama models.
2. Add audio transcription tooling for uploaded audio files.
3. Add replay run history links from failed latest run rows, not only example source metadata.
