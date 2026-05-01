<!-- markdownlint-disable-file -->

# Agent Harness Observability UI Tests Research

## Scope

Implement all five follow-up items from the latest Phase 5 discovery:

1. Add API Server Tests
2. Add Runtime Tracing
3. Modularize UI Script
4. Add File Tool Tests
5. Implement Web Permission Prompts

## Evidence Log

* `src/web/server.ts` currently constructs and starts the Express app in one file, which blocks API-level tests from importing the app without starting a listener.
* `ui/index.html` contains all browser logic inline, making UI behavior harder to test or evolve.
* `PermissionEngine` exposes `ask`, but the web adapter maps only `allow` to success, so interactive prompts are not available.
* There is no structured runtime tracing module for model, tool, permission, compaction, or session events.
* File tools now have bounded behavior, but tests do not yet cover path enforcement, line ranges, truncation, or large-file grep skipping.

## Selected Approach

* Export the existing Express app and guard server startup behind `require.main === module`.
* Add a small in-process permission prompt broker for web approvals.
* Add `src/core/tracing.ts` and thread optional tracing through query loop and dispatcher boundaries.
* Move inline browser JavaScript to `ui/app.js` and add permission prompt polling and resolve actions.
* Add focused Jest tests using Node HTTP and built-in `fetch` rather than adding new dependencies.

## Success Criteria

* API tests cover settings validation, path constraints, and id validation.
* Runtime tracing is available and records spans/events without external dependencies.
* UI script is externalized and still loads in the browser.
* File tool tests cover new safety boundaries.
* Web permission prompts can be listed, approved, or denied through API and UI.
