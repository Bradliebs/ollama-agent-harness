---
title: Quick Reference
description: Subsystem-to-code-path index and numbered load-bearing rules for the Ollama Agent Harness
author: Bradliebs
ms.date: 2026-10-08
ms.topic: reference
keywords:
  - quick-reference
  - architecture
  - conventions
  - invariants
estimated_reading_time: 6
---

A fast map from subsystem to code path, plus the load-bearing rules that must
not be broken when changing the harness. This is the navigation companion to the
deeper [System breakdown](SYSTEM-BREAKDOWN.md) and [System overview](SYSTEM-OVERVIEW.md).

Current setup, lifecycle, benchmark evidence and release gaps are tracked in
[Modernization Status](MODERNIZATION-STATUS.md). Runtime minimum: Node 22.13.0;
Node 24 LTS recommended. Cloud inference is explicit and can incur charges.

## Subsystem index

Each row points to the directory that owns a concern and the doc that explains it
in depth (where one exists).

| Subsystem | Code path | What it owns | Deep-dive doc |
|-----------|-----------|--------------|---------------|
| Agent loop and backends | [src/core](../src/core) | `IChatClient`, the chat-client factory and its OpenAI-compatible presets, the `local` server backend, fallback client, the while-loop core, run supervisor, scaffolding, deferred tool loading | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Multi-agent delegation | [src/agents](../src/agents) | Subagents, the orchestrator, weak-model routing and in-run escalation | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Context assembly | [src/context](../src/context) | System-context assembly, compaction, history window, working state | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Permissions | [src/permissions](../src/permissions) | Permission engine, prompt broker, kill switch, advisory command classifier | [Capability sandbox](CAPABILITY-SANDBOX.md) |
| Safety | [src/safety](../src/safety) | Injection defence, untrusted-content envelope, secret redactor, provenance checks, tool inspectors | [Capability sandbox](CAPABILITY-SANDBOX.md) |
| Tools | [src/tools](../src/tools) | The ~70 runtime tools: files, shell, web, browser, documents, media, memory, skills, tasks, agents | [System breakdown](SYSTEM-BREAKDOWN.md#33-tools-srctools) |
| Skills and extensibility | [src/extensibility](../src/extensibility) | Skill loader, tiered merge, usage tracking, probation, MCP bridge | [Skills](SKILLS.md) |
| Skill curation | [src/curator](../src/curator) | Archiving and consolidating skills | [Skills](SKILLS.md) |
| Web server and UI | [src/web](../src/web) | HTTP API (`server.ts` plus `*Routes.ts` routers), SSE chat stream, WebSocket, static UI host | [System overview](SYSTEM-OVERVIEW.md) |
| Models | [src/models](../src/models) | Model catalog, capability probes and profiles, per-model request adapter, role routing | [Model presets](MODEL-PRESETS.md) |
| Model presets | [src/core/chatClientFactory.ts](../src/core/chatClientFactory.ts), [src/agents/modelRouting.ts](../src/agents/modelRouting.ts) | Backend presets and weak-model rerouting targets | [Model presets](MODEL-PRESETS.md) |
| Comparison reports | [src/presets](../src/presets), [src/reports](../src/reports) | Product-comparison category schemas and report rendering | [System breakdown](SYSTEM-BREAKDOWN.md#36d-safety--reports--presets) |
| Mycelium router | [src/mycelium](../src/mycelium) | Adaptive context routing | [Mycelium router](MYCELIUM-ROUTER.md) |
| Observability | [src/observability](../src/observability) | Cost and run provenance, offline guarantee, Prometheus, OpenInference, OTLP export | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Automation | [src/automation](../src/automation) | Scheduled automation jobs and grants | [Operating services](OPERATING-SERVICES.md) |
| Operating services | [src/services](../src/services) | Long-running service lifecycle, heartbeat, triggers, squads, identity, promise ledger | [Operating services](OPERATING-SERVICES.md) |
| Budget | [src/budget](../src/budget) | Daily spend cap for remote backends | [System breakdown](SYSTEM-BREAKDOWN.md#5-environment-flags) |
| Goal mode | [src/goal](../src/goal) | Goal-directed query loop and judge | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Governed runtime | [src/governed](../src/governed) | Shadow-first governance pass, working memory, replay ledger, human-gated review queue | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Verification | [src/verification](../src/verification) | Research-claim checks, critic models, verification panel | [System breakdown](SYSTEM-BREAKDOWN.md#36g-verification-srcverification) |
| Learning | [src/learning](../src/learning) | Reflections, run lessons, candidate promotion gate | [System breakdown](SYSTEM-BREAKDOWN.md#312-learning-srclearning) |
| Evaluation | [src/eval](../src/eval) | Probes, simulator, run replay, history benchmarks, cost tracking | [Validation profiles](VALIDATION-PROFILES.md) |
| AutoResearch experiments | [src/experiments](../src/experiments) | Paired baseline-vs-candidate benchmark experiments and promotion evidence | [AutoResearch experiments](AUTORESEARCH-EXPERIMENTS.md) |
| Jarvis layer | [src/jarvis](../src/jarvis) | Voice and knowledge-graph recall | [Apex features](APEX-FEATURES.md) |
| Nervous system | [src/nervous](../src/nervous) | Sensory signals, reflexes, pain/recovery, attention | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Integrations | [src/integrations](../src/integrations) | Discord, Slack, Telegram, WhatsApp, outbound webhooks | [System breakdown](SYSTEM-BREAKDOWN.md#314-integrations-srcintegrations) |
| Persistence | [src/persistence](../src/persistence) | Sessions, event store, run logs, side-effect ledger, git checkpoints, snapshots | [System overview](SYSTEM-OVERVIEW.md) |
| Prompts and workflows | [src/prompts](../src/prompts), [src/workflows](../src/workflows) | Prompt template engine and workflow registry | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Shared types | [src/types](../src/types) | Loop, tool, session, permission and evidence types | [System breakdown](SYSTEM-BREAKDOWN.md) |
| CLI | [src/cli](../src/cli) | Command-line entry, command registry, system-prompt build | [Getting started](GETTING-STARTED.md) |
| Setup and doctor | [src/setup](../src/setup) | `harness doctor`, `--fix`, health and tool-call probes | [System breakdown](SYSTEM-BREAKDOWN.md#38-setup--doctor-srcsetup) |
| Terminal UI | [src/tui](../src/tui) | `harness tui` client over the daemon | [System breakdown](SYSTEM-BREAKDOWN.md#313-tui-srctui) |
| Background ownership | [scripts/background-server.js](../scripts/background-server.js) | Owned child lifecycle and installation maintenance lease | [Modernization Status](MODERNIZATION-STATUS.md#background-lifecycle) |
| Workflow outcomes | [scripts/local-core-baseline.js](../scripts/local-core-baseline.js) | Bounded local/cloud execution, artifact grading and raw request evidence | [Validation profiles](VALIDATION-PROFILES.md#workflow-outcome-benchmarks) |

## Load-bearing rules

These are the non-obvious invariants. Breaking one tends to break a safety or
portability guarantee elsewhere, so confirm each still holds after a change.

1. **Wrap untrusted content before it reaches a prompt.** Any text from outside
   the user and system prompt (web pages, PDFs, inbound messages, webhooks) is
   wrapped with `wrapUntrusted` from [src/safety/untrustedWrap.ts](../src/safety/untrustedWrap.ts).
   Tools that fetch external data wrap their output; the system prompt tells the
   model that `<external_content>` is data, never instructions.
2. **Never let raw secrets enter traces or run logs.** Spans, events, error
   messages and every `.harness/runs/*.jsonl` line run through `redact` /
   `redactSecrets` from [src/safety/secretRedactor.ts](../src/safety/secretRedactor.ts),
   wired in [src/core/tracing.ts](../src/core/tracing.ts) and
   [src/persistence/runLog.ts](../src/persistence/runLog.ts). Add new secret
   shapes to the redactor, ordered specific-before-generic.
3. **The command classifier is advisory only.** [src/permissions/commandClassifier.ts](../src/permissions/commandClassifier.ts)
   explains shell commands and suggests patterns; it never grants or denies.
   Permission decisions stay with deny-first rules plus the user.
4. **Skill tiers resolve low-to-high precedence.** Merge order is global
   (`~/.harness/skills`) < repo (`.github/skills`) < workspace (`.harness/skills`).
   A workspace skill shadows a same-named global one. See
   [src/extensibility/skillLoader.ts](../src/extensibility/skillLoader.ts).
5. **Every chat backend implements `IChatClient` and passes conformance.** New
   backends must satisfy `runChatClientConformance` from
   [src/core/chatClientConformance.ts](../src/core/chatClientConformance.ts). No
   core path may assume a specific vendor.
6. **Local-first storage.** Resolve the project directory before locating workspace
   state; `HARNESS_PROJECT_DIR` can separate it from the installation. Background
   ownership and maintenance markers are installation-local.
7. **Explicit opt-ins; safeguards on by default.** Answer-changing features
   (working state, lessons recall, deferred tool loading, cache prompt layout,
   scaffolding, experimental autonomy) stay behind documented opt-in gates.
   The safeguards are on unless turned off: run log, run supervisor, loop
   hardening, provenance checks, lesson recording, research-answer checks and
   protected paths (`.harness/protected-paths.json`). Runtime fixes and
   minimum-version requirements are not all feature-flagged; consult the
   changelog before upgrading. Flags are listed in
   [System breakdown §5](SYSTEM-BREAKDOWN.md#5-environment-flags).
8. **Deny-first safety, append-only state.** Deny rules override allow rules, and
   transcripts compact by appending rather than deleting.
9. **Test-as-spec.** When docs and tests disagree, the test wins. Add or update a
   test alongside any behavioural change.

## Where to start for a change

- Adding a tool: implement under [src/tools](../src/tools), register it, and wrap
  any external output (rule 1).
- Adding a backend: implement `IChatClient`, then add a conformance test
  (rule 5).
- Adding a skill: drop a `SKILL.md` under one of the skill tiers (rule 4); see
  [Skills](SKILLS.md).
- Changing permissions or safety: read [Capability sandbox](CAPABILITY-SANDBOX.md)
  first and keep classifier output advisory (rule 3).
