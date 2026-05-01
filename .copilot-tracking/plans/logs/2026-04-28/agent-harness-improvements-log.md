<!-- markdownlint-disable-file -->

# Agent Harness Improvements Planning Log

## Discrepancy Log

* Test fixture discrepancy: initial query loop compaction test used fewer than four non-system messages, so auto-compaction correctly did not run. The fixture was expanded to meet the production threshold.

## Implementation Paths Considered

* Selected: small hardening and unification changes within existing modules.
* Rejected: broad authentication framework or replacing the tool runtime.

## Suggested Follow-On Work

* Add structured tracing spans for model calls, tool calls, permissions, and compaction.
* Add UI tests for recovery banners, context HUD, and settings validation.

## Validation Iterations

* First Jest run failed in `src/core/queryLoop.test.ts` because the compaction fixture did not reach the minimum conversation length for auto-compaction.
* Updated the fixture and reran Jest successfully.
* TypeScript typecheck passed after implementation.
