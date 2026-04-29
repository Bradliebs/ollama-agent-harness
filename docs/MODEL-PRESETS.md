---
title: Model Presets
description: Beginner-friendly Ollama model choices for coding, vision, helper routing, and summarization in Harness
author: Bradliebs
ms.date: 2026-04-29
ms.topic: guide
keywords:
  - ollama
  - models
  - presets
  - local ai
estimated_reading_time: 4
---

## Choose A Starting Model

Harness can work with any Ollama chat model that supports tool calling well enough for your task. Start with one main coding model, then add optional helper models when you want faster routing or summarization.

These presets are examples. Use the closest installed model when your machine cannot run the exact name.

## Balanced Local Coding

Use this when you want a sensible default for code edits, file search, and local project tasks.

```powershell
ollama pull qwen2.5-coder:7b
```

Set the main model to `qwen2.5-coder:7b` in the browser model picker or run the CLI with:

```powershell
harness --model qwen2.5-coder:7b
```

## Smaller Helper Model

Use a smaller helper for bounded read-only work, routing, or quick summaries when the main model feels slow.

```powershell
ollama pull qwen2.5-coder:3b
```

In Settings, set the small helper model to `qwen2.5-coder:3b`. In the CLI:

```powershell
harness --small-helper-model qwen2.5-coder:3b
```

## Larger Coding Model

Use a larger model for harder refactors, bigger planning tasks, or code review when your hardware has enough memory.

```powershell
ollama pull qwen2.5-coder:14b
```

Set the strong helper model to `qwen2.5-coder:14b` or use it as the main model.

## Vision Model

Use a vision-capable model when you want Harness to inspect attached screenshots or images through the `image_analyze` tool.

```powershell
ollama pull llava:latest
```

Set the vision model to `llava` in First-run setup or Settings. You can check it from the terminal:

```powershell
harness doctor --vision-model llava
```

## Summarizer Model

Use a smaller summarizer model when long sessions need context compaction. Pick a model that responds quickly on your machine.

```powershell
ollama pull qwen2.5:3b
```

Then set the summarizer model in Settings or start the CLI with:

```powershell
harness --summarizer-model qwen2.5:3b
```

## Audio Transcription

Most chat models do not directly hear audio through the chat API. Harness expects a local transcription command and passes the uploaded audio path into `{input}`.

Example with Whisper:

```powershell
$env:HARNESS_AUDIO_TRANSCRIBE_COMMAND = 'whisper "{input}" --model base --output_format txt --output_dir -'
harness doctor --audio-command $env:HARNESS_AUDIO_TRANSCRIBE_COMMAND --audio-sample .harness/uploads/sample.wav
```

The First-run setup panel has the same check. Leave the audio test file blank when you only want to confirm that a command is configured.

## Quick Preset Table

| Goal | Suggested setting |
|------|-------------------|
| Main coding model | `qwen2.5-coder:7b` |
| Small helper | `qwen2.5-coder:3b` |
| Strong helper | `qwen2.5-coder:14b` |
| Vision helper | `llava` |
| Summarizer | `qwen2.5:3b` |

Run `harness doctor` after changing model or media settings to confirm that Ollama and optional helpers are ready.
