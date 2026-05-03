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

## Remote Provider Fallback

Remote backends can be selected with `--backend` or by choosing a backend-prefixed model in the UI, such as `groq/llama-3.1-8b-instant`. Harness cycles to the next configured remote backend when a provider returns a limit-style failure such as HTTP 429, HTTP 413, quota exceeded, tokens-per-minute exceeded, or context-length exceeded.

Provider fallback is enabled by default. Set this to disable it for a run:

```powershell
$env:HARNESS_REMOTE_AUTO_FALLBACK = '0'
```

Set this to control fallback order:

```powershell
$env:HARNESS_REMOTE_FALLBACK_ORDER = 'groq,mistral,github,openrouter,gemini,together,sambanova,fireworks,cloudflare,replicate,openai'
```

Each provider still rotates comma-separated keys for that provider first. For example, `GROQ_API_KEY=key1,key2` tries the Groq key pool before moving to another provider.

After a provider hits a limit error, it enters a 30-second cooldown and is temporarily skipped on subsequent calls. The primary backend is always attempted regardless of cooldown. Override the cooldown window:

```powershell
$env:HARNESS_REMOTE_FALLBACK_COOLDOWN_MS = '60000'
```

Tool-capable providers are preferred during agent loops. Chat-only providers such as Cerebras, Cloudflare Workers AI, DeepInfra, Hugging Face, and Replicate are skipped as fallbacks when a turn includes tool schemas, but they can still be used for compact no-tool smoke checks.

The web chat shows a provider fallback row when a configured provider hits a rate, quota, request-size, or context limit and Harness moves to the next configured backend.

## Replicate Predictions

Replicate uses its Predictions API rather than OpenAI Chat Completions. Select it with `--backend replicate --model meta/meta-llama-3-8b-instruct` or choose a `replicate/...` model in the UI after setting `REPLICATE_API_TOKEN`.

Harness sends chat history as a single `prompt` input with `Prefer: wait=60`. This is intentionally chat-only: Replicate is excluded from tool-calling agent fallbacks because model input schemas vary by model.

## Competitive Notes

LiteLLM's router goes deeper on production routing with per-deployment cooldowns, request/token-rate metadata, weighted picks, Redis-backed state, and callback hooks. OpenRouter exposes provider ordering, price/latency/throughput sorting, capability filters for tool support and parameters, and policy controls such as data collection and zero-data-retention routing.

Harness now covers the critical local-first need: explicit fallback order, limit-only cycling, tool-capability filtering, cooldown memory, and UI visibility. Further hardening could add per-provider request-rate tracking and weighted selection.

## Remote Smoke Checks

Free-tier providers often fail when the full agent prompt, tool schemas, and workspace context are sent as a smoke test. Use the remote smoke script after building to send a tiny no-tools prompt:

```powershell
npm run build
npm run smoke:remote-backends
```

The script skips providers without configured keys. Cloudflare Workers AI requires both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` because its OpenAI-compatible endpoint is account-scoped.

## Advisory Strategy

`npm audit` may report the ExcelJS `uuid` advisory and suggest downgrading ExcelJS to 3.x. Do not apply that automatic fix. Harness keeps ExcelJS 4.x and tracks the advisory until an upstream fix preserves workbook export behavior without a semver-major downgrade.
