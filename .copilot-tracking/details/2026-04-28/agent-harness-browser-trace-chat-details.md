<!-- markdownlint-disable-file -->

# Agent Harness Browser Trace Chat Details

## References

* Plan: `.copilot-tracking/plans/2026-04-28/agent-harness-browser-trace-chat-plan.instructions.md`
* Research: `.copilot-tracking/research/2026-04-28/agent-harness-browser-trace-chat-research.md`

## Phase Details

### Phase 1: Tracking Artifacts

Create research, plan, details, planning log, changes, and review artifacts.

### Phase 2: Persistent Trace Exports

Add trace export helpers and HTTP endpoints under `/api/traces/exports`.

### Phase 3: Prompt Broker Tests

Add direct Jest tests for listing, resolving, clearing, and timing out prompts.

### Phase 4: Injectable Chat Dependencies and SSE Tests

Refactor the web chat route to allow dependency injection and add mocked SSE tests.

### Phase 5: Browser Automation Script and Smoke Validation

Add a reusable browser smoke script and run a live browser validation with the existing tools.

### Phase 6: Validation and Review

Run typecheck, Jest, diagnostics, browser smoke, and compile final review notes.