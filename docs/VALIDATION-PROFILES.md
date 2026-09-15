---
title: Output Validation Profiles
description: Answer-format profiles and independently checked workflow outcomes
ms.date: 2026-09-15
---

## Output Validation Profiles

The harness can score every final assistant answer against a deterministic
contract called a **validation profile**. The profile is selected per turn —
either manually from the **Output Validation** settings panel or automatically
from the prompt.

## Built-in profiles

| Profile | When it fits |
|---|---|
| `oracle-prime` | Strategy, decisions, risk, uncertainty, multi-scenario reasoning. Default neutral fallback. |
| `factual-answer` | Current or factual questions (weather, news, prices, "who/what/when/where"). |
| `coding-answer` | Code changes, refactors, debugging, tests, build commands, file edits. |
| `tool-result-summary` | Summarising terminal output, command results, stack traces. |

## Auto-select rules

When **Auto-select best contract** is on, each prompt is matched against keyword
patterns in this order:

1. **Short or vague prompts** (under 12 characters, or starting with phrases
   like "you decide", "whatever", "anything", "surprise me", "up to you", "your
   choice", "idk", "dunno") → fall back to `oracle-prime` and are flagged as
   **unmatched**.
2. **Mode-classifier override.** If the upstream mode classifier flagged the
   prompt as `research` or `maintain`, the suggester returns `oracle-prime`
   without consulting the keyword table. This stops research/maintenance
   prompts that happen to mention a file path or language keyword from being
   graded against the `coding-answer` rubric.
3. **Research-intent guard.** Even without a mode hint, a clear research verb
   at the start of a clause (`research`, `investigate`, `look up`, `find out`,
   `analyse`/`analyze`) or one of the analytical phrases (`pros and cons`,
   `trade-offs`, `state of the art`, `literature review`, `compare X to/vs Y`)
   → `oracle-prime`.
4. **Tool / terminal signals** (`stdout`, `stderr`, `exit code`, `tool result`,
   `terminal output`, `command output`, `stack trace`) → `tool-result-summary`.
5. **Code signals** (`code`, `coding`, `implement`, `refactor`, `debug`,
   `typecheck`, `unit test`, `pull request`, `commit`, language names like
   `typescript`/`javascript`/`python`, file extensions like `.ts`/`.tsx`/`.js`/
   `.py`, package managers like `npm`/`yarn`/`pnpm`, `jest`, `eslint`, `compile`,
   `function`, `class`, `method`, `api endpoint`) → `coding-answer`.
6. **Factual signals** (`weather`, `today`, `current`, `latest`, `news`,
   `price`, `stock`, `who is`, `what is`, `when is`, `where is`, `source`,
   `according to`, `factual`) → `factual-answer`.
7. **Decision signals** (`decision`, `strategy`, `risk`, `scenario`, `tradeoff`,
   `alternative`, `recommend`, `confidence`, `uncertainty`, `forecast`, `plan`)
   → `oracle-prime`.
8. **Anything else** → `oracle-prime` (flagged as **unmatched**).

The matched/unmatched flag is shown in the chat UI as either
"Auto-selected `<profile>`" or "Defaulted to `<profile>`", along with the
reason.

## Settings

Open the right-side **Output Validation** panel to control:

* **Validate final answers** — enables validation globally.
* **Auto-select best contract** — uses the rules above. Turn off to always use
  the manually selected profile.
* **Skip validation on low-signal prompts** — when auto-select cannot find a
  strong signal, skip validation entirely instead of running Oracle Prime
  against small talk.
* **Reasoning contract** — manual override profile when auto-select is off.

You can also skip validation for a single message with the **Skip validation
for this turn** checkbox under the chat input. The global setting is not
changed.

## Feedback

Each auto-selected profile shows 👍 / 👎 buttons. Clicks are recorded as eval
trace runs tagged `profile-feedback` and `profile-feedback:up` or
`profile-feedback:down`, and roll up into the **Output validation trends** view.

## Custom profiles

You can add custom deterministic profiles in JSON via the **Custom profiles**
section. Each custom profile lists `checks` with `code`, `severity` (`fail` or
`warn`), `requiresAny` keywords, and an optional `scorePenalty`. Custom
profiles are saved to `.harness/output-validation-profiles.json`.

## Workflow Outcome Benchmarks

Answer profiles are not independent proof that a file or application is correct.
The bounded runner in [scripts/local-core-baseline.js](../scripts/local-core-baseline.js)
uses real permission-checked tools and independently inspects generated artifacts.
It has twelve development tasks and eight frozen separately AI-authored holdouts.
Each live cohort uses three attempts per task, 60-second file-task deadlines,
a 30-minute overall budget and a stop after three consecutive infrastructure failures.

Build first, then validate the runner offline:

```powershell
npm run build
node --test scripts/outcome-cases.test.js scripts/local-outcomes.integration.test.js scripts/holdout-cases.test.js scripts/cloud-mode.test.js
```

Live cloud development testing requires an already listed, authenticated Ollama
cloud model and a new report path:

```powershell
node scripts/local-core-baseline.js --cloud --outcomes results/new-cloud-development.json glm-5.2:cloud
```

The runner uses `http://127.0.0.1:11434`. It requires an explicit model name,
checks Ollama cloud destination metadata in parent and worker processes, performs
no downloads and provides no local fallback. It trusts the daemon to honor its
advertised route. Cloud requests transmit synthetic fixtures and tool results and
consume the signed-in account's allowance; costs are not computed.

Without `--cloud`, the runner permits only its named local models and rejects
remote metadata. Do not run local cohorts while another workload needs the GPU.

Development reports include a dataset version and digest. The clarified
`development-v2` cohort passed 36/36; the older development cohort scored 29/36
under different prompts. The frozen holdout cohort remains 12/24. Do not compare
these as an unchanged-task improvement, relax graders to recover failures, or
tune against the holdouts. Full evidence and remaining gaps are in
[Modernization Status](MODERNIZATION-STATUS.md).
