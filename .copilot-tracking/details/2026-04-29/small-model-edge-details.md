<!-- markdownlint-disable-file -->

# Small Model Edge Implementation Details

## Context References

* Plan: `.copilot-tracking/plans/2026-04-29/small-model-edge-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-29/small-model-edge-research.md`
* Planning log: `.copilot-tracking/plans/logs/2026-04-29/small-model-edge-log.md`

## Phase A Details

Files:

* `src/agents/modelRouting.ts`
* `src/agents/subagent.ts`
* `src/agents/modelRouting.test.ts`
* `src/agents/subagent.test.ts`

Steps:

1. Define helper task types: `explore`, `summarize`, `test-triage`, `memory-extract`, `edit`, `plan`, `review`, `general`.
2. Define policy slots: small helper model, default model, strong model, fallback model.
3. Score task signals: prompt length, tool mutability, requested risk, previous failure count, confidence.
4. Return selected model, helper preset, and escalation reason.
5. Keep explicit subagent config model as highest precedence.

Success criteria:

* Smaller models are selected for bounded read-only tasks.
* Stronger model is selected for high-risk or low-confidence tasks.
* Presets restrict tools by task type.

## Phase B Details

Files:

* `src/learning/sessionLearning.ts`
* `src/learning/sessionLearning.test.ts`

Steps:

1. Convert session events into candidate examples with input, outcome summary, tool names, source event IDs, and quality score.
2. Gate candidates by minimum tool success rate and presence of useful user/assistant content.
3. Persist candidates as JSONL under `.harness/learning/session-candidates.jsonl`.
4. Avoid direct prompt evolution or model training from raw events.

Success criteria:

* High-quality sessions produce candidates.
* Failed/noisy sessions are skipped or scored low.
* Candidate persistence is append-only.

## Phase C Details

Files:

* `src/learning/evalTrace.ts`
* `src/learning/evalTrace.test.ts`

Steps:

1. Convert `RuntimeTracer.snapshot()` into compact eval examples.
2. Include input, expected behavior, spans, tool events, status, and tags.
3. Persist examples as JSONL under `.harness/evals/trace-examples.jsonl`.
4. Keep example schema stable and local-first.

Success criteria:

* Successful traces produce usable eval examples.
* Error traces include failure labels for regression testing.
* Export helper writes JSONL.

## Phase D Details

Files:

* `src/index.ts`
* Any new test files

Steps:

1. Export new public primitives.
2. Run `npm test -- --runInBand`.
3. Run `npm run typecheck`.
4. Record validation results in changes and review logs.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: file operations, implementation, validation, review
* In-progress step: Phase 5 Discover
* Remaining steps: present suggested next work
