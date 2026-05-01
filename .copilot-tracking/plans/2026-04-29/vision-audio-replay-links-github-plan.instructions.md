<!-- markdownlint-disable-file -->

# Vision Audio Replay Links GitHub Plan

## User Requests

1. Do all suggested next work.
2. Create and push to a GitHub repo because no repo is set up.

## Objectives

* Add true image input handling through an Ollama vision tool.
* Add local audio transcription tooling through a configurable command hook.
* Add replay run failure drill-down links in the UI.
* Validate the work and push to a new GitHub remote if authenticated.

## Implementation Checklist

### Phase A: Multimodal Tools <!-- parallelizable: false -->

* [x] Add `image_analyze` built-in tool and tests.
* [x] Add `audio_transcribe` built-in tool and tests.
* [x] Register multimodal tools in exports and built-in tool list.

### Phase B: Browser Guidance And Replay Drill-Down <!-- parallelizable: false -->

* [x] Update attachment prompt guidance for image/audio tools.
* [x] Render latest replay run failure source links in the Learning eval panel.
* [x] Extend UI smoke hooks.

### Phase C: Validation And GitHub Push <!-- parallelizable: false -->

* [x] Run focused Jest, full Jest, typecheck, diagnostics, and UI smoke.
* [x] Inspect git status and GitHub CLI auth.
* [x] Create a new GitHub repo and push if auth is available.

## Dependencies

* `src/tools/`
* `src/web/server.ts`
* `src/web/server.test.ts`
* `src/index.ts`
* `ui/app.js`
* `scripts/ui-smoke.js`
* Git and GitHub CLI or equivalent remote creation support.

## Success Criteria

* New multimodal tools are available to the agent loop and covered by tests.
* UI prompt guidance naturally steers media attachments to the new tools.
* Failed replay run rows show trace/session/context source links when available.
* Validation passes.
* Remote repo is created and pushed, or a clear auth blocker is documented.
