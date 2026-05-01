<!-- markdownlint-disable-file -->

# Vision Audio Replay Links GitHub Research

## Scope

Implement all latest suggested next work and then create/push a GitHub repository:

1. True Vision Inputs
2. Audio Transcription Tooling
3. Replay Run Failure Drill-Down
4. Create and push to a GitHub repo when implementation is complete

## Assumptions

* Keep multimodal support local-first and dependency-light.
* Use Ollama vision message support for image analysis through a dedicated tool.
* Provide audio transcription as a local command hook because the project has no bundled audio transcription dependency.
* Prefer a private GitHub repository if creating a new remote without explicit visibility guidance.
* Do not push until validation passes and GitHub auth/remote state is checked.

## Evidence

* `ui/app.js` already classifies image/audio uploads and tells the model when attachments are present, but there is no tool that actually passes images into Ollama.
* `src/tools/index.ts` registers built-in tools; a multimodal tool module can be added without changing the core loop.
* `OllamaClient` does not expose images, but the official `ollama` client can be used directly in a tool for image message payloads.
* Audio transcription is not present in dependencies; a command hook avoids adding a heavy model/runtime dependency.
* Replay examples have source links, but latest run failures are only summarized in trends and not inspectable in the UI.

## Selected Approach

* Add `image_analyze` built-in tool that reads a local image, base64-encodes it, and sends it to Ollama with an image-capable model.
* Add `audio_transcribe` built-in tool that runs `HARNESS_AUDIO_TRANSCRIBE_COMMAND` with `{input}` substitution and returns bounded transcript text.
* Update attachment prompt guidance to instruct the model to use `image_analyze` or `audio_transcribe` for media attachments.
* Add replay latest-run failure rows with trace/session/context links in the eval dataset UI.
* Validate with focused tests, full tests, typecheck, diagnostics, and UI smoke.
* After validation, inspect GitHub CLI auth and create/push a new repository if possible.

## Success Criteria

* Image uploads can be analyzed by a real tool that passes image data into Ollama.
* Audio uploads have a configurable local transcription path and clear fallback error when no command is configured.
* Replay run failures show direct source links in the Learning eval UI.
* Validation passes.
* A GitHub remote is created and pushed, or the exact auth blocker is reported.
