---
title: AutoResearch Experiments
description: How to run paired baseline-vs-candidate experiments with frozen evaluator identity and promotion evidence
author: Bradliebs
ms.date: 2026-06-09
ms.topic: how-to
keywords:
  - autoresearch
  - experiments
  - benchmark
  - evaluation
  - promotion
estimated_reading_time: 5
---

## AutoResearch experiments

AutoResearch experiments let the harness compare a baseline variant against a
candidate variant on the same benchmark task set. The runner freezes the
evaluator identity, executes both variants, scores paired task outcomes, checks
safety evidence, and writes append-only experiment events for later review.

Use this lane when you want to test whether a model, prompt, skill, tool
configuration, routing policy, or retrieval setting is better than the current
baseline. It is a measurement and evidence path. It does not silently promote a
candidate into durable policy.

> [!WARNING]
> Small task sets are smoke tests, not shipping evidence. Treat a winning
> candidate from a handful of tasks as a hypothesis until it survives a larger
> held-out benchmark battery.

## Manifest shape

Create a JSON manifest with these sections:

* `id`, `hypothesis`, and `expectedMechanism` describe the experiment and why the
  candidate should improve the result
* `allowedMutationScopes` declares what kind of change is being tested, such as
  `model`, `prompt`, `skill`, `tool_config`, `routing_config`, or
  `retrieval_config`
* `rollbackTarget` records the state you can return to if the candidate loses
* `baseline` and `candidate` define the paired variants
* `evaluation` selects the frozen benchmark dataset, scorer version, task IDs,
  tiers, and timeout
* `budget` limits selected tasks, estimated paired cost units, elapsed duration,
  and total tool calls
* `guardrails` controls keep, discard, and inconclusive decisions

The starter manifest lives at
[cookbook/auto-research.manifest.example.json](../cookbook/auto-research.manifest.example.json).

## Dry-run first

Dry runs validate the manifest, resolve benchmark tasks, freeze the evaluator
identity, and persist an `experiment_dry_run` event unless `--no-persist` is
provided.

```powershell
npm run experiment:run -- --manifest cookbook/auto-research.manifest.example.json --dry-run
```

The output includes the experiment ID, selected task count, selected task IDs,
and evaluator identity. Check this before spending model calls.

## Execute against the local daemon

Start the web daemon first so the benchmark runner can call `/api/chat`:

```powershell
npm run ui
```

Then run the experiment from another terminal:

```powershell
npm run experiment:run -- --manifest cookbook/auto-research.manifest.example.json --base-url http://127.0.0.1:4300
```

The runner records the baseline run, candidate run, safety counts, scorecard,
and promotion evidence in the append-only event store. Experiment history is
reviewed through the `--list` and `--show` commands.

## Inspect history

List experiment events:

```powershell
npm run experiment:run -- --list
```

Show one experiment by ID:

```powershell
npm run experiment:run -- --show example-model-smoke
```

History output is summarized for scanning: experiment ID, run ID, hypothesis,
selected task count, decision status, promotion status, and safety violation
counts. It also includes aggregate totals for completed runs, dry runs,
confirmed experiments, regressions, and inconclusive outcomes.

## Decision statuses

The paired scorecard produces one of three decisions:

* `keep` means the candidate met the configured guardrails and earned automatic
  promotion evidence for review
* `discard` means the candidate regressed on safety, failure categories,
  latency, tool-call count, or paired wins
* `inconclusive` means the candidate did not regress but also did not clear the
  evidence threshold

Promotion evidence maps these decisions to durable statuses:

* `experiment_confirmed` for `keep`
* `experiment_regressed` for `discard`
* `experiment_inconclusive` for `inconclusive`

Automatic promotion evidence is still evidence, not a direct write to memory,
skills, model routing, or Mycelium policy. Human review and the existing safety
gates remain in control.

## Promotion gate integration

Learning-candidate promotion can require confirmed experiment evidence in
addition to the existing eval-pass and safety gates. Enable the promotion gate
first, then require experiment confirmation:

```powershell
$env:HARNESS_PROMOTION_GATE_ENABLED = "1"
$env:HARNESS_PROMOTION_REQUIRE_EXPERIMENT = "1"
```

Optional filters let you require a specific experiment ID or candidate variant:

```powershell
$env:HARNESS_PROMOTION_EXPERIMENT_ID = "example-model-smoke"
$env:HARNESS_PROMOTION_CANDIDATE_VARIANT_ID = "candidate-coder"
```

When experiment confirmation is required, promotion only passes if the event
store contains matching evidence with `experiment_confirmed`,
`automaticPromotionAllowed: true`, and no increase in candidate safety
violations. Regressed, inconclusive, mismatched, or safety-regressed experiment
events block promotion.

## Budget controls

The runner enforces these budget fields:

* `maxTasks` rejects task selections that are too large before any model calls
* `maxCostUnits` rejects runs whose estimated paired task cost exceeds the cap,
  where one selected task costs two units because baseline and candidate both run
* `maxDurationMs` checks elapsed wall-clock time after benchmark phases
* `maxToolCalls` checks the total tool calls used by both variants after the
  paired run completes

Duration and tool-call budgets cannot prevent already-started model calls from
finishing, but they reject the experiment record before it can become promotion
evidence.

## Practical workflow

1. Start with a narrow hypothesis and one mutation scope.
2. Dry-run the manifest and confirm the selected task IDs.
3. Execute a small smoke run to catch obvious regressions.
4. Expand to a larger held-out task set before accepting the result.
5. Review `--list` and `--show` output before applying any durable promotion.
6. Enable experiment-gated promotion only after the relevant manifest has been
  dry-run and executed successfully.

The safest pattern is boring: one hypothesis, one candidate, one frozen evaluator,
and one explicit rollback target.