---
title: System Overview
description: End-to-end overview of the Ollama Agent Harness — what it is, how it runs, and what has been built
author: Bradliebs
ms.date: 2026-05-31
ms.topic: overview
keywords:
  - ollama
  - agent
  - local-first
  - overview
estimated_reading_time: 8
---

# Ollama Agent Harness — End-to-End Overview

## What it is

A **local-first agentic runtime** (TypeScript / Node.js, currently **v0.6.4**) that wraps Ollama models with a browser UI, tool dispatch, permissions, persistence, and self-improvement infrastructure. Everything runs on your machine — no cloud accounts, no API keys beyond Ollama itself. You chat with a model; it can call tools (read/write files, run bash, search the web, analyze images, transcribe audio, generate documents, send emails), and the harness manages permissions, context, and history around that loop.

The architecture deliberately borrows patterns from the Claude Code paper (*"Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems"*), which is the design north star recorded in [FORGE.md](../FORGE.md).

## Guiding design constraints

These show up everywhere in the code:

- **Local-first** — every storage path lives under `.harness/` in the working directory. No server-side cloud database.
- **Model-agnostic** — Ollama is the default, but a chat-client factory abstracts Cerebras, Groq, GitHub Models, OpenAI, Mistral, OpenRouter, Replicate, and Cloudflare. No code path assumes a specific vendor.
- **Env-gated additions** — new behaviour defaults OFF behind `HARNESS_*_ENABLED` flags, so existing installs keep working.
- **Test-as-spec** — the test suite (1477+ tests across 132 suites) is the ground truth; when docs and tests disagree, the test wins.
- **Minimal scaffolding / deny-first safety / append-only state** — a simple while-loop agent core, deny rules override allow rules, and JSONL transcripts that compact by appending rather than deleting.

## How it runs

```mermaid
flowchart LR
    A[Install Node + Ollama] -->|pull a model| B[Start harness<br/>start.bat / npm run ui]
    B -->|opens browser| C[Chat UI<br/>127.0.0.1:4300]
    C -->|message| D[Local model responds]
    D -->|needs a tool?| E[Tools: read/write/search/run]
    E -->|result| D
    D -->|learns| F[Memory: skills, patterns, history]
    F -.->|next session| C
```

Three user surfaces: the **web chat UI**, a **terminal client (TUI)**, and a **CLI** (`harness ...`).

## Subsystems (`src/`)

| Area | Responsibility |
|---|---|
| **core/** | The heart: `queryLoop` drives the LLM→tool→LLM cycle; chat-client factory + backend adapters; auto-fallback on rate-limit/5xx; output validation; structured-output JSON-schema enforcement; tracing; rate limiting. |
| **agents/** | Sub-agent orchestration with isolated context windows and summary-only returns; custom agent loader (`.harness/agents/*.md`); small/default/strong helper-model routing. |
| **tools/** | 30+ built-in tools — filesystem, web read/search, image analyze, PDF read, audio transcribe, docker exec, task/agent/squad tools, memory tools. Path resolution corrals bare-filename writes into `agent-outputs/`. |
| **permissions/** | Three-layer security: declarative engine allowlist per mode, opt-in capability registry (with kill-switch + audit), and a JSONL audit log that injects failure signals into the prompt. |
| **persistence/** | Sessions, an append-only event store, a promise ledger (tracked obligations), and cross-session continuity. |
| **services/** | The largest subsystem (~22 modules): self-learning heartbeat, trigger scheduler, concierge intent router, multi-agent squads, identity (SOUL/USER), semantic memory intelligence, per-model profiles, capability registry, artifact catalog. |
| **web/** | A single large Express app — REST + SSE streaming chat + WebSocket fanout, serving the static SPA from `ui/`. |
| **mycelium/** | A long-term, reward-weighted routing graph that classifies intent and routes through safety/agent/verifier/workflow nodes, updating edge weights with reward. |
| **learning/ + eval/** | Extracts skill candidates from finished sessions, gates them through a multiplicative safety promotion gate, and runs adversarial probes (prompt-injection, secret-exfil, tool-misuse, safety-refusal) via a simulator. |
| **observability/** | Prometheus `/metrics`, OpenInference/OTLP span export. |
| **setup/** | `doctor` health probes and `doctor --fix` auto-remediation. |
| **integrations/** | Self-contained adapters for Discord, Slack, Telegram, Teams, GitHub PR — none required for the core loop. |
| **nervous/, curator/, jarvis/, automation/, goal/** | Reflex heuristics, memory curation, voice (Jarvis/Whisper), background scheduling, and the `/goal` natural-language expander. |

## State on disk (`.harness/`)

Sessions, secrets (gitignored connector tokens + API keys), uploads, agent-outputs, custom agents, squads, identity, capabilities, promises, tasks, triggers, the audit log, the event store, heartbeat/concierge logs (auto-pruned), the mycelium graph, eval traces, and per-model profiles.

## Build trajectory

The CHANGELOG traces an active path from v0.4.x → v0.6.4:

- **v0.4.0–0.4.2** — observability (Prometheus + OTLP), per-model profiles, doctor auto-fix, attachment context injection so the model rarely needs a `file_read` round-trip.
- **v0.6.0–0.6.4** — the **Apex** family of autonomous end-to-end experiences (the `/goal` expander, PDF→wiki blueprint, Kanban→autonomy bridge, competitor-research renderer, personal memory wiki, daily morning-priority prompt). Apex was renamed from "Hermes" to avoid trademark concerns — strings only, no behavioural change.
- **v0.6.4 specifically** — **ccmem semantic memory**: a bundled FastAPI sidecar (`ccmem/service.py`) on port 8765 implementing the Tyukin & Gorban concept-cell scheme. Every `remember` call now dual-writes to a semantic memory bank and recalls related memories by *meaning* rather than keyword. It is best-effort — if the service is down, the harness behaves identically. Plus startup hardening (BOM-corrupted path fix, better `npm install` errors) and operate-mode routing fixes.

## Supporting infrastructure

Beyond the runtime, the repo carries a mature release/ops apparatus: a large `scripts/` directory of smoke tests (UI, transport, mycelium, telegram, voice, installer, release) and release tooling (provenance generation, version bumping, changelog verification, release-readiness checks); a Windows NSIS installer; a `cookbook/` of reference recipes; `docs/` operator references; and `.github/skills/` encoding the project's own conventions (harness-conventions, code-review, testing, plan-executor).

## In one sentence

It is a **fully local, model-agnostic AI agent platform** — chat UI + tools + permissions + persistent memory + self-learning + observability — engineered around Claude-Code-paper patterns, that has matured from a tool-using chat loop into an autonomous-experience platform with semantic memory, all running on your own hardware.

## Related references

- [README.md](../README.md) — quick start and feature tour
- [START-HERE.md](../START-HERE.md) — complete beginner guide
- [FORGE.md](../FORGE.md) — architecture patterns and configuration
- [docs/SYSTEM-BREAKDOWN.md](SYSTEM-BREAKDOWN.md) — exhaustive single-page system reference
- [CHANGELOG.md](../CHANGELOG.md) — full release history
