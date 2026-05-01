<!-- markdownlint-disable-file -->

# Small Model Edge Integration Research

## Scope

Continue with all latest suggested work items:

1. Routing Configuration Surface
2. Learning Candidate Promotion
3. Eval Trace UI/API Export
4. Subagent Runtime Metrics
5. Model Policy Tests With Real Settings

## Assumptions

* Keep model routing configurable but local-first through existing CLI and web settings surfaces.
* Preserve the simple query loop; routing and learning integration should sit around agent/subagent and post-session flows.
* Promote learning candidates only after quality gates pass; do not mutate model weights automatically.

## Evidence Log

* `src/agents/modelRouting.ts` has policy types and decisions but no persisted settings or UI/CLI surface.
* `src/agents/subagent.ts` resolves helper presets but does not persist runtime metrics for routing calibration.
* `src/learning/sessionLearning.ts` can extract and append candidates but has no promotion path into memory.
* `src/learning/evalTrace.ts` can append eval examples but is not wired to web trace endpoints.
* `src/web/server.ts` already persists settings, exports raw traces, and runs a post-session learning hook after chat streams.
* `ui/index.html` and `ui/app.js` already expose context, trace, and runtime settings panels where routing/eval controls can fit.

## Selected Approach

* Extend `WebSettings` with a `modelRouting` policy and render it in Settings.
* Add CLI options for small/default/strong helper model routing policy and expose the effective policy through config-friendly types.
* Add learning promotion helpers that append accepted candidates to `.harness/memory/patterns.md` as reviewable memory, never as automatic weight training.
* Add `/api/evals/trace-examples` endpoints to append the current trace snapshot as an eval example and list generated JSONL examples.
* Add subagent routing metrics as append-only JSONL under `.harness/learning/subagent-routing.jsonl`.

## Success Criteria

* Web settings can persist model routing policy values and tests verify the saved shape.
* CLI accepts helper routing model options.
* Chat sessions can produce accepted learning candidates and promoted memory entries after completion.
* Current trace snapshots can be converted to eval examples through API and UI controls.
* Subagent preset execution records routing metrics.
* Jest and TypeScript validation pass.

## Artifact Status

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%

## Current Phase State

* Last phase before compaction: Phase 1 Research
* Completed steps: code inspection, integration point selection, success criteria
* In-progress step: plan creation
* Remaining steps: implement, validate, review, discover
