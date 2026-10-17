# Getting more from your model

The harness can make a model noticeably more capable than it is on its own. Some
of that is always on (checking the work, retrying, escalating). Some is opt-in
structure that helps weaker models but can hold strong ones back. This guide
covers what each lever does, where it applies, and how to measure whether it
helps *your* model on *your* tasks before you switch it on.

## Always on

These need no setup.

| Lever | What it does | Where |
|---|---|---|
| Code verification and repair | After a coding task changes files, typecheck / lint / tests run; a failure goes back to the model for a fix (`HARNESS_VERIFY=0` turns it off). | Web chat coding tasks, task mode, CLI and autonomy in code projects |
| Research claim check | Figures in a research answer are checked against the pages actually read (`HARNESS_VERIFY_RESEARCH`: `check` by default; `annotate`, `critic` or `gate` go further). | All runs that read pages |
| In-run escalation | A stuck run, or an answer the verifier rejected twice, continues on the strong-tier model (unless routing is set to **Keep selected model**). | Web chat and task mode |
| Synthesis | A run that used tools but ended without an answer, hit its turn limit or repeated itself is asked to write the answer from what it found. | All runs |
| Auto-continue | An answer that looks partial is continued. | Web chat and task mode |
| Project instructions | `HARNESS.md`, `AGENTS.md` and `CLAUDE.md` go into every prompt. | All runs |

## Step 1: measure the model

```powershell
harness probe qwen3:8b            # or: Probe model in the web UI
```

The probe measures native tool calling, JSON validity with and without
schema-constrained output, instruction following, usable context (needle
retrieval) and multi-step plan coherence. It saves
`.harness/model-profiles/<model>.json` with recommendations: tool-call format,
tools per step, scaffolding level and a context budget. A fresh profile (under
30 days old) already caps the context budget at the measured usable window, and
replaces the name-based "weak/strong tool use" guess in the model picker.

Probe the id you chat with: `local/qwen3`, `groq/llama-3.1-8b-instant` and
`qwen3:8b` are different profiles. `harness probe groq/llama-3.1-8b-instant` saves the
profile the web chat uses; `harness probe llama-3.1-8b-instant --backend groq`
saves one under the bare name, which only the CLI with `--backend groq` finds. Probes spend tokens, so they only run when
asked.

## Step 2: the opt-in layers

| Layer | Switch | What it changes | Helps most |
|---|---|---|---|
| Adapter | `HARNESS_ADAPTER_MODE=profile` | Offers the probe's number of tools (most relevant first), and switches models that misuse native tool calls to JSON tool calls, schema-constrained where the backend supports it. Needs a fresh probe. | Small models with unreliable native tool calling |
| Scaffolding | `HARNESS_SCAFFOLD_MODE=profile` (or `light` / `medium` / `heavy`) | **Medium:** a short plan first, the 10 most relevant tools, at most 3 calls per turn. **Heavy:** a plan-only first reply, one tool per step, a next-step prompt, older tool results trimmed. `profile` uses the probe's recommended level. | Models that lose the thread on multi-step tasks |
| Working state | `HARNESS_WORKING_STATE=on` (`HARNESS_WORKING_STATE_POSITION=tail` to send it last) | A typed plan / facts / decisions / open questions block in every prompt that compaction can't drop, and a `state_update` tool. | Long tasks that get compacted |
| Lesson recall | `HARNESS_LESSONS=recall` | Up to four relevant lessons from earlier runs (blocked sites, stuck requests, unsupported figures, budget overruns) in the prompt. | Repeated research workloads |

How tools are chosen when a layer limits them: half the slots (at least three
from five up) go to the core tools in this order: `file_read`, `bash`, `file_edit`, `grep`, `list_files`,
`file_write`, `web_search`, `web_read`, so the model can always read, run
commands and edit. The rest go to the tools most relevant to the whole
conversation (the latest message counts twice), so "yes, do it" keeps the
tools the request needed. Under task mode's conductor, scaffolding doesn't
narrow the tools.

`=profile` is the safest way to switch a layer on: it acts only on models with a
fresh probe profile, at the level the probe recommends, and leaves other models
alone.

### Where the layers apply

| Surface | Layers |
|---|---|
| Web chat | All, from the environment |
| Task mode (Codex tasks) | All; scaffolding keeps its per-turn call limit but not its plan wording, plan-only first reply or tool narrowing, because the conductor plans each step. The adapter's probe-sized tool set, if on, is chosen once from the task and used for every step |
| CLI (`harness -p`, interactive) | All, from the environment; interactive mode applies them per message |
| Autonomy loop | All (each task runs through the CLI headless path) |
| Experiments | Per variant, from the manifest (below) |
| `harness replay` | None: replays reuse the recorded prompt |

### Check that they took effect

The web chat's tool activity shows **🧩 capability layers** with what was
applied, and **layers skipped** with the reason, for example
`adapter: qwen3:8b has not been probed`. The CLI prints the same as its first
lines. A profile older than 30 days counts as missing.

## Step 3: A/B test before switching a layer on

Layers change answers, so test them on tasks you care about. The experiment
runner sends the same tasks to a baseline and a candidate and scores them as
pairs (McNemar test, optional held-out tasks). Give each variant its `layers`;
`{}` means none, whatever the environment says:

```json
{
  "id": "scaffold-medium-qwen3",
  "hypothesis": "Medium scaffolding raises qwen3:8b's pass rate on tool tasks.",
  "expectedMechanism": "Planning first and fewer tools per turn reduce wrong tool calls.",
  "allowedMutationScopes": ["tool_config"],
  "rollbackTarget": "HARNESS_SCAFFOLD_MODE unset",
  "baseline":  { "id": "base",     "label": "No layers",          "model": "qwen3:8b", "layers": {} },
  "candidate": { "id": "scaffold", "label": "Medium scaffolding", "model": "qwen3:8b", "layers": { "scaffold": "medium" } },
  "evaluation": { "datasetId": "my-tool-tasks:v1", "scorerVersion": "benchmark.ts:v1", "tiers": ["regression"], "replicates": 3 }
}
```

```powershell
$env:HARNESS_EXPERIMENT_PROMPT_OVERRIDE = '1'   # on the daemon: lets requests choose their prompt and layers
npm run experiment:run -- --manifest scaffold-medium.json --dry-run
npm run experiment:run -- --manifest scaffold-medium.json
```

`layers` accepts `adapter` (true/false), `scaffold` (`light`, `medium`, `heavy`,
`profile`), `workingState` (true/false/`tail`) and `lessons` (true/false). If a
variant's layers aren't applied (the daemon lacks the override flag, the spec is
invalid, or `adapter`/`scaffold: profile` meets a model without a fresh probe), the
experiment stops with an error that says why, rather than scoring a variant that
didn't test what it claims.

Test on tool-using tasks: the layers change how tools are offered and called,
and only three built-in benchmark tasks use tools (`stress.list-files`,
`stress.grep-pattern`, `adversarial.self-certification`). Add your own to
`.harness/benchmarks/regressions.json` as an array of tasks with
`"tier": "regression"`, an `id`, a `description`, the `input` message, and what
passing means (`requireTools`, `expectIncludes`, `expectMissing`,
`forbiddenTools`); the example above runs them. Tasks that failed in earlier
benchmark runs are added there automatically. See
[AUTORESEARCH-EXPERIMENTS.md](AUTORESEARCH-EXPERIMENTS.md) for manifests,
guardrails and holdouts.

`harness replay` and `harness benchmark-history` answer a different question:
how another *model* (or deferred tool loading) does on your recorded runs, in
turns, tokens, cost and stuck runs. They don't grade correctness, and they don't
apply layers.

## Other levers

* **A bigger local model.** An OpenAI-compatible local server such as Strata
  runs models Ollama can't fit (a 125B model on a 12 GB GPU); use it as the
  `local` backend (see [MODEL-PRESETS.md](MODEL-PRESETS.md#local-model-servers)).
* **Fewer tool definitions in a small window.** In the web chat,
  `HARNESS_TOOL_LOADING=auto` offers core and relevant tools plus `tool_search`
  when the definitions would take more than a fifth of the context window.
* **Better context in the request.** `@path` mentions put a file's current
  contents into the message; `AGENTS.md` carries project conventions; skills
  carry procedures.
* **Plan first.** `/plan` runs read-only and ends with a plan you approve.

## Not applied yet

* **Sampling temperature and top-p.** The settings are stored but not sent to
  the model, so every model runs at its own default (its Ollama Modelfile or the
  provider's).
* **The probe's `promptTier` recommendation** is shown but nothing acts on it.

## Known limits

* When the adapter or scaffolding limits the tools, there is no `tool_search` to
  load others; a tool outside the chosen set can't be called that turn.
* With the adapter's JSON tool calls and working state both on, the JSON tool
  list doesn't include `state_update`, so the model can read the working state
  but not update it.
* CLI and autonomy runs aren't recorded in `.harness/runs/`, so they can't be
  replayed and don't produce lessons; they also don't escalate to a stronger
  model when stuck.
