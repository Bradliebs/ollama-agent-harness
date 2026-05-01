<!-- markdownlint-disable-file -->

# Agent Harness Filter Transcript Cleanup Planning Log

## Discrepancy Log

* No functional discrepancies. Cleanup controls intentionally remove only trace export files and the derived semantic index, preserving append-only session transcripts.

## Implementation Paths Considered

* Selected: client-side trace filtering to avoid new server query complexity for saved JSON exports.
* Selected: bounded transcript context around a memory entry rather than serving complete transcript files.
* Selected: cleanup derived trace and semantic-index state only, preserving append-only session transcripts.

## Suggested Follow-On Work

* Add trace export retention policies for automatic cleanup.
* Add transcript jump actions from context rows into session recovery.

## Validation Iterations

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 72 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* `npm run smoke:ui -- http://127.0.0.1:4304/`: passed in static mode.
* Live browser validation at `http://127.0.0.1:4304/`: passed; trace filter rendered and filtered, runtime storage summary rendered, palace transcript context rendered with anchor row, and no duplicate ids were found.
