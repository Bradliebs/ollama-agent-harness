<!-- markdownlint-disable-file -->

# Hermes Borrowed Patterns Planning Log

Date: 2026-04-30

## Discrepancy Log

* Initial tool registry implementation risked a circular import through the aggregate tool barrel. Corrected before validation by importing concrete tool modules directly in `src/tools/registry.ts` and preserving existing built-in tool order.

## Implementation Paths Considered

* Selected: small TypeScript modules that adapt Hermes patterns to Harness.
* Rejected: porting Hermes gateway, full plugin loading, or replacing JSONL session storage with SQLite.

## Suggested Follow-On Work Captured So Far

* Expose command/tool registries in the browser UI after backend primitives land.
* Add real cron expression support if local automations prove useful.
* Consider SQLite FTS as an optional acceleration layer after JSON index behavior stabilizes.

## Validation Iterations

* Targeted Jest passed: `npm test -- --runInBand src/cli/commands.test.ts src/cli/index.test.ts src/tools/registry.test.ts src/automation/jobs.test.ts src/setup/health.test.ts src/persistence/sessionSearchIndex.test.ts` passed, 6 suites and 13 tests.
* TypeScript typecheck passed: `npm run typecheck`.
* Full Jest passed: `npm test -- --runInBand` passed, 32 suites and 213 tests.
* Build passed: `npm run build`.

## Artifact Completion

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%
