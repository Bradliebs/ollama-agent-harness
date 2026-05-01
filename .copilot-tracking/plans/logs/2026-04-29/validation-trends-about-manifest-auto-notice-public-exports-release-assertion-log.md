<!-- markdownlint-disable-file -->
# Validation Trends About Manifest Auto Notice Public Exports Release Assertion Log

## Discrepancy Log

The release workflow initially had both the old archive-only pre-publish smoke and the new manifest-aware smoke. The archive-only duplicate was removed so the pre-publish check is the stricter archive-plus-manifest smoke.

## Implementation Paths Considered

* Store validation source in a new persistence file: rejected because output validation runs are already stored as eval trace runs.
* Add source metadata as a result tag: selected because it fits the existing append-only trend model and keeps exports backward-compatible.
* Add a new About API endpoint for manifest downloads: rejected for now because the manifest is hosted as a release asset and the release URL is already available.
* Use the existing release page URL to build the manifest asset link: selected as minimal and beginner-readable.

## Validation Notes

Local validation passed: focused validation/eval/web tests, TypeScript typecheck, full Jest, build, UI smoke, local release manifest generation, and release archive smoke with manifest assertions.

## Suggested Follow-On Work

Phase 5 discovery proceeding after successful remote release verification.

## Percent Complete

100% - implementation, local validation, commit/tag/push, and remote workflow runs all completed successfully.
