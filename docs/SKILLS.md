---
title: Skills (model-agnostic)
description: How the harness uses the same Skill protocol as Anthropic's Agent Skills, without coupling to Claude or any vendor API
author: Bradliebs
ms.date: 2026-05-16
---

# Skills

Skills are reusable, filesystem-based capabilities the agent loads on demand.
The harness implements the same protocol Anthropic documents at
[platform.claude.com/docs/.../agent-skills/overview][anthropic-skills], so any
skill written for Claude (a `SKILL.md` plus optional bundled files) works here
unchanged. The protocol is just markdown plus the filesystem — it does not
depend on which model you run.

[anthropic-skills]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

## Layout

```
.harness/skills/
├── code-review/
│   └── SKILL.md
├── pdf-processing/
│   ├── SKILL.md
│   ├── FORMS.md
│   ├── REFERENCE.md
│   └── scripts/
│       └── fill_form.py
└── _archive/        # curator-managed; not user-facing
```

Each skill lives in its own folder under `.harness/skills/`. The folder must
contain a `SKILL.md` file with YAML frontmatter. Any other files in the folder
are **bundled resources** the agent can read or execute on demand.

## SKILL.md format

The required frontmatter matches the Anthropic spec:

```markdown
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF Processing

## Quick start

Use pdfplumber to extract text from PDFs:

...
```

Required fields:

- `name` — kebab-case (lowercase letters, digits, hyphens). Max 64 chars.
- `description` — what the skill does **and** when to use it. Max 1024 chars.

Optional harness extensions (ignored by tools that only know the Anthropic
spec):

| Field | Purpose |
| --- | --- |
| `domain` | Category for grouping (e.g. `debugging`, `testing`). Defaults to `general`. |
| `triggers` | YAML list of phrases that activate the skill (`matchSkillTrigger`). |
| `risk_level` | `low` / `medium` / `high` — surfaced in the UI and workflow runner. |
| `enabled` | `false` to disable without deleting the folder. |
| `required_tools` | YAML list of tool names the skill expects to use. |
| `steps`, `examples`, `validation_checks`, `rollback_notes` | Structured guidance the workflow runner can read. |

## Progressive disclosure (Level 1 / 2 / 3)

The harness implements all three levels Anthropic describes:

- **Level 1 — Metadata always loaded.** `assembleSystemContext` injects every
  skill's `name`, `description`, and (when present) `triggers` into the system
  prompt under `--- Available Skills ---`. Capped at 40 entries; the rest are
  reachable via `list_skills`. Cost: ~100 tokens per skill.
- **Level 2 — SKILL.md body loaded on trigger.** When the model calls
  `skill(name: "...")`, the tool returns the full body. Cost: under 5k tokens
  per invocation.
- **Level 3 — Bundled resources loaded as needed.** The `skill` tool also lists
  sibling files (up to 20, recursing one level) so the model knows what to read
  with `file_read` or run with `bash`. Bundled file contents only enter the
  context window when the model explicitly reads them.

## Tools the agent uses

| Tool | What it does |
| --- | --- |
| `list_skills` | Enumerates installed skills (Level 1 metadata). Read-only. |
| `skill` | Loads SKILL.md body for a given skill name and lists bundled resources. Read-only. |
| `create_skill` | Writes a new `SKILL.md` from agent-supplied frontmatter and instructions. |
| `import_skill` | Bulk-imports an entire skill folder (SKILL.md + bundled files) from a local path. Source must live inside the project or under an Allowed External Path. |
| `install_skill` | Downloads a single SKILL.md from an allowlisted URL (GitHub raw / Gist / GitLab). |
| `file_read`, `bash` | Read Level-3 bundled resources or execute bundled scripts. |

## Installing skills

### From a local folder

`import_skill` copies the whole folder (with all sibling files) into
`.harness/skills/<name>/`. The folder must contain a `SKILL.md` and must live
inside the project root or under an entry in
**Settings → Allowed External Paths**.

```
import_skill(source: "/abs/path/to/pdf-skill")
```

Or with an override name and replacement:

```
import_skill(source: "./skills/pdf-skill", name: "pdf-processing", overwrite: true)
```

Caps: 200 files, 5 MB total. `node_modules/`, `.git/`, `.venv/`, `__pycache__/`,
`dist/`, `build/`, and any dotfile are skipped.

### From the Anthropic open-source skills repo

There is no special tool for GitHub. Use `bash` to clone, then `import_skill`:

```
bash(command: ["git", "clone", "--depth", "1", "https://github.com/anthropics/skills.git", "agent-outputs/anthropic-skills"])
import_skill(source: "agent-outputs/anthropic-skills/pdf")
```

`agent-outputs/` is already permitted for writes, so the clone target is safe.

### From a single URL

`install_skill` downloads one `SKILL.md` file from `raw.githubusercontent.com`,
`gist.githubusercontent.com`, or `gitlab.com`. Use this for single-file skills
without bundled resources.

```
install_skill(url: "https://raw.githubusercontent.com/.../SKILL.md")
```

## Authoring a skill

`create_skill` writes a new SKILL.md from the agent's own analysis. For human
authoring, drop a folder under `.harness/skills/` and write the file by hand —
the loader picks it up on the next system-prompt assembly.

Minimum viable skill:

```markdown
---
name: stock-convergence-scanner
description: Scan a watchlist for tickers whose moving averages are converging. Use when the user asks about MA convergence, trend setups, or pre-breakout screening.
---

# Stock Convergence Scanner

## When to use

The user mentions: convergence, MA crossover setups, pre-breakout scans.

## How to run

1. Read the watchlist from `agent-outputs/watchlist.csv`.
2. For each ticker, fetch 50-day and 200-day SMA from yahoo-finance2.
3. Flag tickers where the absolute difference is under 1%.
4. Write the result to `agent-outputs/convergence-report.md`.

## Bundled resources

- `scripts/scan.py` — the actual implementation. Run with
  `bash python scripts/scan.py`.
```

## Why this is model-agnostic

Skills are not an Anthropic API feature. They are a directory layout and a
markdown convention. The harness loader reads SKILL.md files from disk and
inlines their metadata into whatever model you have configured in
`OLLAMA_MODEL`. Once a skill is triggered, the `skill` tool returns the body
as plain text — the model uses it the same way it would use any other tool
output. No beta headers, no `container` parameter, no `code_execution_20250825`
tool required.

The only Anthropic-specific concept that does **not** translate is the
"pre-built Agent Skills" library (`xlsx`, `pptx`, `pdf`, `docx`) that runs
inside Anthropic's code-execution VM. Those rely on Anthropic's hosted Python
container. To get equivalent capability locally, install the relevant
open-source skill from the [Anthropic skills repo][anthropic-skills-repo]
via `import_skill` and let the harness's `bash` tool run the scripts under
your local Python.

[anthropic-skills-repo]: https://github.com/anthropics/skills

## Where SKILL.md fits in the system prompt

Mirroring `assembleSystemContext`, the system prompt assembled per turn looks
like this when skills are present:

```
<base system prompt>

--- HARNESS.md ---
...

--- Agent Memory: decisions.md ---
...

--- Available Skills ---
You can invoke these skills using the "skill" tool. Use "create_skill" to create new ones.
• code-review — Code review skill for the harness (triggers: review my code, audit this)
• pdf-processing — Extract text and tables from PDF files, fill forms, merge documents.
• planner — Guided wizard that scaffolds Copilot skills... (triggers: scaffold skills, plan my project)
```

Skills with no `triggers` field (Anthropic-standard format) appear without the
parenthetical, exactly as in Claude's system prompt.
