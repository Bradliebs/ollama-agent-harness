<!-- markdownlint-disable-file -->

# Beginner Proof Validation UX Export Provenance Planning Log

## Discrepancy Log

* Published v0.1.8 release notes initially included older changelog sections because CI does not have local `.copilot-tracking` change artifacts and the fallback path used the whole `CHANGELOG.md` file.
* Resolution: updated `scripts/release-notes.js` to extract only the requested version section, corrected the published v0.1.8 release body, and shipped v0.1.9 as a patch release.
* Follow-up discrepancy: JavaScript regex does not support `\z`, so the first fallback extractor could truncate a section at a literal `z` character.
* Resolution: replaced fallback extraction with line-based heading parsing, corrected published v0.1.8 and v0.1.9 release bodies, and shipped v0.1.10 as the final hardening patch.

## Implementation Paths Considered

* Selected: form writes to the existing JSON profile API, preserving one source of truth.
* Selected: trend export returns a JSON attachment from the server, matching existing eval dataset download behavior.
* Selected: release notes compute SHA-256 from the packaged asset before publishing.

## Validation Plan

Focused Jest, typecheck, full Jest, build, UI smoke, release notes generation, local archive smoke, GitHub CI, and GitHub Release.

## Validation Results

* v0.1.8 local validation passed: focused Jest, typecheck, full Jest, build, UI smoke, release notes generation, and release archive smoke.
* v0.1.8 remote validation passed: CI run 25110065588 and Release run 25110067017 completed successfully, including published asset verification.
* v0.1.9 local validation passed: release notes fallback generation, typecheck, full Jest, build, release notes generation, and release archive smoke.
* v0.1.9 remote validation passed: CI run 25110242257 and Release run 25110243703 completed successfully, including published asset verification.
* v0.1.10 local validation passed: release notes fallback generation, typecheck, full Jest, build, release notes generation, and release archive smoke.
* v0.1.10 remote validation passed: CI run 25110437920 and Release run 25110439736 completed successfully, including published asset verification.
