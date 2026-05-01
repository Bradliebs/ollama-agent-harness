<!-- markdownlint-disable-file -->

# Doctor Release Audio Presets Research

## Scope

Continue all four suggested items from the prior Phase 5 output:

1. Add CLI Setup Doctor.
2. Smoke Test Release Archive.
3. Improve Audio Readiness.
4. Document Model Presets.

## Difficulty

Medium-hard. The work spans CLI, web setup health, tool reuse, packaging workflow, release scripts, package metadata, docs, and tests.

## Findings

* Existing first-run health behavior lives in `src/web/server.ts` as `/api/setup/health` plus `checkSetupHealth`.
* The CLI currently performs only a basic Ollama health check during normal startup in `src/cli/index.ts`.
* Audio transcription logic already exists in `src/tools/multimodalTools.ts` and can be reused for sample-file validation through `AudioTranscribeTool`.
* The release workflow packages `dist`, `ui`, `scripts`, package metadata, README, and `start.bat`, but `start.bat` currently runs `npm run ui`, which depends on `ts-node src/web/server.ts`. That makes archive smoke testing useful because the package should run from compiled `dist`.
* README has existing media tool documentation and can link to a dedicated model presets doc.

## Selected Approach

* Extract setup health behavior into a shared `src/setup/health.ts` module used by both web and CLI.
* Add `harness doctor` with host, vision model, audio command, and optional audio sample arguments.
* Add optional audio sample path support to `/api/setup/health` and the first-run health UI.
* Add a release archive smoke script that unzips the release asset, verifies package contents, installs dependencies, checks CLI help, starts the compiled web server, and fetches the UI.
* Add a compiled UI server script and update `start.bat` to use it.
* Add `docs/MODEL-PRESETS.md` and link it from README.

## Success Criteria

* CLI doctor reports Ollama, vision, and audio readiness.
* First-run health can validate an audio sample when one is provided.
* Release workflow tests the generated zip before publishing.
* Release archive starts from `dist` rather than source-only TypeScript.
* Model preset docs are beginner-readable and tied to local Ollama setup.
