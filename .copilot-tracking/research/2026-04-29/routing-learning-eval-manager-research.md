<!-- markdownlint-disable-file -->

# Routing Learning Eval Manager Research

## Scope

Continue with all latest suggested work items:

1. Routing Metrics Dashboard
2. Learning Candidate Review Queue
3. Eval Dataset Manager
4. Policy Calibration Tests

## Assumptions

* All workflow state for this session is managed through `.copilot-tracking/` files.
* Runtime learning, eval, and metric data remains local-first under `.harness/`.
* Learning candidate promotion must become an explicit review action instead of an automatic post-chat side effect.
* Keep the core query loop and subagent isolation unchanged.

## Evidence Log

* `src/agents/subagent.ts` writes append-only routing metrics and `listSubagentRoutingMetrics` can read them.
* `src/learning/sessionLearning.ts` appends candidates and promotes accepted candidates, but does not yet store review decisions.
* `src/learning/evalTrace.ts` appends and lists eval examples, but cannot tag, delete, or download a dataset.
* `src/web/server.ts` exposes `/api/learning` and eval trace creation/listing, which are the right integration points for dashboards and review actions.
* `ui/app.js` already renders the Learning panel and Settings trace controls, so UI changes can stay localized.
* `src/agents/modelRouting.ts` has routing thresholds, but no replay/calibration helper over historical metrics.

## Selected Approach

* Add derived routing metric summaries in the web API and render them in the Learning panel.
* Add append-only candidate review records and explicit promote/reject endpoints.
* Stop automatic candidate promotion after web chat; append the candidate and leave promotion to the review queue.
* Add eval dataset helpers for download, tagging, and deletion, then expose UI controls.
* Add policy calibration over stored subagent routing metrics and focused tests for threshold recommendations.

## Success Criteria

* Learning panel shows routing metrics, candidate review actions, eval dataset controls, and calibration suggestions.
* API supports candidate promote/reject, eval download/tag/delete, and routing metric summaries.
* Stored candidate reviews are append-only.
* Focused and full Jest suites pass.
* TypeScript and UI smoke checks pass.

## Artifact Status

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%

## Current Phase State

* Last phase before compaction: Phase 1 Research
* Completed steps: inspected current API, UI, learning, eval, routing, and subagent metric surfaces
* In-progress step: implementation planning
* Remaining steps: implement, validate, review, discover
