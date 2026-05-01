---
title: Ollama Agent Harness
description: Local-first Ollama agent harness with tools, tracing, learning, multimodal helpers, and a browser UI
author: Bradliebs
ms.date: 2026-04-29
ms.topic: overview
keywords:
  - ollama
  - agent
  - local-first
  - multimodal
estimated_reading_time: 5
---

[![CI](https://github.com/Bradliebs/ollama-agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Bradliebs/ollama-agent-harness/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bradliebs/ollama-agent-harness)](https://github.com/Bradliebs/ollama-agent-harness/releases/latest)

## Overview

Ollama Agent Harness is a local-first agent runtime and browser UI for working with Ollama models on project tasks. It combines a minimal ReAct-style loop with the operational pieces a coding assistant needs: tool dispatch, permission modes, session recovery, tracing, context continuity, learning datasets, and model routing.

The app is designed for local experimentation. Your runtime state is stored under `.harness/`, while implementation and planning notes from this assistant session are tracked separately under `.copilot-tracking/`.

## What's in the Harness

The browser UI organizes the surfaces below as left-side tabs and a right-side Settings panel.

* **Chats / Files / Memory / Palace / Discover / Learning / Snaps** — original surfaces for chat history, project files, agent memory, the memory palace browser, discovered patterns, learning trends, and skill / memory snapshots.
* **Skills** — runtime and repo skill libraries with diagnostics for skipped folders, install-from-repo and scaffold-missing actions, and the **Skill Curator** (see below).
* **RAG** — local vector index over chosen files. Tree picker with checkboxes, preview with per-path diagnostics (matched / missing / empty / unsupported), backend badge, build progress streamed via SSE, search results with **Read in chat / Ask about this / Copy** actions, **Load paths / Rebuild** for existing indexes. Auto-detects an Ollama embedding model (`nomic-embed-text` by default) and falls back to a deterministic offline hash backend.
* **Tools** — registry view grouped by toolset with risk badge (low / medium / high), permission category, read-only and dry-run pills, and a per-tool **Disable / Enable** toggle. Includes a **Permissions panel** with mode badge and a **🛑 Kill switch** that denies every subsequent tool call (even reads) until released.
* **Runs** — session list with status badges, duration, error rows, **Open transcript** and **Copy ID** actions, plus the most recent curator activity (color-coded by outcome).
* **Flows** — declarative tool-call sequences defined under `.harness/workflows/<name>.{yaml,json}`. Supports `dryRun`, `pause`, `resume`, `cancel`, and `${variables.foo}` substitution. Bundled `project_health_check.yaml` exercises `list_files`, `file_read`, and `bash`. Workflow steps that the permission engine denies show a distinct `denied` status.

### Skill Curator

A background skill maintenance loop modeled after the Curator pattern.

* **Phase 1 (deterministic)** flags skills past `staleDays` with at least `minViewsBeforeArchive` views and moves up to `maxArchivePerRun` unpinned candidates into `.harness/skills/_archive/<name>/`. Archive is reversible from the Skills tab.
* **Phase 2 (LLM)** asks the configured model to cluster related skills into umbrella merges. Proposals land in `.harness/curator/proposals.md`. The Skills tab parses them into cards with **Preview / Apply merge** buttons; applying a merge writes a new umbrella `SKILL.md` (concatenating source bodies) and archives the originals.
* **Heartbeat scheduler** ticks every 60 seconds, runs an hourly maintenance check, and only triggers the curator when (1) it is enabled, (2) the configured interval has elapsed, (3) the system has been idle for the configured threshold, and (4) the kill switch is not engaged.
* **Settings** live in `.harness/settings.json` under `curator` (Settings panel exposes Enable, Interval (h), Idle threshold (min), Stale (days), Min views before archive, Max archives per run, Enable LLM merge phase). Defaults: weekly interval, 2-hour idle threshold, 60-day stale, 5-archive cap, LLM phase off.
* **Audit log** at `.harness/curator/log.jsonl` records every action and is surfaced in both the Runs tab and the Discovery panel.
* **Per-skill metadata** (`useCount`, `viewCount`, `lastUsedAt`, `lastViewedAt`, `pinned`, `archived`) is persisted in `.harness/skill-usage.json`. The Skills tab shows use/view counts per card and a **Pin** button so the curator never archives chosen skills.

### Safety posture

The harness is a supervised execution surface, not an autonomous agent.

* Every tool call is evaluated by the permission engine in `default`, `acceptEdits`, or `dontAsk` mode.
* The kill switch denies every call (including read-only ones) until released. Toggle it from the Tools tab or from any view with **Ctrl+Shift+K** (Cmd+Shift+K on macOS). While active, a fixed red banner stays at the top of the page.
* Per-tool disables filter `getTools()` before each chat turn so the agent never sees disabled tools.
* The workflow runner treats the permission engine's `ask` decision as `denied` to keep batch execution deterministic.
* The curator scheduler is opt-in, gated by the kill switch, and never auto-applies LLM merge proposals — every merge requires an explicit Apply click.

## Quick Start

Install dependencies:

```powershell
npm install
```

Start the browser UI:

```powershell
npm run ui
```

Open the URL printed by the server, usually `http://127.0.0.1:3000`.

Pick models from the [model presets guide](docs/MODEL-PRESETS.md) when you want a beginner-friendly starting point for coding, vision, helpers, and summarization.

Run validation:

```powershell
npm run typecheck
npm test -- --runInBand
```

Run the UI smoke check after the UI server is running:

```powershell
npm run smoke:ui -- http://127.0.0.1:3000/
```

## Media Tools

Harness can route image and audio attachments through local tools when the selected model asks for them.

### Image Analysis

The `image_analyze` tool reads a local image and sends the image bytes to an Ollama vision-capable model. You can configure the default vision model in the browser Settings panel or with an environment variable:

```powershell
$env:HARNESS_VISION_MODEL = 'llava'
npm run ui
```

You can also leave this blank. When a user attaches an image, the chat prompt includes the selected model name so the model can call `image_analyze` with that model if it supports vision.

### Audio Transcription

The `audio_transcribe` tool runs a local transcription command. Configure it in the browser Settings panel or with `HARNESS_AUDIO_TRANSCRIBE_COMMAND`. Use `{input}` where Harness should place the uploaded audio file path.

Example with a local Whisper command:

```powershell
$env:HARNESS_AUDIO_TRANSCRIBE_COMMAND = 'whisper "{input}" --model base --output_format txt --output_dir -'
npm run ui
```

If no transcription command is configured, the tool returns a clear setup message instead of pretending the model can hear the file.

The First-run setup panel and `harness doctor` can also run an optional audio sample through the configured command so you can verify transcription end to end.

## Browser Settings

The Settings panel lets you configure:

* Ollama host
* Generation parameters
* Context continuity and detected context length
* Helper model routing
* Media tool defaults for vision and audio
* Installed version and release provenance
* Trace and eval utilities
* Runtime storage cleanup
* Safety mode

Settings are saved to `.harness/settings.json` and applied by the running server.

The welcome screen includes a guided checklist for first-run setup, validation profile creation, validation trend export, and installed-version verification. Completed checklist steps are saved to `.harness/settings.json` so a new user can return later and see what is already done.

## Output Validation

Output validation is an optional final-answer check. When enabled, Harness adds the selected validation contract to the system prompt, checks the final answer with deterministic structural rules, streams the validation result, and records the result in eval run history. The browser UI can automatically select the most fitting built-in contract for each prompt, while still showing the selected profile so beginners can override it.

Built-in profiles:

* `oracle-prime` - requires an explicit Oracle Prime reasoning contract shape.
* `factual-answer` - checks that factual answers include confidence and source language.
* `coding-answer` - checks that coding answers summarize changes and validation.
* `tool-result-summary` - checks that tool outputs include outcome, evidence, and next steps.

In the browser UI, open Settings, choose a profile under Output Validation, and enable **Validate final answers**. Leave **Auto-select best contract** on to let Harness choose factual, coding, tool-result, or Oracle Prime validation from the prompt. The chat activity stream shows which profile was auto-selected and why. Turn auto-select off when you want the selected profile to be the manual override.

Use **Install templates** to add ready-made custom profiles such as beginner factual summaries, code summaries, release readiness, and decision briefs without hand-writing JSON. Each template includes a small good and bad example so new users can see what the validator expects. Use **Preview validator** to paste a draft answer and see the selected profile's score, findings, missing sections, and plain-English suggestions before using it in chat. The Learning tab shows output-validation trend summaries by profile, status, and selection source so you can compare auto-selected and manually selected contracts.

From the CLI, pass a built-in profile with `--validate-output`:

```powershell
npm run harness -- --validate-output coding-answer -p "Summarize the latest code changes"
```

Custom deterministic profiles can be authored from the Settings panel or by editing `.harness/output-validation-profiles.json`:

```json
{
  "profiles": [
    {
      "profile": "brief-summary",
      "label": "Brief Summary",
      "description": "Requires a concise outcome summary.",
      "instructions": "Mention the outcome and evidence in a concise answer.",
      "checks": [
        {
          "code": "has-outcome",
          "severity": "fail",
          "message": "Mention whether the work passed or failed.",
          "requiresAny": ["passed", "failed"]
        },
        {
          "code": "too-long",
          "severity": "warn",
          "message": "Keep the summary concise.",
          "maxLength": 500
        }
      ]
    }
  ]
}
```

Custom checks support `requiresAny`, `requiresAll`, `forbidsAny`, `minLength`, and `maxLength`. These checks are structural. They can catch missing answer parts, but they do not prove that a factual claim is true.

Package consumers can import validation helpers directly:

```typescript
import { OUTPUT_VALIDATION_PROFILE_TEMPLATES, suggestOutputValidationProfile, validateOutput } from 'ollama-agent-harness';
```

The Settings panel includes a guided profile form for custom validation profiles. Fill in the profile fields, add one or more checks, and choose **Save form profile**. Harness writes the JSON for you and saves it to `.harness/output-validation-profiles.json`. The advanced JSON editor remains available for manual edits.

Use **Download presets** to export custom validation profiles as a shareable JSON file. Use **Import presets** to load a shared profile file back into the guided editor and save it through the same validation API.

The editor validates profile JSON before saving and the API returns field-level schema errors for invalid profiles. Custom checks also support deterministic score tuning:

* `scorePenalty` on a check sets the score reduction when that check fails. Use a value from `0` to `1`.
* `warnBelowScore` on a profile changes a passing result to `warn` when the final score drops below the threshold.
* `failBelowScore` on a profile changes a non-failing result to `fail` when the final score drops below the threshold.

The release workflow verifies the release archive and companion manifest before publishing, then downloads the published release zip and manifest after upload and runs the same archive smoke test against those published assets.

The Learning tab can download output-validation trend data as JSON. The export includes the validation profile, status, pass/fail outcome, and whether the profile was auto-selected or manually selected. Release notes include commit and asset provenance, including the release zip SHA-256 digest when an asset is available during note generation.

The Settings About panel shows the running package version, commit when available, release link, asset name, companion manifest link, and release digest when the installed package includes it. Release archives include `release-provenance.json` so downloaded builds can identify where they came from. GitHub releases also publish a companion `*.zip.sha256.json` manifest with the final release archive digest, because that final digest cannot be embedded inside the same zip without changing it. Use **Verify release asset** to compare a local release archive SHA-256 when the archive and expected digest are available, or to get a clear pointer to the GitHub release digest when local comparison is not possible.

## GitHub Baseline

This workspace is pushed to a private GitHub repository:

<https://github.com/Bradliebs/ollama-agent-harness>

The current release is available from [GitHub Releases](https://github.com/Bradliebs/ollama-agent-harness/releases/latest). The first pushed baseline is commit `428e5da`, and release tags are created from validated commits.
