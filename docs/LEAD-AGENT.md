---
title: Autonomous Lead Agent
description: A main agent that plans a task, spawns sub-agents to execute it in parallel, verifies, and re-plans until done — with no human interaction
author: Bradliebs
ms.date: 2026-07-07
ms.topic: concept
keywords:
  - autonomous
  - lead agent
  - sub-agents
  - orchestrator
  - verification
  - replanning
estimated_reading_time: 5
---

## Purpose

The **Lead Agent** is the harness's "main agent". You hand it one natural-language
task and it owns it end-to-end with no human in the loop:

1. **Plan** — decompose the task into a small graph of sub-agent *workstreams*
   (roles + dependencies).
2. **Dispatch** — run the workstreams in parallel via the existing
   [orchestrator](../src/agents/orchestrator.ts) (`orchestrate`), each executed by
   a real sub-agent.
3. **Verify** — check the merged result against the toolchain (tsc / lint / tests).
4. **Re-plan** — if verification fails, replan around the specific failures and
   try again, until the work passes or a budget is exhausted.

It is the piece that "makes sure things get done properly": the replan-on-failure
loop keeps driving to a verified done-state instead of stopping at the first
attempt.

## Architecture

The core is provider-free and lives in
[`src/core/leadAgent.ts`](../src/core/leadAgent.ts). `runLeadAgent()` takes
injectable seams so it can be unit-tested without a live model or a real
toolchain:

| Seam            | Responsibility                                                   |
| --------------- | ---------------------------------------------------------------- |
| `decompose`     | Produce / replan a workstream graph for the task.                |
| `orchestrate`   | Dispatch the graph (the parallel sub-agent orchestrator).        |
| `verifyOverall` | Judge whether the merged output satisfies the task.              |
| `persist`       | Optional artifact sink (`.harness/lead/<runId>/`).               |

The default factories in
[`src/core/leadAgentFactories.ts`](../src/core/leadAgentFactories.ts) wire those
seams to the real chat client (LLM decomposer + replanner), `orchestrate()` with
per-branch code verification, and `verifyCode()`.

Every run is bounded by **`maxAttempts`** (default 3) and **`maxDurationMs`**
(default 30 minutes), so an autonomous run always terminates.

## Safety posture

The lead agent runs under **full auto-approve**: sub-agents execute tools without
permission prompts (the same posture as `dontAsk` / `/yolo`). Capability gaps —
tools a sub-agent reached for but did not have — are reported as first-class
signals rather than silently dead-ending. The kill switch and timed-autonomy
revert still apply on the web surface.

## How to use it

### CLI (headless)

Opt in with `HARNESS_LEAD=1` and pass a task as the headless prompt:

```powershell
$env:HARNESS_LEAD = "1"
harness --prompt "build a REST API for a todo list with unit tests"
```

Progress (plan, orchestration, verification, replans) streams to stderr; the
final merged output is printed to stdout. Run artifacts are written under
`.harness/lead/<runId>/`.

### Web — `/auto` slash command

In the chat box:

```
/auto build a REST API for a todo list with tests
/auto refactor the auth module and add unit tests
/auto help
```

The command runs the lead agent to completion and returns a summary (status,
attempts, any capability gaps, and the final output).

### Web — streaming HTTP endpoint

`POST /api/lead/run` with `{ "task": "..." }` streams newline-delimited JSON
`LeadAgentEvent`s (`start`, `decompose`, `orchestrated`, `verify`, `replan`,
`capability_gap`, `done`) followed by a final `outcome` record. Closing the
connection aborts the run.

## Related

- [Governed Agent Loop](GOVERNED-LOOP.md) — the human-gated governance pass.
- `src/core/taskConductor.ts` — the sequential single-executor conductor the
  lead agent complements.
