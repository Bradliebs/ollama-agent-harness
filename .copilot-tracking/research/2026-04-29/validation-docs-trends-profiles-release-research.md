<!-- markdownlint-disable-file -->

# Validation Docs Trends Profiles Release Research

## Scope

Continue all suggested work items from the prior Phase 5 output:

1. Document Output Validation.
2. Add Validation Trends UI.
3. Add Profile Authoring.
4. Release Validation Feature.

## Assumptions

* All RPI workflow state is managed through `.copilot-tracking/` files.
* Output validation remains optional and deterministic.
* Custom profile authoring should use local files under `.harness/` rather than TypeScript edits.
* Release work can commit and tag because the selected follow-up explicitly includes packaging, tag, and GitHub release verification.

## Evidence Log

* `README.md` describes media tools, settings, and releases, but does not document output validation profiles or CLI usage.
* `src/core/outputValidation.ts` contains the built-in profile validators and prompt instructions.
* `src/web/server.ts` already persists output validation settings, records validation eval runs, and exposes eval run trends through `/api/learning` and `/api/evals/runs`.
* `ui/app.js` already renders eval trends by tag, but it does not distinguish output-validation trends from other eval runs.
* `scripts/ui-smoke.js` already checks output-validation settings and grouped rendering hooks.
* `.github/workflows/release.yml`, `scripts/release-notes.js`, `scripts/release-smoke.js`, and `CHANGELOG.md` already provide the release path used by `v0.1.5`.

## Selected Approach

* Add README output-validation guidance, including CLI usage, profile selection, and structural-validation limits.
* Add custom profile definitions with a local JSON file shape under `.harness/output-validation-profiles.json` and deterministic text checks.
* Load custom profiles in the web server, expose them through settings, support save/reload endpoints, and pass them into query loop validation.
* Add Learning panel UI for output-validation trend summaries and recent validation failures.
* Bump package metadata, update `CHANGELOG.md`, generate release notes, run archive smoke, commit, tag, push, and verify GitHub workflows.

## Success Criteria

* README documents built-in profiles, CLI usage, local custom profile JSON, and limitations.
* Custom profile definitions can be loaded without editing TypeScript and can validate output deterministically.
* Browser Settings can show built-in plus custom profiles and save custom JSON.
* Learning panel surfaces output-validation run trends separately from general eval runs.
* Local validation passes, release archive smoke passes, and GitHub release verification completes.
