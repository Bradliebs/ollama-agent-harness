---
title: Model Presets
description: Beginner-friendly Ollama model choices for coding, vision, helper routing, and summarization in Harness
author: Bradliebs
ms.date: 2026-05-06
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

Most chat models do not directly hear audio through the chat API. Harness passes the uploaded audio path into `{input}` of a local transcription command.

Zero-config: if [OpenAI Whisper](https://github.com/openai/whisper) is installed (`pip install -U openai-whisper`), Harness auto-detects the `whisper` executable on your `PATH` and uses it automatically — no environment variable required.

To override the default with an explicit command:

```powershell
$env:HARNESS_AUDIO_TRANSCRIBE_COMMAND = 'whisper "{input}" --model base --output_format txt --output_dir .'
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

## Adding An Ollama Cloud Model

Harness discovers Ollama Cloud models through your local Ollama runtime. Pull
the model first, then confirm that Ollama lists it:

```powershell
ollama pull <model>:cloud
ollama list
```

After the model appears in `ollama list`, select it in the Harness model picker
or pass it to the CLI:

```powershell
harness --model <model>:cloud
```

For tool-routing confidence, run the routing validator after building:

```powershell
npm run build
npm run validate:routing
```

The validator treats first-turn native tool calls as the pass condition. Some
cloud models rephrase the final tool result, so exact final text matching is
reported separately from routing success.

## Auto-Routing Targets For Weak Local Models

When `gemma4:e4b` or `gemma4:26b` is the active model and a turn needs tools or
current information, Harness auto-routes to the first available stronger model
from this list. Pull any of them locally with `ollama pull <model>` to make
them eligible:

| Cloud model | Notes |
|-------------|-------|
| `gpt-oss:20b-cloud` | Default routing target; reliable tool calls |
| `gpt-oss:120b-cloud` | Stronger fallback when 20B is unavailable |
| `qwen3-coder:480b-cloud` | Code-heavy tasks |
| `deepseek-v3.1:671b-cloud` | Long-context reasoning |
| `glm-5.1:cloud` | GLM 4/5 family; strong tool-calling, lighter footprint |
| `kimi-k2.5:cloud` | Subscription gated; same lineage available free on Groq as `kimi-k2-instruct` |

Local strong-tool alternatives (no `:cloud` suffix) such as `qwen2.5-coder:14b`
also qualify and are preferred when present.

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
