<!-- markdownlint-disable-file -->

# Agent Harness Inspector Palace Smoke Planning Log

## Discrepancy Log

* No functional discrepancies. The smoke script initially failed because Playwright is not installed in this workspace, so a dependency-free static fallback was added while preserving full browser checks when Playwright is available.

## Implementation Paths Considered

* Selected: client-side trace inspection using the existing saved export endpoint.
* Selected: focused memory entry lookup endpoint instead of loading full session transcripts for palace anchors.
* Selected: strengthen the optional smoke script rather than adding Playwright as a required project dependency.

## Suggested Follow-On Work

* Add trace filtering and search once trace exports grow larger.
* Add a session transcript side panel for palace anchor navigation.

## Validation Iterations

* `npm run typecheck`: passed.
* `npm test -- --runInBand`: passed, 14 suites and 70 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Live browser validation at `http://127.0.0.1:4303/`: passed; trace inspector rendered, palace rooms and anchors rendered, palace detail loaded a source memory entry, and no duplicate ids were found.
* Initial `npm run smoke:ui -- http://127.0.0.1:4303/`: failed because Playwright is not installed.
* Added static fallback mode to `scripts/ui-smoke.js`.
* Reran `npm run smoke:ui -- http://127.0.0.1:4303/`: passed in static mode.
