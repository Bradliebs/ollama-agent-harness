# 🌅 Apex-class autonomous experiences

Apex-class features are end-to-end autonomous experiences composed entirely from existing harness primitives — task store, RAG index, daily brief, triggers, web tools, semantic memory. None of them invent a new runtime; each one is a thin orchestration layer that turns a single user gesture (a slash command, a kanban drag, a one-line CLI invocation) into a multi-step result. The six capabilities below ship together and share the same "compose, don't replace" philosophy.

---

## 1. `/goal` — natural-language goal expander

### What it does
Takes a single high-level intent like *"Build a wiki from D:\big.pdf"* and expands it into a chaptered list of plan tasks (each tagged with `kind: code | research | external`) appended to `IMPLEMENTATION_PLAN.md`. The next iteration of the autonomy loop picks the tasks up automatically. Works as a chat slash-command **and** as a CLI.

### How to use
```powershell
# Chat (in the harness UI)
/goal Build a wiki from D:\big.pdf
/goal --dry Research https://acme.example.com tech stack

# CLI
node scripts\goal.js "Build a wiki from D:\big.pdf"
node scripts\goal.js --dry "Research https://acme.example.com tech stack"
node scripts\goal.js --plan custom-plan.md "Set up a 9am morning prompt"
```

`--dry` prints the proposed tasks without touching the plan file.

### What it builds on
- [`src/services/goalExpander.ts`](../src/services/goalExpander.ts) — intent → `PlanTask[]` + Markdown renderer
- [`src/services/goalSlashCommand.ts`](../src/services/goalSlashCommand.ts) — `/goal` chat handler
- [`scripts/goal.js`](../scripts/goal.js) — CLI wrapper

---

## 2. PDF → wiki blueprint

### What it does
Point it at a PDF and walk away. The blueprint extracts page-tagged text, splits it into chapters, writes one HTML page per chapter, builds a RAG index over the chapter pages, and emits a self-contained `chat.html` page that queries the index via `/api/rag/search`. Idempotent — re-running over the same PDF overwrites in place without duplicating.

### How to use
```powershell
# One-shot from a PDF on disk
npx ts-node cookbook\blueprint-pdf-to-wiki.ts .\big.pdf .\out

# Then open the wiki + RAG-backed mini chat in your browser
start .\out\index.html
start .\out\chat.html
```

### What it builds on
- [`cookbook/blueprint-pdf-to-wiki.ts`](../cookbook/blueprint-pdf-to-wiki.ts) — extract → chapter → render → index pipeline
- `src/tools/pdfTool.ts` (`extractPdfText`) and `src/persistence/ragIndex.ts` (`build` / `search`)

---

## 3. Kanban bridge (triage / doing / done)

### What it does
Maps every entry in the task store to a three-column Kanban view — **triage**, **doing**, **done** — using explicit `kanban:*` tags with a status-based fallback. Moving a card *into* triage auto-promotes that task into `IMPLEMENTATION_PLAN.md` (deduped by id, with `kind:` inferred from tags) so the autonomy loop picks it up on the next iteration.

### How to use
```powershell
# Read the current board
curl http://127.0.0.1:4300/api/kanban/board

# Move a card to triage (also promotes it into the plan)
curl -X POST http://127.0.0.1:4300/api/kanban/move `
  -H "Content-Type: application/json" `
  -d "{\"taskId\":\"my-task-id\",\"column\":\"triage\"}"
```

Cards already carrying `kind:code`, `kind:research`, or `kind:external` keep that contract when promoted.

### What it builds on
- [`src/services/kanbanBridge.ts`](../src/services/kanbanBridge.ts) — `taskToColumn`, `groupTasksByColumn`, `promoteTriageToPlan`
- Existing task store (`src/services/taskStore.ts`) — no new persistence

---

## 4. Competitor / research report blueprint

### What it does
Renders a polished, self-contained HTML research report from a structured `ResearchInput`. The renderer is pure (no network), so it's testable offline. A companion CLI gathers snippets via `WebSearchTool`, optionally synthesizes them with a local Ollama model, and hands the structured input to the renderer.

### How to use
```powershell
# Live: gather + synthesize + render
node scripts\research-report.js --subject "Acme Corp"
node scripts\research-report.js --subject "Acme" --queries "Acme tech;Acme pricing"

# Offline: render from a pre-built JSON input
node scripts\research-report.js --subject "Acme" --offline --fixture .\fixtures\acme.json

# Standalone: renderer-only, JSON in → HTML out
npx ts-node cookbook\blueprint-competitor-research.ts .\acme.json .\acme.html
```

### What it builds on
- [`cookbook/blueprint-competitor-research.ts`](../cookbook/blueprint-competitor-research.ts) — pure renderer
- [`scripts/research-report.js`](../scripts/research-report.js) — gather → synthesize → render CLI

---

## 5. Personal memory wiki blueprint

### What it does
Renders a browsable static site from your semantic memory entries: a landing page with search + a day index, one page per entry, and daily roll-ups under `by-day/`. The renderer is pure — fetching entries is the caller's job — so it works equally well from a scheduled job or an on-demand `/goal` task.

### How to use
```powershell
# Rebuild from semantic memory (defaults to .harness\memory-wiki)
node scripts\rebuild-memory-wiki.js

node scripts\rebuild-memory-wiki.js --out .harness\memory-wiki --limit 500
node scripts\rebuild-memory-wiki.js --project D:\some\other\project

# Standalone renderer (JSON entries → static site)
npx ts-node cookbook\blueprint-personal-wiki.ts .\entries.json .\out
```

### What it builds on
- [`cookbook/blueprint-personal-wiki.ts`](../cookbook/blueprint-personal-wiki.ts) — pure renderer
- [`scripts/rebuild-memory-wiki.js`](../scripts/rebuild-memory-wiki.js) — semantic-memory → renderer CLI

---

## 6. Morning Priority Prompt

### What it does
Once a day (default: between 09:00 and 11:00 local time) the harness asks *"What's your top priority for today?"* via the configured channel (daily brief block, Telegram, web banner). Your reply — either `priority: <answer>` or `/priority <answer>` in chat — is stored under `.harness\priorities\<YYYY-MM-DD>.json` and the prompt won't fire again that day. The answer becomes the anchor line of the next daily brief.

### How to use
```powershell
# Manually trigger the prompt (also what the scheduler runs)
node scripts\morning-priority.js

# Set today's priority from chat / Telegram
priority: ship the v0.5 release notes
/priority ship the v0.5 release notes
```

To run it automatically, add an entry to `.harness\triggers\triggers.json` with `intervalSeconds: 900` (15 min) — the script's internal de-dupe keeps it to one ask per day.

### What it builds on
- [`src/services/morningPriority.ts`](../src/services/morningPriority.ts) — store + parser + daily-brief integration
- [`scripts/morning-priority.js`](../scripts/morning-priority.js) — trigger script
- `src/jarvis/dailyBrief.ts` — surfaces today's priority at the top of the brief

---

## FAQ

### How do I add my own `kind:`?
`kind` is declared in `src/services/goalExpander.ts` as `"code" | "research" | "external"` and consumed by `cookbook/task-loop.ts` (the "0 file changes" guard skips `research`; `external` expects a `.forge-runbooks/{id}.md`). To add a new kind, extend the `TaskKind` union and teach `task-loop.ts` what success looks like for it.

### Where does state live?
Everything stays on disk under the project root:
- Plan tasks → `IMPLEMENTATION_PLAN.md`
- Task store + Kanban tags → `.harness\tasks\`
- Morning priority → `.harness\priorities\<YYYY-MM-DD>.json`
- RAG indexes → `.harness\rag\`
- Memory wiki → `.harness\memory-wiki\` (default)
- Triggers → `.harness\triggers\triggers.json`

### How do I disable a trigger?
Either delete its entry from `.harness\triggers\triggers.json`, or start the harness with `HARNESS_TRIGGERS_ENABLED=` unset / empty. Individual scripts (e.g. `morning-priority.js`) exit non-zero outside their window, so removing the schedule is enough.

### Can I use it offline?
Yes for everything except live web research:
- `/goal`, the Kanban bridge, the personal wiki, the morning prompt, and the PDF-to-wiki pipeline (with `HARNESS_RAG_BACKEND=hash`) run fully offline.
- The competitor research CLI supports `--offline --fixture <input.json>` or `HARNESS_RESEARCH_OFFLINE=1` to skip web calls and render from a prepared JSON input.
