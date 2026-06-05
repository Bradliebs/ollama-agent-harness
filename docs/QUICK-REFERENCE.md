---
title: Quick Reference
description: Subsystem-to-code-path index and numbered load-bearing rules for the Ollama Agent Harness
author: Bradliebs
ms.date: 2026-06-01
ms.topic: reference
keywords:
  - quick-reference
  - architecture
  - conventions
  - invariants
estimated_reading_time: 6
---

# Quick reference

A fast map from subsystem to code path, plus the load-bearing rules that must
not be broken when changing the harness. This is the navigation companion to the
deeper [System breakdown](SYSTEM-BREAKDOWN.md) and [System overview](SYSTEM-OVERVIEW.md).

## Subsystem index

Each row points to the directory that owns a concern and the doc that explains it
in depth (where one exists).

| Subsystem | Code path | What it owns | Deep-dive doc |
|-----------|-----------|--------------|---------------|
| Agent loop and backends | [src/core](../src/core) | `IChatClient`, the chat-client factory, fallback client, the while-loop core | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Multi-agent delegation | [src/agents](../src/agents) | Subagents and the orchestrator | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Context assembly | [src/context](../src/context) | System-context assembly and compaction | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Permissions | [src/permissions](../src/permissions) | Prompt broker, advisory command classifier | [Capability sandbox](CAPABILITY-SANDBOX.md) |
| Safety | [src/safety](../src/safety) | Injection defence, untrusted-content envelope, secret redactor | [Capability sandbox](CAPABILITY-SANDBOX.md) |
| Tools | [src/tools](../src/tools) | File, web, skill, and document tool implementations | [Skills](SKILLS.md) |
| Skills and extensibility | [src/extensibility](../src/extensibility) | Skill loader, tiered merge, usage tracking | [Skills](SKILLS.md) |
| Skill curation | [src/curator](../src/curator) | Archiving and consolidating skills | [Skills](SKILLS.md) |
| Web server and UI | [src/web](../src/web) | HTTP API, SSE chat stream, static UI host | [System overview](SYSTEM-OVERVIEW.md) |
| Model catalog | [src/models](../src/models) | Model registry and catalog cache | [Model presets](MODEL-PRESETS.md) |
| Model presets | [src/presets](../src/presets) | Curated model configurations | [Model presets](MODEL-PRESETS.md) |
| Mycelium router | [src/mycelium](../src/mycelium) | Adaptive context routing | [Mycelium router](MYCELIUM-ROUTER.md) |
| Observability | [src/observability](../src/observability) | Cost provenance, model locality | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Automation | [src/automation](../src/automation) | Scheduled automation jobs and grants | [Operating services](OPERATING-SERVICES.md) |
| Operating services | [src/services](../src/services) | Long-running service lifecycle | [Operating services](OPERATING-SERVICES.md) |
| Goal mode | [src/goal](../src/goal) | Goal-directed query loop and judge | [System breakdown](SYSTEM-BREAKDOWN.md) |
| Evaluation | [src/eval](../src/eval) | Output validation and eval runs | [Validation profiles](VALIDATION-PROFILES.md) |
| Jarvis layer | [src/jarvis](../src/jarvis) | Voice and knowledge-graph recall | [Apex features](APEX-FEATURES.md) |
| Persistence | [src/persistence](../src/persistence) | Chat history and append-only state | [System overview](SYSTEM-OVERVIEW.md) |
| CLI | [src/cli](../src/cli) | Command-line entry and system-prompt build | [Getting started](GETTING-STARTED.md) |

## Load-bearing rules

These are the non-obvious invariants. Breaking one tends to break a safety or
portability guarantee elsewhere, so confirm each still holds after a change.

1. **Wrap untrusted content before it reaches a prompt.** Any text from outside
   the user and system prompt (web pages, PDFs, inbound messages, webhooks) is
   wrapped with `wrapUntrusted` from [src/safety/untrustedWrap.ts](../src/safety/untrustedWrap.ts).
   Tools that fetch external data wrap their output; the system prompt tells the
   model that `<external_content>` is data, never instructions.
2. **Never let raw secrets enter traces.** Spans, events, and error messages run
   through `redact` / `redactSecrets` from [src/safety/secretRedactor.ts](../src/safety/secretRedactor.ts),
   wired in [src/core/tracing.ts](../src/core/tracing.ts). Add new secret shapes
   to the redactor, ordered specific-before-generic.
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
6. **Local-first storage.** Every persisted path lives under `.harness/` in the
   working directory. No server-side cloud database.
7. **Env-gated additions.** New behaviour defaults off behind `HARNESS_*_ENABLED`
   flags so existing installs keep working.
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
