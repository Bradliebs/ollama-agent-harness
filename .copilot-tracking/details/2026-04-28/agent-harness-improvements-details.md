<!-- markdownlint-disable-file -->

# Agent Harness Improvements Details

## References

* Plan: `.copilot-tracking/plans/2026-04-28/agent-harness-improvements-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-28/agent-harness-improvements-research.md`

## Phase Details

### Phase 1: Tracking Artifacts

Create research, plan, details, planning log, and later changes/review logs.

### Phase 2: Web Server Hardening

* Default permission mode to `default`.
* Validate permission mode, numeric settings, model names, hosts, and local ids.
* Bind the HTTP server to `127.0.0.1` by default.
* Restrict file tree paths to the project root.

### Phase 3: Tool Execution Unification

* Move hook-aware execution into `ToolDispatcher`.
* Use `ToolDispatcher` from `queryLoop`.
* Preserve tool usage tracking and hook behavior.

### Phase 4: Bounded Tool Output

* Add file read line range and max byte controls.
* Reject traversal paths for built-in file tools.
* Add grep file size limits and bounded file reads.

### Phase 5: Query Loop Runtime Tests

* Mock the Ollama client.
* Test text completion, tool dispatch, permission denial, hook mutation/blocking, session append, and context events.

### Phase 6: Runtime Artifact Ignores

* Add `.harness/` to `.gitignore`.

### Phase 7: Validation and Review

* Run Jest.
* Run TypeScript typecheck.
* Compile review status and next work suggestions.
