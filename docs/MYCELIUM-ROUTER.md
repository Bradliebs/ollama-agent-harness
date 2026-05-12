---
title: Mycelium Router
description: Adaptive context routing for memories, tools, skills, workflows, safety rules, and verification signals
author: Bradliebs
ms.date: 2026-05-02
ms.topic: concept
keywords:
  - mycelium
  - routing
  - context
  - verifier
estimated_reading_time: 6
---

## Overview

The Mycelium router is an adaptive context layer in front of the existing
Ollama Agent Harness runtime. It does not replace the model loop, tool
dispatcher, permission engine, or browser UI. Instead, it builds a compact
graph of useful context and feeds the selected route into the existing harness
before a chat turn runs.

The graph is inspired by adaptive networks: useful routes strengthen after good
outcomes, weak routes decay, unsafe routes can be blocked, and protected safety
or verifier paths remain available even when their score is low.

## Routing Flow

For each chat turn, the router:

1. Classifies the task type and risk level.
2. Seeds generic safety, verifier, agent, workflow, prompt, and preference
   nodes.
3. Adds runtime tool, skill, and memory nodes.
4. Scores candidate nodes with keyword relevance and optional embedding
   relevance.
5. Spreads activation through the graph.
6. Selects a compact route with task-specific exploration and node limits.
7. Builds a structured context package and human-readable explanation.
8. Records reward components, verifier signals, blocked routes, and user
   feedback after the run.

High-risk classifications clamp exploration and keep safety or verifier nodes in
the selected context. Research and creative tasks allow more exploration.

## Graph Elements

The graph stores typed nodes and directed weighted edges.

Node types include:

* `query`
* `memory`
* `tool`
* `skill`
* `agent`
* `prompt_template`
* `workflow`
* `verifier`
* `safety`
* `preference`
* `strategy`

Edges carry weight, trust, cost, novelty, flow, use counts, success and failure
counts, archive state, blocked counts, origin, relation, and protection flags.
Protected nodes and edges are not pruned by normal decay.

## Learning Signals

After a run, the router computes reward from:

* Task success
* Correctness
* Usefulness
* Cost efficiency
* User satisfaction

The web runtime also feeds verifier results into reinforcement. Hard verifier
failures mark a route as blocked, weaken the route, and surface the block in the
Mycelium UI. Explicit thumbs-up, thumbs-down, and neutral feedback can reinforce
the most recent route with a user satisfaction signal.

## User Surfaces

The router is visible through three surfaces.

### Browser UI

The Mycelium tab shows graph stats, protected nodes and edges, archived edges,
recent episodes, the last selected route, grouped selection reasons, reward
components, applied verifiers, and blocked routes.

### Web API

The web server exposes Mycelium endpoints for graph inspection, last-route
inspection, graph reset, and user feedback on the most recent route.

### CLI

The `harness mycelium` command family supports graph initialization, seeding,
status, dry-run routing, task classification, route inspection, node and edge
inspection, decay, pruning, and export.

Examples:

```powershell
npm run start -- mycelium status
npm run start -- mycelium classify --query "refactor this module"
npm run start -- mycelium route --query "plan a safer workflow" --dry-run
```

## Implementation Files

Core modules live under `src/mycelium/`:

* `graph.ts` stores nodes, edges, episodes, archive records, and feedback.
* `taskClassifier.ts` assigns task type, risk, exploration, and node limits.
* `activation.ts` spreads activation and selects routes.
* `contextPackage.ts` builds structured context and route explanations.
* `reinforcement.ts` computes reward, decay, pruning, reinforcement, and
  weakening.
* `seeds.ts` seeds generic safety, verifier, agent, workflow, prompt, and
  preference nodes.
* `verifier.ts` scores output quality and hard-check failures.
* `router.ts` coordinates classification, activation, context, reinforcement,
  persistence, and feedback.
* `cli.ts` implements the `harness mycelium` command family.

The web integration is in `src/web/server.ts` and `ui/app.js`.

## Validation

Run the focused Mycelium tests:

```powershell
npm test -- --runInBand src/mycelium/v2.test.ts
```

For the full integrated surface, run:

```powershell
npm test -- --runInBand src/web/server.test.ts src/mycelium/v2.test.ts
npm run typecheck
npm run build
npm run smoke:ui
```