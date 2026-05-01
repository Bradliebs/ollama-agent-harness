<!-- markdownlint-disable-file -->

# Routing Learning Eval Manager Planning Log

## Discrepancy Log

* Existing behavior auto-promotes accepted learning candidates after chat. The selected follow-up requires an explicit review queue, so implementation will remove automatic promotion from the web post-session hook.

## Implementation Paths Considered

* Selected: append-only candidate review records merged with candidate JSONL for queue status.
* Selected: rewrite eval example JSONL for tag/delete operations because eval datasets are curated runtime artifacts rather than append-only session transcripts.
* Selected: calibration suggestions derived from stored routing metrics without changing policy automatically.

## Suggested Follow-On Work

1. Add an evaluation runner that executes curated trace examples and reports pass/fail trends.
2. Add candidate provenance detail so reviewers can inspect source events before promotion.
3. Add an apply-calibration workflow that turns policy suggestions into reviewed settings updates.
4. Add dynamic browser smoke coverage for the Learning panel when Playwright is available.

## Validation Iterations

* Initial focused Jest run failed on a brittle nested route calibration assertion. The endpoint response was correct, so the test was changed to direct assertions.
* Second focused Jest run failed because append-only review state reused a deterministic candidate id from the prior failed run. The test now seeds a unique candidate id.
* Focused Jest rerun passed, 4 suites and 30 tests.
* Full Jest passed, 18 suites and 93 tests.
* Typecheck passed.
* Diagnostics passed with no errors in changed source, UI, or smoke files.
* UI smoke passed at `http://127.0.0.1:4306/`.

## Artifact Status

* Research document: 100%
* Implementation plan: 100%
* Implementation details: 100%
* Planning log: 100%
* Changes log: 100%
* Review log: 100%

## Current Phase State

* Last phase before compaction: Phase 5 Discover
* Completed steps: reviewed recent artifacts, searched current source and UI hooks, selected next work items
* In-progress step: present suggested next work
* Remaining steps: none
