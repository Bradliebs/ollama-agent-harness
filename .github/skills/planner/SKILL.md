---
name: "copilotforge-planner"
description: "Guided wizard that scaffolds Copilot skills, agents, memory, and cookbook recipes into any repo from a plain-English project description"
domain: "scaffolding"
confidence: "high"
source: "manual — Phase 1 core deliverable"
triggers:
  - "set up my project"
  - "scaffold skills"
  - "create agents"
  - "copilot forge"
  - "forge"
  - "plan my project"
  - "set up copilotforge"
  - "bootstrap this repo"
  - "scaffold my repo"
  - "create project structure"
  - "help me set up copilot"
  - "I want agents for this project"
---

<!-- 👋 Human? This file contains instructions for AI assistants, not for you.
     For the human-friendly guide, see docs/GETTING-STARTED.md -->

# CopilotForge Planner

> Drop this file into any repo at `.github/skills/planner/SKILL.md`. When triggered, it walks you through a short set of questions and scaffolds a complete Copilot-ready project structure — skills, agents, memory, and cookbook recipes. No CLI. No framework. Just markdown.

## What This Does

CopilotForge turns a plain-English project description into a working set of Copilot skills, agent definitions, persistent memory files, and copy-paste code recipes. You describe what you're building; it builds the scaffolding.

**Output structure after this skill runs:**

```
.copilot/
  agents/
    planner.md           ← this orchestrator (self-reference)
    {role}.md            ← generated for your use case
.github/
  skills/
    planner/
      SKILL.md           ← this file
      reference.md       ← format reference
    {your-skill}/
      SKILL.md           ← trigger + instructions
forge-memory/
  decisions.md           ← what was built and why
  patterns.md            ← reusable conventions
  preferences.md         ← your settings and overrides
  history.md             ← session activity log
cookbook/
  {recipe}.{ext}         ← SDK/code recipes for your stack
FORGE.md                 ← human-readable control panel
```

---
### Capture Decisions (forge remember)

If the user says **"forge remember: [anything]"** at any point in this conversation,
immediately acknowledge it ("Got it — logging that.") and append a new entry to
`forge-memory/decisions.md` in this format:

```
## [YYYY-MM-DD] [brief label]
[the user's exact words]
```

Then continue the conversation without interruption. Do not ask for confirmation.


## Instructions

When this skill is triggered, follow every step below in order. Do not skip steps (though Step 0 may shorten the wizard for returning users). Do not assume answers — ask each question and wait for the user's response, unless memory provides the answer.

### Step 0 — Check for Existing Memory

Before greeting or asking questions, check if this repo already has CopilotForge memory:

1. Check if `forge-memory/decisions.md` exists.
2. Check if `forge-memory/patterns.md` exists.
3. Check if `forge-memory/preferences.md` exists.
4. Check if `FORGE.md` exists.

**If memory files exist (returning user):**

Read whatever memory files are present. If any file is missing or unreadable, skip it gracefully — use only what's available.

- Read `forge-memory/decisions.md` — extract the most recent 5 decisions (entries under `### {date}` headings)
- Read `forge-memory/patterns.md` — extract all active patterns (headings under `## Stack Conventions` and `## Project-Specific Patterns`)
- Read `forge-memory/preferences.md` — extract verbosity level, stack preferences, any user overrides, and `BUILD_PATH` (if present)
- Read `FORGE.md` — extract the Project section (description, stack, settings) and the Skills/Agents tables

- **Check for conflicts:** Compare memory against the current project state:
  - Read `package.json`, `requirements.txt`, `go.mod`, `.csproj`, or other manifest files
  - If the stack in `forge-memory/patterns.md` doesn't match detected frameworks (e.g., memory says "Python/FastAPI" but `package.json` has Express), surface the conflict:
    > ⚠️ **Stack conflict detected:** Your memory says **{stack from memory}** but I found **{detected stack from manifest files}**. Which is correct?
    > 1. **{detected stack}** — Update my memory to match the current project
    > 2. **{memory stack}** — Keep the existing memory (maybe I'm in a different branch)
    > 3. **Both are relevant** — This is a polyglot project
  - Record the resolution in `forge-memory/decisions.md`
  - If no conflict is detected, proceed normally

Present a context summary to the user:

> 👋 **Welcome back!** I found your project context:
> - **Project:** {project description from FORGE.md or last decision}
> - **Stack:** {stack from patterns.md or FORGE.md}
> - **Last run:** {date of most recent decision}
> - **Decisions:** {count} recorded
> - **Patterns:** {count} active conventions
> - **Agents:** {agent names from FORGE.md Agents table}
>
> What would you like to do? *(add a skill, add an agent, update recipes, or describe what's changed)*

**Returning user path check (v1.6.0):** After reading `forge-memory/preferences.md`, check whether `BUILD_PATH` is present:

- **If `BUILD_PATH` is absent or `J`:** Use the "What would you like to do?" prompt above. No new text, questions, or behavior — this flow is unchanged from v1.6.0.
- **If `BUILD_PATH` is A–I (a Power Platform path):** Replace the "What would you like to do?" prompt with:
  > Welcome back to **[PATH_NAME]**. What would you like to do?
  > **1.** ▶ Continue where you left off
  > **2.** 🔀 Change path — describe something new and I'll re-detect your path
  > **3.** 🔄 Reset — start fresh from the beginning
  - **Choice 1:** Keep stored `BUILD_PATH` and `PATH_NAME`. Skip path detection. Proceed to Step 2 with pre-populated answers.
  - **Choice 2:** Clear stored `BUILD_PATH`. Proceed to Q1, then run path detection on the new answer.
  - **Choice 3:** Clear all forge-memory. Run the full first-time wizard from Step 1.

### Path-Change Conflict Detection

**Trigger:** forge-compass returns a BUILD_PATH that DIFFERS from what's stored in
forge-memory/preferences.md (BUILD_PATH field).

**When detected**, present this three-choice flow:

> I noticed you may be working on a different type of project than last time.
> Your memory says **[stored PATH_NAME]** (Path [stored letter]) but your description
> suggests **[new PATH_NAME]** (Path [new letter]).
>
> How would you like to proceed?
> 1. **Use new path** — Update my memory and scaffold for [new PATH_NAME]
> 2. **Keep existing path** — Stay with [stored PATH_NAME] as before
> 3. **Wipe memory** — Start fresh with a clean slate

**On choice 1:** Update FORGE-CONTEXT BUILD_PATH + PATH_NAME. Set PREREQUISITES_CONFIRMED=false.
Proceed with new path routing. memory files will be updated to persist the change.

**On choice 2:** Keep stored BUILD_PATH. Proceed with existing path. No FORGE-CONTEXT changes.

**On choice 3:** Wipe forge-memory/preferences.md. Reset all FORGE-CONTEXT fields to defaults.
Restart wizard from Q1.

**Returning Power Platform user (same path):**
If stored BUILD_PATH matches detected BUILD_PATH, skip all questions and say:
> Welcome back! I see you're still working on [PATH_NAME]. Picking up where we left off.
> Do you want to scaffold something new, or continue an existing project?

**Path J returning user (no Power Platform):**
If stored BUILD_PATH = J (or missing), and no PP signals detected:
> Welcome back! Ready to scaffold your next developer project?
(No path change dialog — this is the existing v1.6.0 flow, unchanged.)

Then skip to Step 2 (Confirm & Generate) with pre-populated answers from memory.
Only ask questions for information that's **missing** from memory — see Step 1 adaptive logic below.

**If no memory files exist (first-time user):**

Proceed to Step 1 as normal (the full greeting and wizard).

**If memory files exist but are corrupted or incomplete:**

Treat any readable data as valid context. For anything unreadable, fall back to asking the question. Never crash or abort because of bad memory — degrade gracefully and note the issue in the validation summary.

---

### Step 1 — Greet and Explain

**First-time users** (no memory found in Step 0):

Say exactly this (adjust tone for friendliness, keep the meaning):

> **Welcome to CopilotForge!** I'll ask you a few quick questions about your project, then scaffold a complete set of Copilot skills, agent definitions, memory files, and code recipes into this repo. Takes about two minutes. Let's go.

**Returning users** (memory found in Step 0):

Skip this greeting — the welcome-back summary from Step 0 replaces it. Proceed directly to the adaptive wizard questions below. Only ask questions whose answers are **missing** from memory.

### Step 1a — Run the Wizard (Adaptive)

Ask each question one at a time. Wait for the user's answer before asking the next. If the user gives a single block of answers covering multiple questions, accept them and move on.

**⚡ Interactive options rule:** For every question with fixed choices (Q3, Q4, Q5, Q6), present options as **numbered items** so the user can respond with just a number, a click, or a short word. Think interview, not form — keep it conversational. Inspired by the [plan-then-implement workflow](https://github.blog/engineering/copilot/build-a-personal-organization-command-center-with-github-copilot-cli/).

**For returning users:** Each question checks memory first. If the answer is already known, show it and ask for confirmation instead of asking from scratch. This makes re-runs fast — most questions become one-word confirmations.

**Question 1 — Project Description**

*If already in memory (from FORGE.md or decisions.md):*
> Your project: **{project description from memory}**
> Still accurate? *(yes / or tell me what's changed)*

*If not in memory:*
> What are you building? Describe your project in a sentence or two.
> *(Example: "A REST API for a pet adoption platform" or "A React dashboard for monitoring CI pipelines")*

---

**🔍 Path Detection — Silent Classifier (runs after Q1, before Q2)**

*This step runs silently after the user answers Q1. No output is shown unless a Power Platform signal is detected. Invoke `forge-compass` on the Q1 answer. Compass returns `detected_path` (A–J) and `confidence` (High / Medium / Low).*

**Routing:**

| Confidence | Condition | Action |
|---|---|---|
| High | PP path (A–I) detected | → Run PP Diagnostic below (replaces Q2–Q5) |
| Medium | PP path possible | → Ask one clarifying question, then route |
| Low | No PP signals, or Path J | → Proceed to Q2 silently — zero new text shown (D13-A) |
| Low | Exactly 1 partial PP keyword | → Ask ambiguous clarifier, then route |

**Path J rule (D13-A):** When confidence is Low and no clarifier is triggered, proceed directly to Q2. No new text, questions, or delays. Path J users must see no difference from v1.6.0.

**Medium confidence clarifier** *(ask once, then route — one question only)*:
> Just to confirm — are you building within Microsoft Power Platform?
> *(yes / no)*

- **yes** → Run PP Diagnostic
- **no** → Proceed to Q2 silently (Path J)

**Ambiguous Q1 clarifier** *(Low confidence + exactly 1 partial PP keyword in the Q1 answer)*:
> Quick check — are you working within Microsoft 365 / Power Platform? (yes / no)

- **yes** → Run PP Diagnostic
- **no** → Path J, proceed to Q2 silently

---

**PP Diagnostic — 3-Question Flow** *(replaces Q2–Q5 when a PP path is confirmed)*

*Only runs when Power Platform is confirmed. Path J users never reach this section.*

**PP-Q1:**
> Is this primarily no-code / low-code, or will you be writing TypeScript or C#?
> **1.** No-code / low-code *(studio tools, drag and drop)*
> **2.** TypeScript or C# *(you'll write and edit code)*

**PP-Q2:**
> Does your project need to connect to an outside service or REST API?
> **1.** Yes — I need a custom connection to an external service
> **2.** No — it stays within the platform

**PP-Q3:**
> What's the main thing you're building? Pick the closest match.
> **1.** 🤖 Agent — an AI that answers questions or takes actions
> **2.** 📊 Report — charts, dashboards, or data analysis
> **3.** 📱 App — a screen-based tool people interact with
> **4.** ⚡ Flow — an automated process or scheduled task
> **5.** 🌐 Page — a public-facing website or portal

**Path resolution from PP answers:**

| PP-Q1 | PP-Q2 | PP-Q3 | BUILD_PATH |
|---|---|---|---|
| TypeScript / C# | — | — | F |
| No-code | Yes (connector) | Any | B |
| No-code | No | Agent | A |
| No-code | No | Report | G |
| No-code | No | App | D |
| No-code | No | Flow | E |
| No-code | No | Page | I |

*If answers are ambiguous (e.g., the user says both Agent and App): use `detected_path` from compass as tiebreaker. Path A is the PP fallback when still unclear.*

**After the 3 questions, show:**
> 📍 You're on **Path [X] — [PATH_NAME]**. Here's what gets generated: [brief one-line list for this path]. Ready? *(yes / adjust)*

Wait for the user to confirm before proceeding. If they say "adjust," re-ask any of the 3 questions they want to change.

---

**Question 2 — Tech Stack**

*If already in memory (from patterns.md or FORGE.md):*
> Your stack: **{stack from memory}**
> Still using this stack? *(yes / or tell me what's changed)*

*If not in memory:*
> What's your stack? List languages, frameworks, and key tools.
> *(Example: "TypeScript, Next.js, Prisma, PostgreSQL" or "Python, FastAPI, SQLAlchemy")*

**If no config files are found** (`package.json`, `requirements.txt`, `go.mod`, `.csproj`, etc.) **and the user's answer is vague** ("I'm using Python" with no framework mentioned):
Ask: *"I couldn't detect your tech stack automatically from config files. What language or framework are you using?"* Accept any answer and use it as the stack. Note this in `decisions.md`.

**If the user's answer conflicts with detected config** (e.g., user says "Django" but `package.json` has Express):
Trust the user's answer but note both in `decisions.md`: "User specified Django; detected Express in package.json — user answer takes precedence."

**Question 3 — Memory**

*If memory files already exist:*
Skip this question entirely — memory is already enabled. Use `yes`.

*If no memory files exist:*
> Do you want memory across sessions? This creates `forge-memory/` files so agents remember decisions and patterns between conversations.

Call `ask_user` with these choices:
```
choices:
  - "✅ Yes — remember my decisions across sessions (recommended)"
  - "❌ No — start fresh every time"
```

If the user skips or says nothing, default to **yes** (first option).

**Question 4 — Test Automation**

*If already in memory (from preferences.md or FORGE.md settings):*
> Test automation is currently **{enabled/disabled}**.
> Keep this setting? *(yes / change)*

*If not in memory but test-related files exist* (e.g., `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `jest.config.*`, `pytest.ini`, `.github/skills/testing/`):
> I see you already have test files in this repo. I'll keep test automation **enabled**.
> *(Say "no" if you want to skip the tester agent and testing skill)*

*If not in memory and no test files found:*
> Do you want test automation? This generates a tester agent and testing skill with conventions for your stack.

Call `ask_user` with these choices:
```
choices:
  - "✅ Yes — set up testing for my stack (recommended)"
  - "❌ No — skip test automation"
```

If the user skips or says nothing, default to **yes** (first option).

**Question 5 — Skill Level**

*If already in memory (from preferences.md):*
> Your verbosity level is set to **{level from memory}**.
> Keep this? *(yes / change)*

*If not in memory:*
> What's your experience level? This controls how much detail appears in generated files.

Call `ask_user` with these choices:
```
choices:
  - "🟢 Beginner — extra comments, explanations in every file (recommended for first-timers)"
  - "🟡 Intermediate — standard detail, assumes you know your stack"
  - "🔴 Advanced — minimal comments, just the essentials"
```

If the user skips or says nothing, default to **beginner** (first option).

**Question 6 — Extras**

*If already in memory (from preferences.md):*
> Your current extras: **{list from memory}**
> Want to change these? *(yes / no — or name specific additions/removals)*

*If not in memory:*

**Present extras using the `ask_user` tool so the user sees clickable buttons — do NOT show a typed numbered list.**

If the user's experience level is **beginner**, say first:
> "These extras are all optional — most beginners skip them and add things later. The core setup works great on its own! Click anything that sounds useful, or click **'Skip — start simple'**."

Then call `ask_user` with these choices (in this exact order, so "Skip" is always first for beginners):

```
choices:
  - "⏭️ Skip — start simple (you can add extras anytime)"
  - "🔄 Task automation — AI writes a step-by-step plan and builds it for you"
  - "🧪 Auto-experiments — AI tries code changes, runs tests, keeps what works"
  - "📚 Knowledge wiki — drop in notes and articles, get a searchable reference"
  - "🔗 CLI hooks — auto-logging and safety checks during AI sessions"
  - "✍️ Blog / docs writer — turns your pull requests into blog posts"
  - "📋 Template factory — auto-generates READMEs, issue templates, project docs"
  - "📊 PR dashboard — live charts of open PRs, reviewers, and age"
  - "🏠 Command center — terminal dashboard showing your project at a glance"
  - "🏗️ Copilot Studio — build enterprise agents (requires Power Platform)"
  - "💻 Code Apps — Power Apps with React/TypeScript (requires Power Platform)"
  - "🧩 Custom agents — .agent.md profiles for GitHub Copilot"
  - "✅ Done — I've made my selections, continue"
```

**Multi-select behavior — repeat until done:**
1. If the user clicks **"Skip — start simple"** → record extras = none, continue to Step 2
2. If the user clicks **"Done — I've made my selections, continue"** → summarize selections, continue to Step 2
3. For any other click → acknowledge and track: *"✅ Added **{item}**! Selected so far: {running list}. Click more extras or click **Done** to continue."* Then call `ask_user` again, removing already-selected items from the choices (always keep "Done" as an option)
4. If the user types a number or name → accept it as a selection and continue the multi-select loop

**Default suggestions by experience level:**
- **beginner** → "Skip" is shown first; say the reassurance message above before showing choices
- **intermediate** → Highlight before showing choices: *"I'd suggest **Task automation** and **Command center** — they pair well with most projects. Click to add them, or skip."*
- **advanced** → Highlight before showing choices: *"Popular picks: **Task automation**, **Auto-experiments**, and **Custom agents**. Click to add or pick your own."*

If the user skips or says nothing, default to **none** (no extras).

### Step 2 — Confirm Before Scaffolding

After collecting all answers, present a summary and ask for confirmation:

> **Here's what I'll create:**
>
> - **Project:** {answer to Q1}
> - **Stack:** {answer to Q2}
> - **Memory:** {yes/no}
> - **Test automation:** {yes/no}
> - **Verbosity:** {beginner/intermediate/advanced}
> - **Extras:** {list of selected extras, or "none"}
> - **Implementation plan:** {X tasks in IMPLEMENTATION_PLAN.md} *(only if task automation selected)*
>
> I'll generate skills, agents, memory files, cookbook recipes, {and selected extras, }and a FORGE.md control panel. Ready to go?

Wait for confirmation. If the user says "change X," adjust and re-confirm. Do not scaffold until the user confirms.

> **📍 Path detection (v1.6.0 — implemented):** Path detection runs silently after Q1 (see the Path Detection section in Step 1a above). `BUILD_PATH`, `PATH_NAME`, `EXTENSION_REQUIRED`, and `MS_LEARN_ANCHOR` are resolved there, then written to FORGE-CONTEXT at the start of Step 3. All fields are optional — if absent, Path J (Developer Project) behavior applies unchanged.

### Step 3 — Scaffold the Project

Create all files described below. Use the user's answers to customize content. Every generated file must be valid markdown (or valid code for cookbook recipes).

---

#### 3a. FORGE-CONTEXT Write — path-awareness fields

Before generating any other files, write the following path-awareness fields to the FORGE-CONTEXT block. These fields are read by all specialist agents.

```
build_path: {A–J — resolved from path detection after Q1; default J if unresolved}
path_name: {human-readable label — e.g., "Copilot Studio Agent" or "Developer Project"}
extension_required: {true for paths B and F; false for all others}
ms_learn_anchor: {primary MS Learn URL for this path, or null}
```

**MS Learn anchors by path:**

| Path | Label | ms_learn_anchor |
|---|---|---|
| A | Copilot Studio Agent | https://learn.microsoft.com/en-us/microsoft-copilot-studio/ |
| B | Studio + Connector | https://learn.microsoft.com/en-us/connectors/custom-connectors/ |
| C | Declarative Agent | https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/ |
| D | Canvas App Agent | https://learn.microsoft.com/en-us/power-apps/maker/canvas-apps/ |
| E | Power Automate | https://learn.microsoft.com/en-us/power-automate/ |
| F | PCF Code Component | https://learn.microsoft.com/en-us/power-apps/developer/component-framework/ |
| G | Power BI | https://learn.microsoft.com/en-us/power-bi/ |
| H | SharePoint / Teams | https://learn.microsoft.com/en-us/sharepoint/ |
| I | Power Pages | https://learn.microsoft.com/en-us/power-pages/ |
| J | Developer Project | null |

All four fields are optional. Specialists must treat a missing `BUILD_PATH` as equivalent to `J`.

Also write `BUILD_PATH` to `forge-memory/preferences.md` if it is not already stored there, or if it changed from the stored value (user chose a new path).

---

#### 3b. Skills — `.github/skills/`

Generate SKILL.md files based on the project description and stack. At minimum, create:

1. **A project-conventions skill** at `.github/skills/{project-slug}-conventions/SKILL.md`
   - Frontmatter: name, description, domain ("project-conventions"), confidence ("medium"), source ("generated by CopilotForge")
   - Sections: Context, Patterns (error handling, file structure, naming conventions based on the stack), Examples, Anti-Patterns
   - Populate patterns with stack-appropriate conventions (e.g., for TypeScript: strict mode, path aliases; for Python: type hints, virtual envs)

2. **A code-review skill** at `.github/skills/code-review/SKILL.md`
   - Triggers: "review this", "check my code", "code review"
   - Instructions for reviewing PRs/code changes with stack-specific linting rules
   - Include the stack's common pitfalls as review checkpoints

3. **If test automation = yes:** A testing skill at `.github/skills/testing/SKILL.md`
   - Triggers: "write tests", "test this", "add test coverage"
   - Instructions for the stack's test framework (Jest for TS/JS, pytest for Python, etc.)
   - Patterns for test file naming, assertion style, mocking

Each generated SKILL.md must follow this format:

```markdown
---
name: "{skill-name}"
description: "{what it does}"
domain: "{domain}"
confidence: "medium"
source: "generated by CopilotForge"
---

## Context

{Why this skill exists and when it applies.}

## Patterns

### {Pattern Name}
{Description of the pattern.}

## Examples

{Concrete examples showing correct usage.}

## Anti-Patterns

- {Thing to avoid} — {Why it's bad.}
```

---

#### 3c. Agents — `.copilot/agents/`

Generate agent definition files. At minimum:

1. **planner.md** — Self-reference to this skill. Role: orchestrator. Scope: project scaffolding, skill generation, structure decisions.

2. **reviewer.md** — Code reviewer agent. Role: quality gate. Scope: PR review, convention enforcement, stack-specific lint rules. System prompt must reference the code-review skill.

3. **If test automation = yes:** **tester.md** — Test author agent. Role: test coverage. Scope: writing tests, identifying edge cases, maintaining test conventions. System prompt must reference the testing skill.

Each agent file must follow this format:

```markdown
# {Agent Name}

## Role
{One sentence: what this agent does.}

## Scope
{Bullet list of what this agent owns.}

## System Prompt
{The actual system prompt the agent uses. Write this as executable instructions — another LLM should be able to follow it verbatim.}

## Interaction Style

Experience level: {beginner|intermediate|advanced} *(from Question 5)*

**How this affects every response:**
- **beginner**: Explain WHY before WHAT. Show examples for non-obvious code. Define technical terms on first use. When suggesting a fix, explain what the original problem was. Use encouraging tone.
- **intermediate**: Standard explanations. Skip basic concepts. Focus on the reasoning behind decisions.
- **advanced**: Terse and direct. Code over prose. Only explain non-obvious architectural decisions.

This setting persists across sessions — it's not just for generated files. Every time this agent responds, it adjusts its communication style to match the user's level.

## Boundaries
- **I handle:** {list}
- **I don't handle:** {list}

## Escalation

When a request falls outside this agent's scope:
- Say: "This is outside my area — the **{other agent}** agent handles {topic}. Ask: '{trigger phrase}'"
- Never attempt work that belongs to another agent
- Common handoffs:
  - Code quality questions → **reviewer** agent
  - Test-related questions → **tester** agent
  - Project setup or new skills → **planner** agent
  - Building from a plan → say "run the plan" to trigger the plan executor

## Skills
- {skill-name} — {why this agent uses it}
```

**Important:** The Interaction Style section is NOT just for generation — it must be respected in ALL ongoing interactions. A beginner-mode reviewer explains *why* something is wrong and suggests the fix. An advanced-mode reviewer just flags the issue. This is what makes CopilotForge feel personalized beyond day one.

---

#### 3d. Memory — `forge-memory/`

**If memory = yes**, create:

1. **decisions.md**

```markdown
# Forge Decisions

Decisions made during project setup and ongoing development. Append new decisions — never delete old ones.

## Setup Decisions

### {today's date}: Initial scaffolding
**What:** CopilotForge generated the initial project structure.
**Why:** User requested scaffolding for: {project description}
**Stack:** {stack}
**Options enabled:** Memory: {yes/no}, Testing: {yes/no}
```

2. **patterns.md**

```markdown
# Forge Patterns

Reusable conventions for this project. Updated as the team learns what works.

## Stack Conventions

{Stack-specific patterns derived from Q2. For example:}
{- TypeScript: strict mode, path aliases, barrel exports}
{- Python: type hints, virtual envs, pyproject.toml}

## File Structure

{Describe the expected project layout based on the stack.}
```

**If memory = no**, skip this step entirely. Do not create the `forge-memory/` directory.

---

#### 3e. Cookbook — `cookbook/`

Generate code recipes based on the project's detected stack. Recipes are copy-paste-ready code files with comments explaining what they do. The cookbook auto-selects recipes based on the frameworks and packages found in your project — the more specific your stack, the more targeted the recipes.

**Recipe categories** — each category has stack-specific variants:

| Category | What it teaches | Example stacks |
|---|---|---|
| Error handling | Try/catch patterns, custom error types, graceful failures | All languages |
| MCP integration | Building an MCP server with tool definitions for the Copilot ecosystem | TypeScript, Python |
| API client | HTTP client with auth, retry, typed responses | All languages |
| Auth patterns | Middleware for authentication and authorization | All languages |
| Database | ORM query patterns — CRUD, transactions, error handling | Prisma, SQLAlchemy, GORM, EF Core |
| Component scaffold | Typed UI component with props and common patterns | React, Blazor |
| Route handler | Web route with validation, middleware, error responses | Express, FastAPI, net/http, ASP.NET |
| Task automation | Autonomous dev loop — works through a TODO list, commits each task | All languages |
| Auto-experiments | Autonomous optimization — tries changes, measures results, keeps improvements | All languages |
| Knowledge wiki | Personal wiki builder — ingest sources, search, lint, cross-reference | TypeScript, Python |
| CLI hooks | Copilot CLI session hooks — logging, safety checks, audit trails | TypeScript, Python |
| Blog writer | PR-to-blog pipeline — reads code changes, writes blog posts | TypeScript, Python |
| Template factory | Document generator — README, issue templates, project docs | TypeScript, Python |
| PR dashboard | Pull request analytics — charts, age tracking, reviewer stats | TypeScript, Python |
| Copilot Studio | Enterprise agent builder — clone, edit YAML, sync to Copilot Studio | Guide + YAML example |
| Code Apps | Power Apps with React/TypeScript — scaffold, connect, publish | TypeScript + Guide |
| Custom agents | GitHub Copilot `.agent.md` profiles — tools, MCP, specialized prompts | Guide + Example |

**How recipes are selected:**

Recipes are auto-selected based on what's detected in your project:
- If you have `package.json` with Express → you get an Express route handler recipe
- If you have `requirements.txt` with FastAPI and SQLAlchemy → you get both a FastAPI route and a SQLAlchemy database recipe
- If you have MCP-related packages → you get an MCP server recipe (high-value for Copilot workflows)
- You always get an error handling recipe and an API client recipe for your primary language

The goal is: every recipe matches something you actually use. No generic filler.

**Extras-based selection:** If the user selected extras in Question 6, include the corresponding recipe files:
- Task automation → `task-loop.{ext}`
- Auto-experiments → `auto-research.{ext}`
- Knowledge wiki → `knowledge-wiki.{ext}`
- CLI hooks → `copilot-hooks.{ext}`
- Blog writer → `blog-writer.{ext}`
- Template factory → `template-creator.{ext}`
- PR dashboard → `pr-visualization.{ext}`
- Command center → `command-center.{ext}`
- Copilot Studio → `copilot-studio-guide.md` + `copilot-studio-agent.yaml`
- Code Apps → `code-apps-guide.md` + `code-apps-setup.ts`
- Custom agents → `copilot-agents-guide.md` + `copilot-agents-example.agent.md`

Extras recipes are only generated if explicitly selected. They are never auto-included.

Always generate `cookbook/README.md` listing all recipes with one-line descriptions.

The cookbook section in FORGE.md is tracked between `<!-- forge:cookbook-start -->` and `<!-- forge:cookbook-end -->` markers. On re-runs, new recipes are added without removing existing ones.

Adjust verbosity based on skill level:
- **beginner**: Heavy comments explaining every section
- **intermediate**: Comments on non-obvious parts only
- **advanced**: Minimal comments, just the code

---

#### 3f. Planning Mode — `IMPLEMENTATION_PLAN.md`

**If the user selected "Task automation" in Q6**, generate an `IMPLEMENTATION_PLAN.md` at the project root. This file is consumed by the task-loop recipe — the AI reads it, picks the next pending task, implements it, commits, and moves to the next.

**Generate the plan FROM the user's answers.** Use Q1 (project description), Q2 (stack), and Q3-Q5 (preferences) to create a realistic, ordered list of implementation tasks. Each task should be:
- Small enough to implement in one focused step
- Ordered by dependency (setup first, features next, polish last)
- Named with kebab-case IDs that describe what gets built

**Format:**

```
# Implementation Plan
#
# Generated by CopilotForge from your project description.
# The task-loop recipe reads this file and works through tasks autonomously.
#
# Task format: - [ ] task-id — Task title
# Markers:     [ ] = pending, [x] = done, [!] = failed
#
# To run: Open your AI assistant and say "run the plan" or use the task-loop recipe.

- [ ] task-id — Task title
- [ ] task-id — Task title
...
```

**Example — for "A REST API for a pet adoption platform" with "TypeScript, Express, Prisma":**

```
# Implementation Plan

- [ ] init-project — Initialize TypeScript project with tsconfig.json and package.json
- [ ] setup-express — Create Express server with health check endpoint
- [ ] setup-prisma — Configure Prisma with PostgreSQL schema for pets, adopters, applications
- [ ] create-models — Define Prisma models: Pet, Adopter, Application with relationships
- [ ] seed-data — Create seed script with sample pets and adopters
- [ ] pet-routes — Create CRUD route handlers for /api/pets
- [ ] adopter-routes — Create CRUD route handlers for /api/adopters
- [ ] application-routes — Create routes for adoption applications with status workflow
- [ ] add-validation — Add request validation with Zod schemas
- [ ] add-auth — Add JWT authentication middleware
- [ ] add-error-handling — Add centralized error handler with typed error responses
- [ ] add-tests — Write Jest test suite for all route handlers
```

**Guidelines for plan generation:**
- Start with project setup tasks (init, config, dependencies)
- Then data layer (models, schema, migrations, seed data)
- Then API/UI layer (routes, components, pages)
- Then cross-cutting concerns (auth, validation, error handling)
- End with quality tasks (tests, docs, linting)
- 8-15 tasks is ideal. Too few = not useful. Too many = overwhelming.
- Each task title should be clear enough that an AI can implement it without more context
- Include the stack-specific tools in task titles (e.g., "Prisma" not just "database")

**Also generate `cookbook/task-loop.{ext}`** (the recipe file for the user's stack) if not already present. The task-loop recipe reads IMPLEMENTATION_PLAN.md and executes tasks autonomously.

**After generating the plan, tell the user:**

> ✅ Plan created with {N} tasks in `IMPLEMENTATION_PLAN.md`. Say **"run the plan"** to start executing tasks autonomously, or review the plan first and edit any tasks you want to change.

**If the user did NOT select "Task automation"**, skip this step entirely. Do not generate IMPLEMENTATION_PLAN.md.

---

#### 3g. FORGE.md — Control Panel

Create `FORGE.md` at the repo root. This is the human-readable dashboard. Format:

```markdown
# 🔧 FORGE.md — CopilotForge Control Panel

> Edit this file to customize your CopilotForge setup. This is your project's AI configuration dashboard.

## Project

- **Description:** {Q1 answer}
- **Stack:** {Q2 answer}
- **Memory:** {enabled/disabled}
- **Test automation:** {enabled/disabled}
- **Verbosity:** {beginner/intermediate/advanced}

## Skills

| Skill | Path | Purpose |
|---|---|---|
| {name} | `.github/skills/{name}/SKILL.md` | {one-line purpose} |

## Agents

| Agent | Path | Role |
|---|---|---|
| {name} | `.copilot/agents/{name}.md` | {one-line role} |

## Cookbook Recipes

| Recipe | Path | Description |
|---|---|---|
| {name} | `cookbook/{file}` | {one-line description} |

## Memory

| File | Purpose |
|---|---|
| `forge-memory/decisions.md` | Architectural decisions log |
| `forge-memory/patterns.md` | Reusable project conventions |
| `forge-memory/preferences.md` | Your settings and overrides |
| `forge-memory/history.md` | Session activity log |

## What's Next

- [ ] Review generated skills and customize patterns for your codebase
- [ ] Try: "Review this code" to test the code-review skill
- [ ] Try: "Write tests for {module}" to test the testing skill
- [ ] Edit this file to add or remove skills and agents
```

---

### Step 4 — Validation Summary

After all files are created, print a plain-English summary of everything that was generated. Format:

> **✅ CopilotForge scaffolding complete!**
>
> I created:
> - **{N} skills** — {list names with one-line descriptions}
> - **{N} agents** — {list names with one-line descriptions}
> - **{N} cookbook recipes** — {list names}
> - **{N} extras** — {list names, or "none selected"}
> - **{N} memory files** — decisions.md, patterns.md, preferences.md, history.md
> - **1 control panel** — FORGE.md
>
> **What each file does:**
> {Brief description of each generated file — one line each}
>
> **Start here:** Open `FORGE.md` to see your full setup. Edit it anytime to add or remove skills.

---

### Step 5 — Start Building

After the validation summary, output a build-transition prompt. This bridges "I described my project" → "now build it" — especially helpful for beginners who just finished the wizard and aren't sure what to do next.

Customize the prompt using the user's actual wizard answers:
- Replace `{project type}` with the type of project from Q1 (e.g., "REST API," "React dashboard," "CLI tool")
- Replace `{stack}` with the Q2 answer (e.g., "TypeScript, Next.js, Prisma")
- Replace `{first feature or goal}` with the primary goal extracted from Q1 (e.g., "the pet adoption endpoints," "the CI monitoring dashboard")

Output this as the very last thing the wizard shows:

> ---
>
> ## 🚀 Ready to Build!
>
> Your project is set up. Here's a prompt you can copy and paste to start building:
>
> ---
>
> **Copy this prompt and give it to your AI assistant:**
>
> > I have a {project type} project using {stack}. The project structure is already
> > scaffolded — see FORGE.md for the team configuration and forge-memory/ for
> > context. Start by reading FORGE.md, then help me build {first feature or goal
> > from Question 1}.
>
> ---
>
> Or just say: **"Read FORGE.md and let's start building."**
>
> 💡 **Tip:** Your AI assistant will read FORGE.md and forge-memory/ to understand
> your project's conventions, team setup, and goals — no need to re-explain anything.

The copy-paste prompt references FORGE.md and forge-memory/ — the artifacts the wizard just created. The one-liner alternative is for users who want to keep it simple. Both work because the AI assistant reads the project's memory files to understand context automatically.

---

### Ongoing — Conversational Cookbook

When this skill is active, listen for recipe requests during any conversation:

**Trigger phrases:**
- "I need error handling" / "show me error handling"
- "forge recipe: {name}" / "recipe: {name}"
- "how do I do {concept}?"
- "show me the {name} recipe"

**Action:** Look up the matching recipe from `cookbook/` and present it in-context. Don't just give the file path — show the actual code with explanation.

**Recipe mapping** (concept → file):
| User says | Recipe file | What it does |
|---|---|---|
| "error handling" | `cookbook/hello-world.{ext}` | Basic error handling patterns |
| "task loop" / "autonomous" | `cookbook/task-loop.{ext}` | Autonomous task execution |
| "auto experiments" / "research" | `cookbook/auto-research.{ext}` | Automated experimentation |
| "knowledge wiki" | `cookbook/knowledge-wiki.{ext}` | Personal knowledge base |
| "CLI hooks" | `cookbook/copilot-hooks.{ext}` | Session hooks and logging |
| "blog" / "blog writer" | `cookbook/blog-writer.{ext}` | PR-to-blog pipeline |
| "templates" / "readme" | `cookbook/template-creator.{ext}` | Document generation |
| "dashboard" / "PR dashboard" | `cookbook/pr-visualization.{ext}` | PR analytics |
| "command center" | `cookbook/command-center.{ext}` | Terminal dashboard |
| "Copilot Studio" | `cookbook/copilot-studio-guide.md` | Enterprise agent building |
| "code apps" / "Power Apps" | `cookbook/code-apps-guide.md` | React/TS Power Apps |
| "custom agents" / "agent.md" | `cookbook/copilot-agents-guide.md` | GitHub Copilot agents |

**For recipes that don't exist yet:** If the user asks for a recipe that wasn't generated during setup, offer to create it:
> That recipe wasn't included in your initial setup. Want me to generate it now? I'll create `cookbook/{name}.{ext}` with patterns for your {stack} project.

**Use the right file extension:** Check `forge-memory/patterns.md` or `FORGE.md` for the user's stack to determine `.ts`, `.py`, `.go`, etc.

---

### Ongoing — Memory Feedback Loop

CopilotForge isn't just a one-time generator. During any session where this skill is active, listen for memory-writing triggers:

**Explicit triggers:** If the user says any of these, write the decision to `forge-memory/decisions.md`:
- "remember that..." / "forge remember: ..."
- "let's use X from now on"
- "we decided to..."
- "going forward, always..."

**Format for writing decisions:**
```
### {today's date}: {brief title}
**What:** {the decision or convention}
**Why:** {context — why was this chosen?}
```

**Auto-capture:** If you make a significant architectural decision during a session (naming convention, library choice, folder structure), proactively suggest writing it to memory:
> 💡 I just decided to {decision}. Want me to save this to `forge-memory/decisions.md` so I remember it next time?

If the user agrees (or if they previously said "always remember decisions"), append it.

**Pattern capture:** If a code pattern is used 3+ times in a session, suggest adding it to `forge-memory/patterns.md`:
> 💡 I've used the same {pattern description} pattern three times now. Want me to add it to `forge-memory/patterns.md` as a project convention?

This closes the feedback loop: wizard → files → AI → **back to memory** → smarter next session.

---

## Portability

This skill works in:
- **VS Code GitHub Copilot** — place in `.github/skills/planner/SKILL.md`
- **Claude Code** — paste the Instructions section (Steps 0–5) as a prompt
- **Any LLM** — copy Steps 0–5 into a chat session

No CLI, no dependencies, no lock-in. It's just markdown instructions that any language model can execute.

## Anti-Patterns

- ❌ Scaffolding before the user confirms the summary (Step 2)
- ❌ Skipping questions without checking memory first — always either ask or confirm from memory
- ❌ Ignoring memory files when they exist — always read them before starting the wizard
- ❌ Generating empty or placeholder files — every file must have real, usable content
- ❌ Hardcoding a single stack — recipes and conventions must adapt to the user's answers
- ❌ Creating `forge-memory/` when the user said no to memory
- ❌ Using jargon without explanation when skill level is "beginner"
- ❌ Generating agent files that reference skills which don't exist
- ❌ Forgetting the validation summary — the user needs to know what was created
- ❌ Skipping the build-transition prompt — the user needs a clear next step after scaffolding
