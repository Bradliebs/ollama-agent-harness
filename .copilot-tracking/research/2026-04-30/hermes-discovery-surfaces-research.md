<!-- markdownlint-disable-file -->

# Hermes Discovery Surfaces Research

## Scope

Continue all suggested work from the prior Phase 5 output:

1. Browser Discovery Panels
2. Extension Activation Policy
3. Team Model Catalog Settings

## Assumptions

* State remains managed through `.copilot-tracking/` for RPI artifacts and `.harness/` for runtime Harness state.
* Plugin execution remains out of scope until a stricter trust and sandboxing model exists.
* The browser should expose operational discovery in the existing app shell rather than as a separate page.

## Evidence Log

* `src/web/server.ts` already centralizes settings, runtime APIs, setup health, uploads, skills, memory, and learning routes.
* `ui/index.html` has a left operational tab column and a right settings panel.
* `ui/app.js` already follows small fetch/render helpers and smoke-friendly DOM IDs.
* `scripts/ui-smoke.js` verifies browser feature presence with Playwright or static checks.
* Second-pass primitives already exist for model catalogs, extension manifests, automation due jobs, and session search freshness.

## Selected Approach

* Add persisted settings for model catalog URL/TTL and extension activation policy.
* Add `/api/discovery` as the consolidated browser payload for catalog, extensions, automations, and session index freshness.
* Add refresh/rebuild endpoints where the browser needs an explicit action.
* Add a left-side Discovery tab with dense operational panels.
* Add right-panel settings for team model catalog and extension activation policy.

## Deferred Items

* Executable plugin loading.
* Background automation execution service.
* Full cron editor UI.

## Success Criteria

* New APIs are covered by server tests.
* Browser smoke coverage verifies Discovery panel and settings controls exist.
* Typecheck, targeted tests, full Jest, build, and UI smoke pass.

## Artifact Completion

* Research document: 100%
* Implementation plan: 0%
* Implementation details: 0%
* Planning log: 0%
* Changes log: 0%
* Review log: 0%