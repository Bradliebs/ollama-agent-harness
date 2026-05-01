# Ollama Agent Harness v0.1.8

## Changes

### Beginner Proof Validation Experience Changes

Added beginner-friendly profile authoring, validation trend export, and release provenance in generated release notes.

* `ui/index.html` and `ui/app.js` - add guided custom profile form controls that write valid profile JSON for users.
* `src/learning/evalTrace.ts` - exports output-validation trend data with raw validation results.
* `src/web/server.ts` - adds a JSON download endpoint for validation trend exports.
* `scripts/release-notes.js` - adds commit SHA, asset name, asset size, and SHA-256 digest to release notes when an asset is provided.
* `.github/workflows/release.yml` - passes the packaged release asset and commit SHA into release note generation.

## Validation

* Focused learning and web server Jest suites, TypeScript typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke passed locally before release packaging.

## Release Provenance

* Commit: `f93c0731e91aafe119c6d03447e5b0c58c315cda`
* Asset: `ollama-agent-harness-v0.1.8.zip`
* Asset size: 280649 bytes
* Asset SHA-256: `b07174453172726762dd903685c93737005159f197334815064d08986ccc2614`
