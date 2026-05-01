<!-- markdownlint-disable-file -->

# Agent Harness UI Memory Palace Planning Log

## Discrepancy Log

* No functional discrepancies. The memory palace is derived from semantic memory instead of storing a separate palace file, matching the selected approach.

## Implementation Paths Considered

* Selected: derive memory palace rooms from semantic memory entries instead of introducing a new storage format.
* Selected: persist settings in `.harness/settings.json` because runtime artifacts are already ignored by Git.
* Selected: use existing trace export APIs for the UI rather than adding a separate trace viewer service.

## Suggested Follow-On Work

* Add deeper trace inspection for individual spans and events.
* Add visual links from palace anchors back to source sessions.

## Validation Iterations

* `npm run typecheck`: passed before and after test/UI fixes.
* First `npm test -- --runInBand`: failed because the memory palace endpoint test used `toMatchObject` against an array field too literally.
* Updated the endpoint test to assert array shape directly.
* Reran `npm test -- --runInBand`: passed, 14 suites and 68 tests.
* VS Code diagnostics for `src`, `ui`, and `scripts`: no errors found.
* Live UI smoke at `http://127.0.0.1:4302/`: passed; trace exports render, Palace tab renders rooms, send button is present, and no duplicate ids were found.