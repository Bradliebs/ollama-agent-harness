---
title: Governed Agent Loop
description: Confidence modes, self-critique, working memory, review queue, and idle replay for the Ollama Agent Harness
author: Bradliebs
ms.date: 2026-06-13
ms.topic: concept
keywords:
  - governance
  - confidence
  - self-critique
  - review queue
  - replay
  - memory
estimated_reading_time: 6
---

## Purpose

The Governed Agent Loop wraps an already-produced answer with one deterministic governance pass. It labels HOW the answer knows what it says, runs a self-critique, exposes the agent's current working memory, and stages any proposed memory updates as review artifacts — never auto-writes. Idle replays run while the user is away and re-queue their results for the same human review.

The loop ships as **shadow-first**: it runs beside the product path without changing the default answer contract. Behavior changes only when a human approves a staged item or drains the replay seam.

Source: [src/governed/](../src/governed/).

## Components

### Confidence mode — [confidenceMode.ts](../src/governed/confidenceMode.ts)

A pure classifier over signals the harness already computes (citations, web sources, confidence, abstention, source conflict). Every answer is labelled with one of four modes that mirror an honest consultant:

| Mode | Means |
|------|-------|
| `settled` | Settled knowledge — high confidence, no fresh-web sources |
| `reasoned` | The model's own reasoning, low or no external citations |
| `web-fresh` | Backed by web fetches in this turn, unverified against prior sources |
| `distrust` | Explicit abstention or source conflict — do not act on this yet |

The classifier never mutates anything; it surfaces the label so the caller (or the UI) can render it.

### Self-critique — [selfCritique.ts](../src/governed/selfCritique.ts)

Runs the four questions a careful reviewer asks before trusting an answer:

1. Is this cited?
2. Is the source old?
3. Is the claim fact or judgement?
4. What would make this wrong?

Produces structured findings and an overall verdict. It never blocks or mutates — it surfaces, the caller decides.

### Working memory — [workingMemory.ts](../src/governed/workingMemory.ts)

Assembles the pieces of "what the agent is currently holding in its head" (current goal, open questions, next action, pending tool calls) into one inspectable object. Pure mapping over an existing `ContinuityCheckpoint` — no I/O.

### Governed answer — [governedAnswer.ts](../src/governed/governedAnswer.ts)

Composes the four pieces above into one governance pass over an answer the product already produced. The original `answer` string is passed through untouched, so the function can run shadow-first without changing the default answer contract.

The output is a structured object containing: the unchanged answer, the confidence mode label, the self-critique findings, the working-memory snapshot, and any staged brain-update proposals.

## Review queue — [reviewQueue.ts](../src/governed/reviewQueue.ts)

One durable, human-gated queue for two governance lifecycles that share the same shape (a pending item resolved with an outcome):

* `brain-update` — a fact the governed pass proposed saving. Approval appends to `brain-approved.jsonl` AND appends the fact to `.harness/memory/patterns.md`. Rejection drops it.
* `needs-review` — an answer flagged for human review (e.g. `distrust` mode or a failed self-critique). Approval appends to the replay seam (`needs-review-replay.jsonl`) so it is later re-asked.

**Writes happen only on an explicit human approval.** Rejection and timeout both drop the item with an audit entry. State lives in `.harness/review-queue.jsonl`.

## Idle replay — [replayLedger.ts](../src/governed/replayLedger.ts), [replayConsumer.ts](../src/governed/replayConsumer.ts), [replayRunner.ts](../src/governed/replayRunner.ts)

When a human drains a `needs-review` answer onto the replay seam, the runner re-asks the same question through an injected harness runner and re-enqueues the fresh governed answer for review. The runner is injectable (`runOne` + `enqueue`) so it stays model-free and testable.

* `replayLedger` — appends an audit JSONL entry per idle-replay run to `.harness/idle-replay-log.jsonl`. Fire-and-forget; a missing ledger simply means "nothing recorded".
* `replayConsumer` — parses staged candidates from `.harness/needs-review-replay.jsonl` and atomically clears them when consumed, guaranteeing each drained answer is processed exactly once.
* `replayRunner` — closes the last open link: consumes candidates, re-asks each one, and re-enqueues the fresh governed answer for human review. It writes nothing to the brain and auto-approves nothing — a replayed answer re-enters the same human-gated review queue. The loop is shadow-first end-to-end.

## HTTP surface

Routes registered by [reviewQueueRoutes.ts](../src/web/reviewQueueRoutes.ts) and [workingMemoryRoutes.ts](../src/web/workingMemoryRoutes.ts):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/working-memory` | Snapshot of current goal, open questions, next action, pending tool calls |
| GET | `/api/review-queue` | Pending brain-update and needs-review items |
| POST | `/api/review-queue/:id/approve` | Approve an item (triggers the brain write or seam append) |
| POST | `/api/review-queue/:id/reject` | Reject and drop an item |
| POST | `/api/review-queue/:id/drain` | Drain a `needs-review` item onto the replay seam |
| GET | `/api/replay-candidates` | Pending replay candidates |
| POST | `/api/replay-candidates/consume` | Atomic consume |
| GET | `/api/replay-history` | Idle-replay ledger entries |
| GET | `/api/governed-metrics` | Counters across modes, critiques, and queue outcomes |

## Storage

| Path | Contents |
|------|----------|
| `.harness/review-queue.jsonl` | Pending and resolved review-queue items |
| `.harness/brain-approved.jsonl` | Audit log of approved brain updates |
| `.harness/memory/patterns.md` | Durable brain — fed by approved brain-updates |
| `.harness/needs-review-replay.jsonl` | Replay seam: drained needs-review answers awaiting re-ask |
| `.harness/idle-replay-log.jsonl` | Audit log of idle-replay runs |

## Design properties

* **Shadow-first.** No default code path changes until a human approves.
* **Pure where it can be.** `confidenceMode`, `selfCritique`, `workingMemory`, and `governedAnswer` perform no I/O.
* **Durable, append-only seams.** Each lifecycle uses its own JSONL file with atomic truncate-on-consume semantics.
* **Injectable runner.** `replayRunner` accepts `runOne` and `enqueue` callables so it stays model-free in tests.
* **One queue, two lifecycles.** `brain-update` and `needs-review` share the same approval/rejection/timeout shape, with different post-approval side effects.

## Status

The loop landed on 2026-06-11. The HTTP surface is live and the UI panel ships in the settings **Governed Agent Loop** section: it renders the working-memory snapshot, the pending review queue (approve/reject brain-updates, drain/dismiss needs-review answers), the drained-replay seam with a "Replay drained answers" trigger, and the lifetime loop metrics, with pending-count and throughput badges in the session HUD. The seam can still be driven by direct API calls or by an operator working from `.harness/review-queue.jsonl`.
