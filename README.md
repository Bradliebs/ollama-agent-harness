---
title: Ollama Agent Harness
description: Local-first Ollama agent harness with tools, tracing, learning, multimodal helpers, and a browser UI
author: Bradliebs
ms.date: 2026-05-02
ms.topic: overview
keywords:
  - ollama
  - agent
  - local-first
  - multimodal
estimated_reading_time: 5
---

[![CI](https://github.com/Bradliebs/ollama-agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Bradliebs/ollama-agent-harness/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bradliebs/ollama-agent-harness)](https://github.com/Bradliebs/ollama-agent-harness/releases/latest)

## What is this?

Ollama Agent Harness is a local-first agent runtime that wraps Ollama models with a browser UI, tool dispatch, permissions, session management, and learning infrastructure. Everything runs on your machine. No cloud accounts, no API keys beyond Ollama itself.

You chat with a model, it can call tools (read/write files, run bash, search the web, analyze images, transcribe audio), and the harness manages permissions, context, and history.

## Quick start

### Prerequisites

* [Node.js](https://nodejs.org/) 18+
* [Ollama](https://ollama.com/) running locally with at least one model pulled (e.g. `ollama pull llama3.2`)

### Install and run

```powershell
npm install
npm run ui
```

Open the URL printed by the server (default `http://127.0.0.1:3000`, or `http://127.0.0.1:4000` via `start.bat`). That is the full UI. Start chatting in the main panel.

### CLI mode

```powershell
npm run start -- -p "Summarize the project" --model llama3.2
```

Run `npm run start -- --help` for all CLI flags including `--mode`, `--max-turns`, `--validate-output`, and helper model routing.

### Validation

```powershell
npm run typecheck
npm test -- --runInBand
```

With the UI server running, smoke-test the browser:

```powershell
npm run smoke:ui -- http://127.0.0.1:3000/
```

For local timeout checks against a real Ollama model, run the optional
long-prompt smoke after building:

```powershell
npm run build
npm run smoke:long-prompt
```

Override the model, host, prompt size, timeout, or context window with
`HARNESS_LONG_PROMPT_MODEL`, `OLLAMA_HOST`, `HARNESS_LONG_PROMPT_LINES`,
`HARNESS_LONG_PROMPT_TIMEOUT_MS`, and `HARNESS_LONG_PROMPT_NUM_CTX`.

## UI tabs

The browser UI has 13 tabs in the left sidebar:

| Tab | What it does |
|-----|-------------|
| 💬 **Chats** | Chat history, new/export sessions |
| 📁 **Files** | Browse and read project files |
| ⚡ **Skills** | Runtime and repo skill libraries, skill curator, install/scaffold actions |
| 🧠 **Memory** | Agent memory entries per session |
| 🏛 **Palace** | Memory palace browser (semantic memory) |
| 🔮 **Discover** | Discovered patterns and learning candidates |
| 📈 **Learning** | Eval trace runs, output validation trends, learning datasets |
| 📦 **Snaps** | Skill and memory snapshots for backup/restore |
| 🔎 **RAG** | Local vector index over chosen files with search and rebuild |
| 🛠 **Tools** | Tool registry with risk badges, permissions, kill switch, capability grants, shell presets |
| 📜 **Runs** | Session list, automation jobs, run history, scheduler status |
| ⚙ **Flows** | Declarative tool-call workflows (YAML/JSON under `.harness/workflows/`) |
| 🍄 **Mycelium** | Adaptive context routing network — nodes, edges, episodes |

The right side has a **Settings** panel for Ollama host, generation parameters, model routing, media tools, output validation, and safety mode. Settings are saved to `.harness/settings.json`.

## Key concepts

### Tools

Built-in tools include `file_read`, `file_write`, `file_edit`, `bash`, `list_files`, `web_fetch`, `web_search`, `web_read`, `image_analyze`, `audio_transcribe`, `create_skill`, `install_skill`, `desktop_screenshot`, `browser_bookmarks`, `email_draft`, `calendar_read`, and more. Each tool has a risk level (low/medium/high) and can be individually disabled from the Tools tab.

### Permissions

Three permission modes control tool execution:

* **default** — prompts for confirmation on medium/high-risk tool calls
* **acceptEdits** — auto-approves file edits, prompts for everything else
* **dontAsk** — auto-approves everything (use with caution)

The **kill switch** (Tools tab or Ctrl+Shift+K) blocks all tool calls until released.

### Capability grants

High-risk surfaces (shell execution, background jobs, self-modifying code) require explicit time-limited grants with required controls before they can be used. Create and revoke grants from the Tools tab. All grant lifecycle events (created, revoked, expired) are recorded in `.harness/capabilities/audit.jsonl`.

Capabilities are classified by posture:

* **available** — usable without a grant
* **gated** — requires an explicit grant with required controls
* **design-only** — connector not yet implemented
* **blocked** — denied by default, no grant path

### Shell command allowlist

When a background automation job needs to run a shell command, it must have active `arbitrary-shell` and `background-autonomous-jobs` grants AND match a command allowlist preset. Four presets are built in:

* **git-read-status** — `git status`, `git diff --stat`, `git log --oneline`
* **file-discovery** — `dir`, `rg --files`, `Get-ChildItem` (rejects `..` path traversal)
* **tool-version** — `node --version`, `npm --version`, `git --version`
* **project-validation** — `npm run typecheck`, `npm run build`, `npm run smoke:ui`

Commands that do not match a preset are denied even with active grants.

### Skills

Skills are structured prompts that teach the model domain-specific tasks. They live in `.harness/skills/` (runtime) and `.github/skills/` (repo). The **Skill Curator** optionally archives stale skills and proposes merges.

### Sessions and context

Chat sessions persist under `.harness/sessions/`. Context continuity detects model context length and manages conversation history. Sessions can be forked and resumed.

### Output validation

Optional deterministic checks on the model's final answer. Built-in profiles: `oracle-prime`, `factual-answer`, `coding-answer`, `tool-result-summary`. Custom profiles can be authored from Settings or `.harness/output-validation-profiles.json`. See [VALIDATION-PROFILES.md](docs/VALIDATION-PROFILES.md) for the full reference.

### Media tools

* **Image analysis** — configure a vision model in Settings or with `HARNESS_VISION_MODEL`
* **Audio transcription** — configure a transcription command in Settings or with `HARNESS_AUDIO_TRANSCRIBE_COMMAND`

### Agent identity

Give your agent a name, avatar emoji, and personality. Presets include professional, friendly, concise, mentor, creative, and pirate. Save multiple profiles and switch between them. The agent name appears in chat bubbles, the topbar, and session history.

### Full Autonomy mode

Click **⚡ Full Autonomy** in Settings to set `dontAsk` mode and enable all tools in one click. All 9 gated capabilities auto-grant for 8 hours. Kill switch (Ctrl+Shift+K) remains the emergency stop.

### Mycelium context router

An adaptive graph system that learns which combinations of tools, skills, and memories work best for different queries. The network reinforces successful routes and decays unused ones. View the graph in the 🍄 Mycelium tab.

### Automation

Schedule recurring jobs with optional shell commands. Create, edit, toggle, and delete jobs from the Runs tab. The automation scheduler runs due jobs when the system is idle, respecting kill switch and capability grants. Run history with output viewing is available in the Runs tab.

## Project structure

```text
src/            TypeScript source (core, tools, web server, permissions, automation, learning)
ui/             Browser UI (index.html, app.js, chatHistory.js)
docs/           Additional guides (MODEL-PRESETS, VALIDATION-PROFILES, GETTING-STARTED)
cookbook/        Code examples and integration guides
scripts/        Build, smoke, and release scripts
.harness/       Runtime state (settings, sessions, skills, memory, automations) — gitignored
```

## Storage

All runtime state goes under `.harness/` in your project directory:

| Path | Contents |
|------|----------|
| `.harness/settings.json` | Server and UI configuration |
| `.harness/sessions/` | Chat session transcripts |
| `.harness/skills/` | Runtime skill definitions |
| `.harness/memory/` | Agent memory entries |
| `.harness/capabilities/audit.jsonl` | Grant and automation audit log |
| `.harness/automations/` | Scheduled job definitions and output |
| `.harness/curator/` | Skill curator log and merge proposals |
| `.harness/workflows/` | Declarative workflow definitions |
| `.harness/mycelium/` | Adaptive routing graph |
| `.harness/desktop/` | Desktop screenshots |
| `.harness/email/drafts/` | Email draft files |

## More information

* **[START-HERE.md](START-HERE.md)** — complete beginner guide (install Node.js, install Ollama, first chat)
* [Model presets guide](docs/MODEL-PRESETS.md) — beginner-friendly model recommendations
* [Validation profiles](docs/VALIDATION-PROFILES.md) — output validation reference
* [Mycelium router](docs/MYCELIUM-ROUTER.md) — adaptive context routing reference
* [GitHub Releases](https://github.com/Bradliebs/ollama-agent-harness/releases/latest) — download the latest release
