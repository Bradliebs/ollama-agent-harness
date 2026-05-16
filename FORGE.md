# FORGE.md — CopilotForge Control Panel

> Edit this file to customize your CopilotForge setup. This is your project's AI configuration dashboard.

## Project

- **Description:** Ollama Agent Harness — a local-first agentic system wrapping Ollama's API, borrowing architectural patterns from the Claude Code paper (2604.14228v1)
- **Stack:** TypeScript, Node.js, ollama-js
- **Memory:** enabled
- **Test automation:** enabled
- **Verbosity:** intermediate
- **Build Path:** J (Developer Project)

## Architecture (from paper)

| Pattern | Description |
|---|---|
| Minimal scaffolding | Simple while-loop agent core; complexity in surrounding harness |
| Deny-first safety | Deny rules override allow rules; unrecognized actions denied |
| Context as scarce resource | Progressive compaction: budget → snip → summarize |
| Append-only state | JSONL transcripts; compaction appends, never deletes |
| Tool classification | Read-only tools parallel; state-modifying tools serial |
| Subagent isolation | Isolated context windows; summary-only returns |
| Composable extensibility | Hooks (zero cost) → skills (low) → plugins (medium) → MCP (high) |

## Skills

| Skill | Path | Purpose |
|---|---|---|
| harness-conventions | `.github/skills/harness-conventions/SKILL.md` | Project-wide architectural patterns and conventions |
| code-review | `.github/skills/code-review/SKILL.md` | Code review checklist enforcing harness conventions |
| testing | `.github/skills/testing/SKILL.md` | Jest testing conventions and patterns |
| planner | `.github/skills/planner/SKILL.md` | CopilotForge wizard and scaffolding |

## Agents

| Agent | Path | Role |
|---|---|---|
| planner | `.copilot/agents/planner.md` | Project scaffolding and architecture decisions |
| reviewer | `.copilot/agents/reviewer.md` | Code review and convention enforcement |
| tester | `.copilot/agents/tester.md` | Test authoring and coverage analysis |

<!-- forge:cookbook-start -->

## Cookbook Recipes

| Recipe | Path | Description |
|---|---|---|
| Agent Loop | `cookbook/agent-loop.ts` | Core ReAct loop with tool dispatch, permissions, and concurrency |
| Ollama Client | `cookbook/ollama-client.ts` | Thin wrapper around ollama-js with streaming and health checks |
| Error Handling | `cookbook/error-handling.ts` | Typed error hierarchy and error-to-tool-result conversion |
| Hello World | `cookbook/hello-world.ts` | Starter recipe (pre-existing) |
| Task Loop | `cookbook/task-loop.ts` | Autonomous task execution from IMPLEMENTATION_PLAN.md |

<!-- forge:cookbook-end -->

## Experimental Branches

| Branch | Status | Description |
|---|---|---|
| `probe/orchestration` | Quarantined | Paperclip-style orchestration layer (companies, goals, org charts, adapters, engine). 11 files, ~2.7k lines, 21 passing tests. Built by the harness as a feasibility probe — not merged to master. Check out with `git checkout probe/orchestration`. |

## Memory

| File | Purpose |
|---|---|
| `forge-memory/decisions.md` | Architectural decisions log |
| `forge-memory/patterns.md` | Reusable project conventions |
| `forge-memory/preferences.md` | Your settings and overrides |
| `forge-memory/history.md` | Session activity log |

## Reference

- **Paper:** "Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems" (Liu et al., 2026) — `2604.14228v1.pdf`
- **Ollama API:** <https://docs.ollama.com/api/introduction>
- **ollama-js:** <https://github.com/ollama/ollama-js>

## What's Next

- [ ] Review `IMPLEMENTATION_PLAN.md` and adjust tasks to your priorities
- [ ] Say **"run the plan"** to start building the harness autonomously
- [ ] Try: **"review this code"** to test the code-review skill
- [ ] Try: **"write tests for the agent loop"** to test the testing skill
- [ ] Edit this file to add or remove skills and agents
