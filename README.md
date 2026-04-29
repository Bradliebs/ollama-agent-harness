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
* Trace and eval utilities
* Runtime storage cleanup
* Safety mode

Settings are saved to `.harness/settings.json` and applied by the running server.

## Output Validation

Output validation is an optional final-answer check. When enabled, Harness adds the selected validation contract to the system prompt, checks the final answer with deterministic structural rules, streams the validation result, and records the result in eval run history.

Built-in profiles:

* `oracle-prime` - requires an explicit Oracle Prime reasoning contract shape.
* `factual-answer` - checks that factual answers include confidence and source language.
* `coding-answer` - checks that coding answers summarize changes and validation.
* `tool-result-summary` - checks that tool outputs include outcome, evidence, and next steps.

In the browser UI, open Settings, choose a profile under Output Validation, and enable **Validate final answers**. The Learning tab shows output-validation trend summaries by profile and status.

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

## GitHub Baseline

This workspace is pushed to a private GitHub repository:

<https://github.com/Bradliebs/ollama-agent-harness>

The current release is available from [GitHub Releases](https://github.com/Bradliebs/ollama-agent-harness/releases/latest). The first pushed baseline is commit `428e5da`, and release tags are created from validated commits.
