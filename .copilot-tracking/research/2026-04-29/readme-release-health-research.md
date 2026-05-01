<!-- markdownlint-disable-file -->

# README Release Health Research

## Scope

Continue all suggested next work:

1. Add CI status and release links to README.
2. Automate release packaging on version tags.
3. Add first-run health checks for Ollama host and media helper readiness.

## Findings

* The repository is `Bradliebs/ollama-agent-harness` and already has CI on `master`.
* The latest release is `v0.1.1` with a manually generated zip asset.
* The first-run panel already persists Ollama host and media settings through `/api/settings`.
* The server has access to Ollama via the official client and can validate host/model availability.
* Audio readiness can be reported by checking whether an audio transcription command is configured.
* A release workflow can package `dist`, `ui`, `scripts`, package metadata, README, and `start.bat` when tags like `v*.*.*` are pushed.

## Selected Approach

* Add a setup health endpoint that checks Ollama connectivity, optional vision model availability, and audio command configuration.
* Add a first-run health button and status rendering in the welcome panel.
* Add README CI and release badges/links.
* Add `.github/workflows/release.yml` to build and upload zip assets on version tags.
* Bump to `0.1.2`, tag, and push to exercise the new release workflow.

## Success Criteria

* README shows CI status and release entry points.
* First-run setup can test local readiness without leaving the main page.
* Release workflow exists and can create tag release assets.
* Validation passes locally and CI/release workflow complete on GitHub.
