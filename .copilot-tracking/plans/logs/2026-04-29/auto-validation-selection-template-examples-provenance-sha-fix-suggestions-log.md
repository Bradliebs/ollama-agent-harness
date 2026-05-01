<!-- markdownlint-disable-file -->
# Auto Validation Selection Template Examples Provenance SHA Fix Suggestions Log

## Discrepancy Log

* Final archive SHA cannot be embedded in the same zip after packaging because writing the digest changes the digest. The implementation uses a companion manifest.
* Generated `release/` artifacts from prior validation remain untracked and must not be committed.

## Implementation Paths Considered

* Embed final SHA in `release-provenance.json`: rejected because the archive digest changes after the file is updated.
* Publish a companion SHA manifest: selected because it records the final archive digest honestly and is simple to verify.
* Auto-select only in UI: rejected because server-side chat should apply the same behavior if settings are enabled.
* Auto-select in core and server: selected because it is deterministic, testable, and keeps UI as a visible control layer.

## Validation Notes

Local validation passed: focused validation/web tests, typecheck, full Jest, build, UI smoke, local release manifest generation, and release smoke.

Remote validation passed: CI run `25114367461` and Release run `25114371020` both completed successfully for commit `92ddf0aec8233b4213b015e5155b4faa65b4ea34`.

Published release: `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v0.1.13`.

Published assets: `ollama-agent-harness-v0.1.13.zip` and `ollama-agent-harness-v0.1.13.zip.sha256.json`.

## Suggested Follow-On Work

Phase 5 discovery will identify follow-on work after v0.1.13.

## Percent Complete

100% - validation and remote release verification recorded.
