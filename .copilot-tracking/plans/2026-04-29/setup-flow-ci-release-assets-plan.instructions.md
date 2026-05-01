<!-- markdownlint-disable-file -->

# Setup Flow CI Release Assets Plan

## User Requests

1. Continue all prior suggested next work.
2. Summarize completion with phase/artifact status and validation state.

## Checklist

### Phase A: First-Run Setup <!-- parallelizable: false -->

* [x] Add first-run setup controls to the welcome screen.
* [x] Add browser logic to persist first-run settings.
* [x] Keep settings behavior aligned with existing `/api/settings` flow.

### Phase B: Repository Hygiene <!-- parallelizable: false -->

* [x] Add GitHub Actions CI workflow.
* [x] Cover typecheck, tests, build, and UI smoke.
* [x] Extend local UI smoke coverage for first-run setup hooks.

### Phase C: Release Assets <!-- parallelizable: false -->

* [x] Run validation.
* [x] Commit and push changes.
* [x] Generate a build artifact.
* [x] Upload the artifact to GitHub release `v0.1.1`.

## Success Criteria

* First-run setup is visible and functional on the main page.
* CI workflow exists and mirrors local validation.
* Release asset is attached to the GitHub release.
* Validation passes.
