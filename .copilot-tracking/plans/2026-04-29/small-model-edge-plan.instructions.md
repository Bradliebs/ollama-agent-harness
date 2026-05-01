<!-- markdownlint-disable-file -->

# Small Model Edge Implementation Plan

## User Requests

1. Continue with all suggested work items from the prior Phase 5 output.
2. Implement a model routing policy for smaller helper agents.
3. Implement a memory learning pipeline that improves future behavior without unsafe automatic model retraining.
4. Implement helper agent presets for bounded tasks.
5. Implement evaluation trace dataset capture.
6. Implement escalation heuristics for when smaller helpers should defer to stronger models.
7. Follow the attached RPI prompt requirements, including tracking artifacts and completion summaries.

## Overview And Objectives

The goal is to give smaller local models an edge through harness-level capabilities: routing, isolated helper agents, curated session learning, evaluation trace capture, and escalation. This should preserve the harness architecture: minimal core loop, tool/routing systems around it, append-only session state, and bounded subagent contexts.

## Context Summary

* `FORGE.md` describes this project as a local-first Ollama Agent Harness with subagent isolation, context scarcity, append-only state, and composable extensibility.
* `.github/skills/harness-conventions/SKILL.md` requires configurable model names, summary-only subagent returns, and no explicit planning graph in the core loop.
* `.github/skills/testing/SKILL.md` requires Jest tests alongside source files with mocked behavior rather than real Ollama calls.
* `src/agents/subagent.ts` is the natural integration point for helper presets and model routing.
* `src/learning/engine.ts`, `src/persistence/semanticMemory.ts`, and `src/core/tracing.ts` provide existing learning and trace foundations.

## Dependencies

* Discovered skill: `.github/skills/harness-conventions/SKILL.md`
* Discovered skill: `.github/skills/testing/SKILL.md`
* Instruction: `.github/copilot-instructions.md`
* Instruction: `hve-core/markdown.instructions.md`
* Instruction: `hve-core/commit-message.instructions.md`

## Implementation Checklist

### Phase A: Routing And Presets <!-- parallelizable: false -->

* [x] Add `src/agents/modelRouting.ts` with task types, risk signals, model policy, helper presets, and escalation decisions.
* [x] Update `src/agents/subagent.ts` so callers can use helper presets and routing without losing explicit config support.
* [x] Export routing primitives where appropriate.

### Phase B: Learning Pipeline <!-- parallelizable: true -->

* [x] Add `src/learning/sessionLearning.ts` to extract curated learning candidates from session events.
* [x] Include confidence/quality gates so noisy traces do not become durable instructions automatically.
* [x] Add JSONL persistence for learning candidates.

### Phase C: Evaluation Trace Dataset <!-- parallelizable: true -->

* [x] Add `src/learning/evalTrace.ts` to convert tracer snapshots into evaluation examples.
* [x] Add JSONL export helpers suitable for later prompt optimization or fine-tuning curation.

### Phase D: Tests And Exports <!-- parallelizable: false -->

* [x] Add focused Jest tests for routing, subagent preset resolution, learning candidates, and eval trace examples.
* [x] Update `src/index.ts` or relevant barrel exports if needed.
* [x] Run targeted tests, full tests, and typecheck.

## Planning Log Reference

See `.copilot-tracking/plans/logs/2026-04-29/small-model-edge-log.md`.

## Success Criteria

* All five continuation items have code-level support.
* Existing tests continue passing.
* New tests cover the new behavior.
* No raw session data is automatically promoted into permanent instructions or model weights.
* The harness remains local-first and configurable.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 4 Review
* Completed steps: implementation, focused tests, full tests, typecheck
* In-progress step: discover follow-up work
* Remaining steps: present suggested next work
