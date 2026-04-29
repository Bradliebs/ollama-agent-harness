# Cookbook

Copy-paste-ready code recipes for the Ollama Agent Harness. Each recipe demonstrates a specific architectural pattern.

## Recipes

| Recipe | File | Description |
|---|---|---|
| **Agent Loop** | [agent-loop.ts](agent-loop.ts) | The core ReAct pattern — while-loop calling Ollama, dispatching tools with permission checks and concurrency classification, repeating until done |
| **Ollama Client** | [ollama-client.ts](ollama-client.ts) | Thin wrapper around the official `ollama-js` library with streaming chat, tool calling, token tracking, and health checks |
| **Error Handling** | [error-handling.ts](error-handling.ts) | Typed error hierarchy (HarnessError → ToolExecutionError, PermissionDeniedError, etc.) with error-to-tool-result conversion and retry logic |
| **Hello World** | [hello-world.ts](hello-world.ts) | Starter recipe |
| **Task Loop** | [task-loop.ts](task-loop.ts) | Autonomous task execution — reads IMPLEMENTATION_PLAN.md and works through tasks |
| **Summarize a PDF** | [pdf-summarize.ts](pdf-summarize.ts) | Calls `PdfMetadataTool` and `PdfReadTool` from the public API, then asks Ollama to summarize the extracted text |

## Architecture Reference

These recipes implement patterns from the Claude Code paper:

- **agent-loop.ts** → Section 4 (Turn Execution: The Agentic Query Loop)
- **ollama-client.ts** → Section 3.2 (High-Level System Structure, model call interface)
- **error-handling.ts** → Section 4.4 (Recovery Mechanisms)
- **task-loop.ts** → Section 4.1 (The Query Pipeline, autonomous execution)
