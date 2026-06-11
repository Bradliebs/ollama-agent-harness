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
  tiers, timeout, and an optional held-out confirmation split (`holdout`)
* `budget` limits selected tasks, estimated paired cost units, elapsed duration,
  and total tool calls
* `guardrails` controls keep, discard, and inconclusive decisions, including the
  optional `requireSignificance` and `minHoldoutNetWins` trust gates

The starter manifest lives at
[cookbook/auto-research.manifest.example.json](../cookbook/auto-research.manifest.example.json).

### Held-out battery

The built-in catalog ([src/eval/benchmarkTasks.ts](../src/eval/benchmarkTasks.ts))
carries an extended `ext.*` battery: 21 development format/reasoning tasks plus a
12-task adversarial/calibration holdout. The holdout tasks are tagged `holdout`
and are *content-disjoint from but capability-matched to* the development
adversarial tasks (for example, development checks `∛`-style confident-wrong on
one item while the holdout checks the same axis on a different item). They were
authored specifically **not** to be used to design any candidate, so directional
agreement there is a genuine generalisation test rather than a memorised win.

A ready-to-run arm over the full 58-task non-tool battery lives at
[cookbook/auto-research.holdout-battery.manifest.json](../cookbook/auto-research.holdout-battery.manifest.json)
(46 development tasks, 12 reserved holdout tasks, trust gates on). Requires
`HARNESS_EXPERIMENT_PROMPT_OVERRIDE=1` on the daemon.

> [!WARNING]
> 58 paired tasks and a 12-task holdout are a real improvement over the prior
> 25/6 split, but they remain **modest** for a McNemar gate — a holdout net-win
> of two has a wide confidence interval. Treat any keep as provisional and
> re-confirm on a larger battery before changing production policy.

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

## Held-out confirmation and the noise floor

A win on a small task set can be a sampling artifact: both the size of the
effect and the specific tasks it won on can be noise. Two mechanisms guard
against shipping such a win.

**Noise floor.** Every scorecard reports `passRateDeltaStdErr` and
`passRateDeltaCi95`, the standard error and 95% confidence interval of the
paired pass-rate delta (McNemar paired-proportion formula). When the interval
straddles zero, the observed win sits inside the noise floor. These fields are
always present and never gate a decision on their own — they describe how much
to trust the delta.

**Held-out split.** Set `evaluation.holdout` to carve a confirmation subset out
of the selected tasks. Tasks are still evaluated; the scorer simply reports a
separate `holdout` sub-scorecard (paired counts, net wins, significance) for
them. Provide either:

* `taskIds` — an explicit subset of the selected task IDs, or
* `fraction` — a value in `(0, 1)`; tasks are partitioned by a stable SHA-256
  hash of the task ID, so the same split is reproduced on every run and machine.

Use a held-out split to detect a candidate that was iterated against the visible
task set: if the gain does not reproduce on tasks that were not used to tune it,
treat it as overfitting.

**Trust gates (opt-in).** Two guardrails turn the measurements above into keep
requirements. Both default off, so existing manifests are unaffected:

* `requireSignificance: true` downgrades a would-be `keep` to `inconclusive`
  unless the paired McNemar test is significant at 95%. This needs enough
  discordant pairs to clear the noise floor — a handful of canned tasks can
  never be significant (the maximum McNemar statistic on four paired tasks is
  2.25, below the 3.841 threshold), so this gate is meant for a larger battery.
* `minHoldoutNetWins: N` downgrades a would-be `keep` to `inconclusive` unless
  the held-out subset shows at least `N` net candidate wins. It requires a
  `holdout` split to be configured.

Release-grade evidence therefore combines a larger task set (enough paired tasks
to clear `requireSignificance`), a `holdout` split, and both trust gates. The
starter manifest keeps these gates off because it is a four-task smoke test; it
includes a one-task `holdout` only to demonstrate the split syntax.

## Stochastic replicates

A single run of a task at a sampling temperature above zero is one draw from a
distribution: a borderline task can pass on one run and fail on the next purely
by chance, which makes the keep/discard decision a coin toss. Set
`evaluation.replicates: N` (default `1`) to run each task `N` times per arm and
aggregate the runs into a single **majority-vote** verdict — a task passes only
if strictly more than half its replicates passed. The aggregated result records
`replicateCount` and `passReplicates` (the `k` in a `k/N` vote) for transparency,
and its `toolCalls`/`durationMs` are the honest totals across all replicates so
budget gates see the real spend.

> [!IMPORTANT]
> Replicates do **not** increase the statistical sample. Aggregation collapses
> the runs back to one verdict per task, so the McNemar test sees the same
> number of cells whether `replicates` is `1` or `20`. Counting each replicate
> as its own paired observation would be pseudoreplication — manufactured
> significance from correlated draws. What replicates actually buy is lower
> per-task variance, so genuinely borderline tasks stop flipping the decision on
> sampling noise; they do not let a thin win clear `requireSignificance`.

Two practical constraints:

* Replicates only vary if the daemon samples at temperature `> 0` (the default
  `0.2` is fine). At temperature `0` every replicate is identical and the run is
  equivalent to `replicates: 1` at `N×` the cost.
* A run with `N` replicates spends roughly `N×` the duration and tool-call
  budget, so scale `budget.maxCostUnits`, `budget.maxDurationMs`, and
  `budget.maxToolCalls` accordingly.

A ready-to-run replicated arm (`replicates: 3` over the same 58-task hardened
battery, budget scaled ~3×) lives at
[cookbook/auto-research.holdout-battery-replicated.manifest.json](../cookbook/auto-research.holdout-battery-replicated.manifest.json).

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