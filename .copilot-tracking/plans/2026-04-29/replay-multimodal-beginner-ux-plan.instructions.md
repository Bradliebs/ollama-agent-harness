<!-- markdownlint-disable-file -->

# Replay Multimodal Beginner UX Plan

## User Requests

1. Do all latest suggested next work.
2. Look at image and audio support because some models support this.
3. Make the main page more intuitive for a beginner.
4. Clarify the `Recoverable session found` message and the `Resume`/`Fork` actions.

## Objectives

* Let replay eval runs use stored, mocked, or live local-model replay data.
* Improve weather fallback source quality through ranking and source labels.
* Link replay eval failures back to source traces or sessions when metadata exists.
* Surface model text/image/audio capability hints in the main chat experience.
* Make attachments and recovery choices clearer to first-time users.

## Context Summary

* Harness conventions and testing skills were loaded.
* Existing replay evals are deterministic and local-first.
* Existing web UI already has uploads, model selection, recovery banner, eval dataset manager, and static UI smoke checks.

## Implementation Checklist

### Phase A: Replay And Weather Follow-Ups <!-- parallelizable: false -->

* [x] Add replay run adapter options and tests.
* [x] Add weather fallback source ranking labels.
* [x] Add replay source links to examples, run results, API, and UI.

### Phase B: Multimodal Beginner UX <!-- parallelizable: false -->

* [x] Add model capability hints to `/api/models`.
* [x] Render model capability hints and beginner copy on the main page.
* [x] Classify uploaded image/audio files and tailor attachment prompts.

### Phase C: Recovery Copy And Smoke <!-- parallelizable: false -->

* [x] Rewrite recovery banner text and controls.
* [x] Extend UI smoke checks for multimodal and recovery hooks.
* [x] Run validation and update review artifacts.

## Dependencies

* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`
* `src/tools/webSearchTool.ts`
* `src/tools/webSearchTool.test.ts`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `src/index.ts`
* `ui/index.html`
* `ui/app.js`
* `scripts/ui-smoke.js`

## Success Criteria

* Replay evals can be evaluated from stored data and through an injected adapter.
* Web eval run API can request live replay mode without changing stored examples.
* Weather fallback snippets are ranked and labeled.
* Model list and main page show text/image/audio capability hints.
* Image/audio attachments are visibly distinct and the prompt tells the model what kind of input was attached.
* Recovery banner explains Resume and Fork clearly.
* Tests, typecheck, diagnostics, and UI smoke pass.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: scope, objectives, checklist, implementation, validation, and review
* In-progress step: present suggested next work
* Remaining steps: none
