<!-- markdownlint-disable-file -->

# Small Model Edge Planning Log

## Discrepancy Log

* No functional discrepancies.
* Initial focused test run found a TypeScript narrowing issue in `src/learning/sessionLearning.ts`; the extractor now stores narrowed message events before reading message content.

## Implementation Paths Considered

Selected path:

* Add focused modules for routing, session learning, and eval traces.
* Lightly integrate subagent preset resolution into `src/agents/subagent.ts`.
* Preserve query loop simplicity and avoid graph/state-machine orchestration.

Rejected paths:

* Automatic continual fine-tuning from every session, because raw traces are too noisy.
* Replacing semantic memory, because existing lexical memory is adequate for the first learning pipeline.
* Hardcoding model names, because harness conventions require configurability.

## Validation Plan

* `npm test -- --runInBand`
* `npm run typecheck`

## Suggested Follow-On Work

* Add a CLI or UI surface for configuring small/default/strong model routing policy.
* Feed accepted session learning candidates into existing memory consolidation or skill promotion flows.
* Add eval trace export controls to the web API/UI if these examples should be generated from live sessions.

## Validation Iterations

* Initial focused Jest run: 3 suites passed and `sessionLearning.test.ts` failed due to TypeScript narrowing.
* Fixed the narrowing issue and reran focused tests: passed, 4 suites and 12 tests.
* Full `npm test -- --runInBand`: passed, 18 suites and 84 tests.
* `npm run typecheck`: passed.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: implementation, validation, review
* In-progress step: discovery
* Remaining steps: present suggested next work
