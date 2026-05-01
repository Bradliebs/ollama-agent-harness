<!-- markdownlint-disable-file -->

# Setup Flow CI Release Assets Research

## Scope

Continue all suggested next work:

1. Add release assets.
2. Add first-run setup flow.
3. Add repository hygiene through GitHub Actions.

## Findings

* The project already has a pushed GitHub repo at `https://github.com/Bradliebs/ollama-agent-harness`.
* The current release is `v0.1.0`, published from commit `e44ec70`.
* The worktree is clean except `.copilot-tracking/` and `2604.14228v1.pdf`.
* The browser UI already has settings fields for Ollama host, vision model, and audio transcription command.
* First-run setup can be a compact panel in the initial welcome screen that writes the same settings values through existing functions.
* GitHub Actions can run `npm ci`, `npm run typecheck`, `npm test -- --runInBand`, `npm run build`, and the static UI smoke script against a local server.
* Release assets should be generated after validation and attached to the current release baseline.

## Selected Approach

* Add an inline first-run panel to the welcome screen and recreate it in `newChat()`.
* Add `applyFirstRunSetup()` in the UI to persist Ollama host, vision model, and audio command.
* Add GitHub Actions workflow `.github/workflows/ci.yml`.
* Extend smoke checks to assert first-run setup controls and function exist.
* Validate locally, commit, push, build a zip artifact, and attach it to `v0.1.0`.

## Success Criteria

* Beginners can configure the core local setup from the first screen.
* GitHub Actions validates pushes and pull requests.
* Release `v0.1.0` has a generated build artifact attached.
* Local validation remains green.
