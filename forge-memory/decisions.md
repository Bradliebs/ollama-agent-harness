# Forge Decisions

Decisions made during project setup and ongoing development. Append new decisions — never delete old ones.

## Setup Decisions

### 2026-04-28: Initial scaffolding
**What:** CopilotForge generated the initial project structure for the Ollama Agent Harness.
**Why:** User requested scaffolding for a local-first agentic system wrapping Ollama's API, borrowing architectural patterns from the Claude Code paper (2604.14228v1).
**Stack:** TypeScript, Node.js, ollama-js
**Options enabled:** Memory: yes, Testing: yes, Task automation: yes

### 2026-04-28: Architecture inspiration — Claude Code paper
**What:** Adopted the design patterns analyzed in "Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems" (Liu et al., 2026).
**Why:** The paper provides a thorough source-level analysis of production agent architecture. Key patterns adopted: minimal scaffolding with maximal operational harness, deny-first safety, context-as-scarce-resource, append-only state, tool dispatch classification, and subagent isolation.

### 2026-04-28: Stack choice — TypeScript
**What:** Chose TypeScript with Node.js and the official ollama-js library.
**Why:** The paper analyzes a TypeScript system, making patterns directly transferable. Ollama has an official JS library with streaming support and tool calling. Async generators (used for the agent loop) are first-class in TypeScript.

### 2026-04-28: Plan Execution Summary

Executed IMPLEMENTATION_PLAN.md: 16/16 tasks succeeded, 0 failed.

**Completed:**
- init-project — Initialize TypeScript project with tsconfig.json, package.json, and directory structure
- setup-ollama-client — Create the Ollama client abstraction layer with streaming and tool calling support
- define-types — Define core type interfaces: Tool, ToolResult, LoopEvent, Message, PermissionRule, SessionEntry
- implement-agent-loop — Build the core queryLoop async generator (while-loop, model call, tool dispatch, stop conditions)
- implement-tool-dispatch — Create ToolDispatcher with concurrent-read/serial-write classification
- implement-permissions — Build deny-first permission rule engine with mode support
- implement-builtin-tools — Create FileRead, FileWrite, FileEdit, ListFiles, Bash, WebFetch tools
- implement-context-assembly — Build context assembly pipeline
- implement-compaction — Create multi-layer context compaction pipeline
- implement-session-storage — Build append-only JSONL session transcript storage
- implement-session-resume — Add session resume and fork operations
- implement-subagent — Create AgentTool for subagent delegation with isolated context
- implement-extensibility — Build skill loader (SKILL.md parser) and hook pipeline
- implement-cli — Create interactive CLI entry point with streaming output
- add-error-recovery — Add typed error hierarchy, retry with backoff
- add-tests — Write Jest test suite (28 tests, 4 suites, all passing)

## Ralph Loop Run — 2026-05-02T09:34:09.165Z
- Done: 0, Failed: 0, Pending: 0
- Time: 0.0s
- Exit reason: all tasks complete

## Ralph Loop Run — 2026-05-02T09:35:24.126Z
- Done: 17, Failed: 0, Pending: 7
- Time: 52.0s
- Exit reason: max iterations reached (1)

## Ralph Loop Run — 2026-05-02T14:55:12.879Z
- Done: 18, Failed: 3, Pending: 3
- Time: 131.1s
- Exit reason: max iterations reached (3)

## Ralph Loop Run — 2026-05-02T15:01:33.769Z
- Done: 18, Failed: 3, Pending: 3
- Time: 59.2s
- Exit reason: max iterations reached (1)

## Ralph Loop Run — 2026-05-02T15:05:06.781Z
- Done: 19, Failed: 3, Pending: 2
- Time: 67.9s
- Exit reason: max iterations reached (1)

## Ralph Loop Run — 2026-05-02T15:14:07.375Z
- Done: 23, Failed: 1, Pending: 0
- Time: 265.7s
- Exit reason: all tasks complete

## Ralph Loop Run — 2026-05-02T16:50:52.340Z
- Done: 29, Failed: 0, Pending: 0
- Time: 0.0s
- Exit reason: all tasks complete
