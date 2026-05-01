<!-- markdownlint-disable-file -->

# Media Settings Release Baseline Research

## Scope

Continue all suggested next work:

1. Add README setup for media tools.
2. Add media tool UI settings.
3. Add a GitHub release baseline.

## Findings

* The workspace has no root `README.md`; create one with markdown frontmatter.
* Settings persist through `.harness/settings.json` in `src/web/server.ts`.
* `image_analyze` reads `HARNESS_VISION_MODEL` when no model argument is supplied.
* `audio_transcribe` requires `HARNESS_AUDIO_TRANSCRIBE_COMMAND`.
* The UI settings panel already persists model routing and context fields through `/api/settings`.
* The GitHub repo exists at `https://github.com/Bradliebs/ollama-agent-harness`, with `master` tracking `origin/master`.

## Selected Approach

* Add `mediaTools` to persisted web settings.
* Apply media settings to `process.env` in the running server for immediate tool use.
* Add Settings inputs for vision model and audio transcription command.
* Document the media setup in a new root README.
* Commit, push, tag, and create a GitHub release after validation.
