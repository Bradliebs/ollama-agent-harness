---
title: System Overview
description: End-to-end overview of the Ollama Agent Harness — what it is, how it runs, and what has been built
author: Bradliebs
ms.date: 2026-10-08
ms.topic: overview
keywords:
  - ollama
  - agent
  - local-first
  - overview
estimated_reading_time: 8
---

## What it is

A **local-first agentic runtime** (TypeScript / Node.js, package version **v0.6.5**
with unreleased development changes) with a browser UI, tool dispatch,
permissions, persistence and self-improvement infrastructure. Local inference
needs no cloud account. Explicitly selected cloud models, remote Ollama hosts
and network tools transmit data outside the machine and may incur charges.
Tools run under the local user's permissions; cloud inference does not move
filesystem execution to the provider.

The current validation checkpoint is [Modernization Status](MODERNIZATION-STATUS.md).
It separates offline checks, live cloud workflow evidence and outstanding release gates.

The architecture deliberately borrows patterns from the Claude Code paper (*"Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems"*), which is the design north star recorded in [FORGE.md](../FORGE.md).

## Guiding design constraints

These show up everywhere in the code:

- **Local-first**: workspace state normally lives under the resolved project directory's `.harness/`; `HARNESS_PROJECT_DIR` can separate it from the installation. Background ownership and maintenance markers remain installation-local.
- **Shared client contract**: Ollama is the default; a chat-client factory also abstracts cloud backends. Provider adapters and model routing still have provider-specific behavior.
- **Explicit opt-ins, safeguards on by default**: answer-changing and experimental features keep documented default-off gates; the run log, run supervisor, loop hardening, provenance checks and research-answer checks are on unless turned off. Runtime fixes and minimum-version requirements are not universally feature-flagged.
- **Evidence-driven validation**: the 2026-10-08 full run passed 4,050 tests across 358 suites, with one skipped and exit code 0. Test expectations must also match stated task contracts; passing fixtures alone do not establish live-model reliability.
- **Minimal scaffolding / deny-first safety / append-only state** — a simple while-loop agent core, deny rules override allow rules, and JSONL transcripts that compact by appending rather than deleting.

## How it runs

```mermaid
flowchart LR
    A[Install Node + Ollama] -->|pull a model| B[Start harness<br/>start.bat / ./start.sh]
    B -->|opens browser| C[Chat UI<br/>127.0.0.1:4300]
    C -->|message| D[Selected local or cloud model responds]
    D -->|needs a tool?| E[Tools: read/write/search/run]
    E -->|result| D
    D -->|learns| F[Memory: skills, patterns, history]
    F -.->|next session| C
```

Three user surfaces: the **web chat UI**, a **terminal client (TUI)**, and a **CLI** (`harness ...`).

## Subsystems (`src/`)

| Area | Responsibility |
|---|---|
| **core/** | The heart: `queryLoop` drives the LLM→tool→LLM cycle; chat-client factory + backend adapters; auto-fallback on rate-limit/5xx; run supervisor and token budget; per-model scaffolding; opt-in deferred tool loading; output validation; structured-output JSON-schema enforcement; tracing; rate limiting. |
| **context/** | System-prompt assembly, history window and compaction (cap tool results → shorten old tool-call arguments → snip at 70% → summarize at 85%, keeping the previous summary), and the typed working state. |
| **agents/** | Sub-agent orchestration with isolated context windows and summary-only returns; custom agent loader (`.harness/agents/*.md`); small/default/strong helper-model routing, weak-model rerouting and in-run escalation. |
| **models/** | Model catalog, capability probes and profiles (`harness probe`), per-model request adapter, role routing. |
| **tools/** | About 70 runtime tools — files, shell, grep, web read/search, browser, image analyze, PDF, audio, docker exec, email/calendar, task/agent/squad tools, memory and skill tools. Path resolution corrals bare-filename writes into `agent-outputs/`. |
| **permissions/ + safety/** | Declarative engine allowlist per mode, opt-in capability grants (with kill-switch + audit), a JSONL audit log that injects failure signals into the prompt, untrusted-content wrapping, secret redaction, provenance checks on side effects and protected paths. |
| **persistence/** | Sessions, an append-only event store, cross-session continuity, run logs (every run, secrets redacted), the side-effect ledger with per-step undo, optional git checkpoints, and snapshots. |
| **services/** | The largest subsystem (48 modules): self-learning heartbeat, trigger scheduler, concierge intent router, multi-agent squads, identity (SOUL/USER), semantic memory intelligence, per-model profiles, capability registry, promise ledger (tracked obligations), artifact catalog. |
| **web/** | Express app (`server.ts` plus `*Routes.ts` router modules), REST and SSE streaming chat, and WebSocket fanout, serving the static SPA from `ui/`. |
| **mycelium/** | A long-term, reward-weighted routing graph that classifies intent and routes through safety/agent/verifier/workflow nodes, updating edge weights with reward. |
| **learning/ + verification/ + eval/** | Records lessons from every run, extracts skill candidates and gates them through a multiplicative safety promotion gate; checks research answers against the pages read (with optional critic models); runs adversarial probes via a simulator, replays recorded runs against other models, and benchmarks recent history. |
| **observability/** | Prometheus `/metrics`, OpenInference/OTLP span export, cost and run provenance. |
| **setup/** | `doctor` health probes and `doctor --fix` auto-remediation. |
| **integrations/** | Self-contained adapters for Discord, Slack, Telegram, WhatsApp and outbound webhooks — none required for the core loop. |
| **budget/, governed/** | Daily spend cap for remote backends; shadow-first governance pass and human-gated review queue. |
| **nervous/, curator/, jarvis/, automation/, goal/** | Reflex heuristics, skill curation, voice (Jarvis/Whisper), background scheduling, and the `/goal` natural-language expander. |

## State on disk (`.harness/`)

Sessions (append-only `*.jsonl`), run logs (`runs/`), the side-effect ledger, settings and API/connector keys (`api-keys.json`, owner-only), uploads, custom agents, skills (with usage, probation and `_history`), lessons, squads, identity, capability audit, promises, tasks, triggers, the audit log, the event store, heartbeat/concierge logs (auto-pruned), the mycelium graph, eval traces, per-model profiles and capability profiles, and the daily spend ledger. Bare-filename writes go to `agent-outputs/` at the project root. The full layout is in [System breakdown §4](SYSTEM-BREAKDOWN.md#4-storage-layout-harness).

## Build trajectory

The CHANGELOG traces an active path from v0.4.x → v0.6.6 and the unreleased work since:

- **v0.4.0–0.4.2** — observability (Prometheus + OTLP), per-model profiles, doctor auto-fix, attachment context injection so the model rarely needs a `file_read` round-trip.
- **v0.6.0–0.6.4** — the **Apex** family of autonomous end-to-end experiences (the `/goal` expander, PDF→wiki blueprint, Kanban→autonomy bridge, competitor-research renderer, personal memory wiki, daily morning-priority prompt). Apex was renamed from "Hermes" to avoid trademark concerns — strings only, no behavioural change.
- **v0.6.4 specifically** — **ccmem semantic memory**: a bundled FastAPI sidecar (`ccmem/service.py`) on port 8765 implementing the Tyukin & Gorban concept-cell scheme. Every `remember` call now dual-writes to a semantic memory bank and recalls related memories by *meaning* rather than keyword. It is best-effort — if the service is down, the harness behaves identically. Plus startup hardening (BOM-corrupted path fix, better `npm install` errors) and operate-mode routing fixes.
- **v0.6.5** — Build Mode, `/wiki` and `/memory-wiki`, the side-effect ledger and evidence-first research verification, autonomy launch fixes for isolated workspaces, `OLLAMA_HOST` support and tool-output compression.
- **v0.6.6 (planned release notes)** — the governed runtime: a shadow-first governance pass beside the product path, working memory, a human-gated review queue and replay candidates; default-off until a human approves.
- **Unreleased** — run logs with per-step undo and replay, the run supervisor, provenance checks, model capability probes with adjustable scaffolding, research-answer checks with critic models, run lessons, skill probation and history, and token-efficiency work (tool-schema budgeting, snip-aware history windows, compaction that keeps the previous summary, opt-in deferred tool loading and a cache-friendly prompt layout).

## Supporting infrastructure

Beyond the runtime, the repo carries a mature release/ops apparatus: a large `scripts/` directory of smoke tests (UI, transport, mycelium, telegram, voice, installer, release) and release tooling (provenance generation, version bumping, changelog verification, release-readiness checks); a Windows NSIS installer; a `cookbook/` of reference recipes; `docs/` operator references; and `.github/skills/` encoding the project's own conventions (harness-conventions, code-review, testing, plan-executor).

## In one sentence

It is a **fully local, model-agnostic AI agent platform** — chat UI + tools + permissions + persistent memory + self-learning + observability — engineered around Claude-Code-paper patterns, that has matured from a tool-using chat loop into an autonomous-experience platform with semantic memory, all running on your own hardware.

## Related references

- [README.md](../README.md) — quick start and feature tour
- [START-HERE.md](../START-HERE.md) — complete beginner guide
- [FORGE.md](../FORGE.md) — architecture patterns and configuration
- [docs/SYSTEM-BREAKDOWN.md](SYSTEM-BREAKDOWN.md) — single-page system reference (layout, storage, every env flag, CLI, runbook)
- [CHANGELOG.md](../CHANGELOG.md) — full release history
