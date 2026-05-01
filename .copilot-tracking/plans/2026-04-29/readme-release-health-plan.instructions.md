<!-- markdownlint-disable-file -->

# README Release Health Plan

## User Requests

1. Continue all prior suggested next work.
2. Summarize completion with RPI phase/artifact status and validation state.

## Checklist

### Phase A: Health Checks <!-- parallelizable: false -->

* [x] Add setup health API.
* [x] Add first-run health button and status UI.
* [x] Add server and smoke coverage.

### Phase B: README And Release Automation <!-- parallelizable: false -->

* [x] Add README CI badge and release links.
* [x] Add tag-triggered release workflow.
* [x] Bump version for the automated release baseline.

### Phase C: Validate And Publish <!-- parallelizable: false -->

* [x] Run local validation.
* [x] Commit and push.
* [x] Tag and verify GitHub CI/release workflow.

## Success Criteria

* First-run health checks report Ollama, vision model, and audio command readiness.
* README exposes CI and release health.
* Tag-based release packaging is automated.
* Local and remote validation pass.
