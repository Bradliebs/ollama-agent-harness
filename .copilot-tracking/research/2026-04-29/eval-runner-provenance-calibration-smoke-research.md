<!-- markdownlint-disable-file -->

# Eval Runner Provenance Calibration Smoke Research

## Scope

Continue all Phase 5 items from the prior RPI cycle:

1. Evaluation Runner
2. Candidate Provenance Detail
3. Apply Calibration Workflow
4. Dynamic Learning Panel Smoke

## Assumptions

* Eval trace examples are curated runtime dataset artifacts and can be rewritten for tag/delete operations.
* Session transcripts remain append-only; provenance reads them without mutation.
* Routing calibration suggestions should require explicit operator application through settings.
* Dynamic smoke should work when Playwright is installed and retain the static fallback when it is not.

## Evidence

* `src/learning/evalTrace.ts` owns trace example creation, JSONL storage, tag updates, deletion, and dataset reads.
* `src/learning/sessionLearning.ts` owns learning candidate extraction, review records, and promotion.
* `src/agents/modelRouting.ts` owns routing metric summaries and calibration suggestions.
* `src/web/server.ts` owns settings persistence, learning API payloads, eval endpoints, candidate review endpoints, and routing API endpoints.
* `ui/app.js` renders Learning panel management controls.
* `scripts/ui-smoke.js` already has Playwright and static modes.

## Selected Approach

* Add eval runner helpers next to eval trace dataset helpers so API and package exports share one implementation.
* Resolve candidate provenance from the session transcript by `sessionId` and `sourceEventIds`, returning bounded event summaries.
* Add an apply-calibration endpoint that merges `calibration.suggestedPolicy` into the existing sanitized `modelRouting` settings and persists them.
* Extend the Learning panel with run/apply/detail controls and extend smoke checks for functions and dynamic Learning panel markers.

## Alternatives

* Running full agent replay for eval examples was rejected for this cycle because examples currently store trace snapshots, not replayable prompts or expected model outputs.
* Mutating candidate records to add provenance was rejected because source event IDs already provide a durable transcript link.

## Validation Plan

* Focused Jest for `evalTrace`, `sessionLearning`, `modelRouting`, and `server`.
* Full Jest suite.
* TypeScript typecheck.
* VS Code diagnostics for changed files.
* UI smoke against a live local server.
