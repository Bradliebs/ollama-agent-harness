<!-- markdownlint-disable-file -->

# Agent Harness Improvements Research

## Scope

Implement all five follow-up items from the prior discovery pass:

1. Harden Local Web Server
2. Unify Tool Execution Path
3. Add Query Loop Runtime Tests
4. Bound Tool Output and File Reads
5. Ignore Runtime Artifacts

## Assumptions

* Existing uncommitted continuity, session recovery, semantic memory, and UI changes are user-owned and must be preserved.
* The harness should remain a simple loop with operational safety in surrounding systems.
* Local file and command access are intentional capabilities, but server and tool boundaries should make that intent explicit.

## Evidence Log

* `src/web/server.ts` defaulted to `dontAsk`, accepted mutable settings without validation, exposed file/path endpoints, and started listening without an explicit hostname.
* `src/core/queryLoop.ts` duplicated dispatch classification and execution logic instead of reusing `ToolDispatcher`.
* `src/tools/fileTools.ts` returned full file contents and accepted unchecked relative or absolute paths.
* `src/tools/grepTool.ts` recursively read complete files into memory.
* `.gitignore` did not ignore `.harness/` runtime state.
* Baseline validation passed before changes: Jest 8 suites and TypeScript typecheck.

## Selected Approach

* Keep the core loop pattern intact while extracting hook-aware dispatch behavior into the shared dispatcher.
* Add conservative path and settings validation in the local web server without adding external auth dependencies.
* Add bounded reads and grep safeguards using small helper functions local to the tool modules.
* Add behavior-focused Jest coverage for `queryLoop` rather than testing private implementation details.
* Ignore `.harness/` runtime files without deleting existing local data.

## Alternatives Considered

* Full authentication middleware with sessions or OAuth was rejected as too broad for a local-first harness.
* Replacing the tool system with an external agent framework was rejected because it violates the project convention of minimal scaffolding.
* Rewriting all file tools around streaming was deferred because bounded reads cover the immediate context and memory risk with less disruption.

## Success Criteria

* The web server binds to localhost and validates high-risk mutable inputs and local ids.
* `queryLoop` uses the same dispatcher class covered by dispatcher tests.
* File and grep tools cap output size and avoid unsafe path traversal patterns.
* Runtime query loop tests cover text completion, tool dispatch, permissions, hooks, session append, and context events.
* `.harness/` is ignored by Git.
* Jest and TypeScript validation pass after implementation.
