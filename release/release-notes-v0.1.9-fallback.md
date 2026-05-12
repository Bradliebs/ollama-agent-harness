# Ollama Agent Harness v0.1.9

## Changes

### Release Note Pruning Changes

Fixed generated release notes so CI fallback output includes only the requested changelog version section plus release provenance.

* `scripts/release-notes.js` - extracts the requested version section from `CHANGELOG.md` when `.copilot-tracking` changes are not available in CI.

## Validation

* Release note generation was validated with a missing changes directory to match the CI fallback path.

## Release Provenance

* Commit: `f93c0731e91aafe119c6d03447e5b0c58c315cda`
