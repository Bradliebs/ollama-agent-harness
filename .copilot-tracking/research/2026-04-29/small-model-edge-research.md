<!-- markdownlint-disable-file -->

# Small Model Edge Research

## Scope

Implement all continuation items from the prior Phase 5 output:

1. Model Routing Policy
2. Memory Learning Pipeline
3. Helper Agent Presets
4. Evaluation Trace Dataset
5. Escalation Heuristics

## Assumptions

* The harness should improve small-model performance through orchestration, memory, retrieval, helper isolation, and validation rather than continual weight updates.
* True fine-tuning is out of scope for this implementation; the harness should produce curated trace/eval data that can feed later fine-tuning.
* Existing architecture should remain minimal scaffolding with complexity in surrounding harness systems.

## Success Criteria

* Subagents can use task-specific presets and a model routing policy.
* Routing can choose smaller helper models for bounded tasks and escalate when task signals indicate risk.
* Session outcomes can be converted into curated learning candidates.
* Runtime traces can be exported as evaluation examples.
* Unit tests cover routing, learning candidate extraction, eval trace generation, and subagent preset behavior.

## Evidence Log

* `.github/skills/harness-conventions/SKILL.md`: confirms minimal loop, subagent isolation, configurable model names, context scarcity, append-only state.
* `src/agents/subagent.ts`: already supports `SubagentConfig.model`, tool filtering by subagent name, isolated query loop, and summary-only return.
* `src/core/queryLoop.ts`: central point for model calls, tool dispatch, compaction, session writes, and tracing.
* `src/persistence/semanticMemory.ts`: provides session-derived searchable memory and can serve as the source for learning candidates.
* `src/learning/engine.ts`: already tracks tool usage, reflections, pattern detection, consolidation, and prompt evolution.
* `src/core/tracing.ts`: stores spans and events in-memory and can be transformed into eval examples.

## Selected Approach

Add focused modules instead of expanding the query loop heavily:

* `src/agents/modelRouting.ts`: task classification, model selection, helper presets, and escalation heuristics.
* `src/learning/sessionLearning.ts`: convert session events and outcomes into curated learning candidates.
* `src/learning/evalTrace.ts`: convert tracer snapshots into evaluation examples.
* Small changes to `src/agents/subagent.ts` to use presets/routing while preserving direct config use.

## Alternatives Considered

* Continual fine-tuning after every session: rejected because raw traces are noisy and risk overfitting.
* Large state machine planner: rejected because the harness convention prefers minimal scaffolding around a simple ReAct loop.
* Embedding-backed memory rewrite: deferred because the existing semantic memory is lexical but already useful for the requested learning pipeline.

## Actionable Next Steps

1. Create typed routing and helper preset module.
2. Wire subagent execution to derive config from presets when requested.
3. Add session learning extraction using existing session event structures.
4. Add eval trace conversion and JSONL export helpers.
5. Add focused Jest tests and run `npm test` plus `npm run typecheck`.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: research, planning, implementation, validation, review
* In-progress step: Phase 5 Discover
* Remaining steps: present suggested next work
