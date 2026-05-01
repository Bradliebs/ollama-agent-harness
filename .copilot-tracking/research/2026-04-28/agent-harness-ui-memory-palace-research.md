<!-- markdownlint-disable-file -->

# Agent Harness UI Memory Palace Research

## Scope

Implement the selected follow-up items and the new memory palace request:

1. Trace viewer UI.
2. Chat cancellation.
3. Settings persistence.
4. Memory palace.

## Evidence Log

* `src/web/server.ts` already exposes trace snapshot export APIs and can be extended with settings file persistence without changing the route shape.
* `queryLoop` already accepts `config.abortSignal`, so chat cancellation can use an `AbortController` in the server route and browser fetch controller in `ui/app.js`.
* `ui/app.js` has a single active chat send path and a right settings panel, which gives one place to add stop behavior and trace controls.
* `src/persistence/semanticMemory.ts` already rebuilds/searches session memory, so a memory palace can be derived from semantic entries rather than storing a second memory system.

## Selected Approach

* Add trace export and list controls in the right settings panel.
* Add browser and server-side abort support for active chat streams.
* Persist web settings to `.harness/settings.json` and load them before settings-dependent routes use state.
* Add a derived memory palace API that groups semantic memory entries into rooms by kind and session, then render that as a compact visual surface in the existing memory tab.

## Success Criteria

* Trace exports can be created and listed from the UI.
* The send button can stop an active chat request, and the server aborts the loop when the request closes.
* Settings survive server restart through a local `.harness/settings.json` file.
* Memory palace data is available through an API and visible in the browser memory tab.
* Typecheck, Jest, diagnostics, and browser smoke validation pass.

## Implementation Findings

* Server-side chat cancellation only needed a route-level `AbortController` because the core loop already honors `LoopConfig.abortSignal`.
* Settings persistence fit in the existing server state model by loading once from `.harness/settings.json` and saving after validated updates.
* Trace viewer controls can reuse the existing trace export endpoints without adding new server APIs.
* The palace model is useful as a derived view over session memory: rooms group conversation, tool, continuity, and system entries.