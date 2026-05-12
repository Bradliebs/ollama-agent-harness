# Ollama Agent Harness v0.1.9

## Changes

### Release Note Pruning Changes

Fixed generated release notes so CI fallback output includes only the requested changelog version section plus release provenance.

* `scripts/release-notes.js` - extracts the requested version section from `CHANGELOG.md` when `.copilot-tracking` changes are not available in CI.

## Validation

* Release note generation was validated with a missing changes directory to match the CI fallback path.

## Release Provenance

* Commit: `655b7ab8c78754dacec8e700007e2a7ee91225c3`
* Asset: `ollama-agent-harness-v0.1.9.zip`
* Asset size: 280724 bytes
* Asset SHA-256: `567c795290af3e447d0cf79a97c054b307c784314552b951788831107132bff4`
