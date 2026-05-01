<!-- markdownlint-disable-file -->

# Agent Harness Observability UI Tests Planning Log

## Discrepancy Log

* The API test listener initially read the assigned port before the HTTP server finished binding. The test setup now waits for the `listen` callback.
* The first UI extraction left the legacy inline script as inert text. It was removed so active browser behavior now lives in `ui/app.js`.

## Implementation Paths Considered

* Selected: dependency-free HTTP tests using a real listener and built-in `fetch`.
* Selected: in-process permission prompt broker for local web sessions.
* Rejected: adding Supertest or Playwright dependencies during this focused cycle.

## Suggested Follow-On Work

* Add browser automation once UI modules are stable.
* Add persistent trace export for longer debugging sessions.

## Validation Iterations

* `npm run typecheck`: passed after tracing and server refactor.
* Initial `npm test -- --runInBand`: failed only in `src/web/server.test.ts` because the test server setup read `server.address()` before binding completed.
* Fixed the listener setup and reran `npm run typecheck`: passed.
* Reran `npm test -- --runInBand`: passed, 13 suites and 59 tests.
* VS Code HTML diagnostics initially reported inline styles and missing accessible names in `ui/index.html`; fixed those issues in the touched markup.
* UI smoke test loaded `http://127.0.0.1:4301/`, confirmed `ui/app.js` is active, confirmed the legacy inline script is absent, confirmed the permission panel is created, and confirmed no duplicate DOM ids.
