# Ollama Agent Harness v0.1.10

## Changes

### Release Note Extraction Hardening Changes

Fixed changelog fallback extraction to use line-based section parsing instead of an unsupported end-of-string regex token.

* `scripts/release-notes.js` - parses changelog version sections by heading boundaries so release notes are not truncated by ordinary text.

## Validation

* Regenerated v0.1.8 and v0.1.9 fallback release notes from downloaded published assets and republished both release bodies with matching provenance.

## Release Provenance

* Commit: `655b7ab8c78754dacec8e700007e2a7ee91225c3`
