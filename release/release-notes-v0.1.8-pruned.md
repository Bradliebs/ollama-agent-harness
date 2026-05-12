# Ollama Agent Harness v0.1.8

## Changes

### Beginner Proof Validation Experience Changes

Added beginner-friendly profile authoring, validation trend export, and release provenance in generated release notes.

* `ui/index.html` and `ui/app.js` - add guided custom profile form controls that write valid profile JSON for users.
* `src/learning/evalTrace.ts` - exports output-validation trend data with raw validation results.
* `src/web/server.ts` - adds a JSON download endpoint for validation trend exports.
* `scripts/release-notes.js` - adds commit SHA, asset name, asset si

## Validation

* Typecheck, tests, build, and release archive smoke are expected to pass before publishing.

## Release Provenance

* Commit: `f93c0731e91aafe119c6d03447e5b0c58c315cda`
* Asset: `ollama-agent-harness-v0.1.8.zip`
* Asset size: 269036 bytes
* Asset SHA-256: `11ec1ad52cf1409817066ea17bce81ef3b2e36d9b4de6e45b02d8477c8f42ac3`
