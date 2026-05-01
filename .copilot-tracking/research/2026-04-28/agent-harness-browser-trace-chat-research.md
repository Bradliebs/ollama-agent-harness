<!-- markdownlint-disable-file -->

# Agent Harness Browser Trace Chat Research

## Scope

Implement all four follow-up items from the latest Phase 5 discovery:

1. Add browser automation.
2. Persist trace exports.
3. Test prompt broker edge cases.
4. Inject chat dependencies for testable streaming.

## Evidence Log

* `ui/index.html` now loads active behavior from `ui/app.js`, so UI smoke coverage can target the real browser page rather than inline script extraction.
* `src/core/tracing.ts` currently stores bounded in-memory spans and events, but snapshots are only available through `/api/traces` and disappear with process memory.
* `src/permissions/promptBroker.ts` has timeout, clear, list, and resolve behavior without direct unit tests.
* `src/web/server.ts` exports `app`, but the chat route constructs clients, tools, sessions, and dependencies inside the route, which makes SSE chat testing hard without live Ollama.

## Selected Approach

* Add file-backed trace export APIs that write snapshots under `.harness/traces` and expose downloadable JSON files.
* Add direct Jest coverage for `PermissionPromptBroker` using fake timers.
* Refactor chat route construction behind injectable web runtime dependencies while preserving the default local runtime.
* Add browser automation through a lightweight smoke script that can drive a running UI with Playwright when available, plus keep tool-driven browser validation in this RPI run.

## Success Criteria

* Trace snapshots can be exported, listed, and downloaded without external services.
* Permission broker timeout, resolve, clear, and list behavior are tested.
* Chat streaming can be tested through the Express app with mocked dependencies.
* Browser automation exists for the externalized UI and is documented as an npm script.
* `npm run typecheck`, `npm test -- --runInBand`, diagnostics, and browser smoke validation pass.

## Implementation Findings

* Trace export persistence fits naturally in the web layer because the current tracer remains dependency-free and in-memory.
* A small `WebRuntimeDeps` override is sufficient to test `/api/chat` streaming without creating an app factory or changing the default server startup path.
* `PermissionPromptBroker` behavior is deterministic under Jest fake timers, so timeout coverage does not need slow real-time waits.
* Browser smoke automation can be added without changing install dependencies by keeping Playwright as an optional script-time requirement.