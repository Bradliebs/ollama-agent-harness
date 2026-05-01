<!-- markdownlint-disable-file -->

# Agent Harness Observability UI Tests Details

## References

* Plan: `.copilot-tracking/plans/2026-04-28/agent-harness-observability-ui-tests-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-28/agent-harness-observability-ui-tests-research.md`

## Phase Details

### Phase 1: Tracking Artifacts

Create RPI research, plan, details, log, changes, and review artifacts.

### Phase 2: Runtime Tracing

Add a dependency-free tracer and thread it into model, compaction, session, permission, and tool boundaries.

### Phase 3: Permission Prompt Broker and Server Refactor

Export `app`, guard startup, add pending permission endpoints, and use the broker when `PermissionEngine` returns `ask`.

### Phase 4: UI Script Modularization and Prompt UI

Move inline JavaScript into `ui/app.js`, load it from `index.html`, and add polling plus approve/deny controls.

### Phase 5: API and File Tool Tests

Add Jest tests for web endpoints and file/grep safety behavior.

### Phase 6: Validation and Review

Run tests, typecheck, diagnostics, and browser smoke test.
