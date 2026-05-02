# Cookbook

Copy-paste-ready code recipes for the Ollama Agent Harness. Each recipe demonstrates a specific architectural pattern.

## Recipes

| Recipe | File | Description |
|---|---|---|
| **Agent Loop** | [agent-loop.ts](agent-loop.ts) | The core ReAct pattern — while-loop calling Ollama, dispatching tools with permission checks and concurrency classification, repeating until done |
| **Ollama Client** | [ollama-client.ts](ollama-client.ts) | Thin wrapper around the official `ollama-js` library with streaming chat, tool calling, token tracking, and health checks |
| **Error Handling** | [error-handling.ts](error-handling.ts) | Typed error hierarchy (HarnessError → ToolExecutionError, PermissionDeniedError, etc.) with error-to-tool-result conversion and retry logic |
| **Hello World** | [hello-world.ts](hello-world.ts) | Starter recipe |
| **Task Loop** | [task-loop.ts](task-loop.ts) | Autonomous task execution — reads IMPLEMENTATION_PLAN.md and works through tasks. Exports `ralphLoop(planPath, maxIterations, dryRun, hooks?)` and the `RalphLoopHooks { implementTask?, validateTask? }` interface so tests can drive the budget/halt/snapshot-restore control flow without spawning the real harness CLI. |
| **Summarize a PDF** | [pdf-summarize.ts](pdf-summarize.ts) | Calls `PdfMetadataTool` and `PdfReadTool` from the public API, then asks Ollama to summarize the extracted text |
| **Render a PDF page for a vision model** | [pdf-render-vision.ts](pdf-render-vision.ts) | Calls `PdfRenderPageTool` (needs `HARNESS_PDF_RENDER_COMMAND`) to rasterize a page and asks a vision model to describe it |

## Architecture Reference

These recipes implement patterns from the Claude Code paper:

- **agent-loop.ts** → Section 4 (Turn Execution: The Agentic Query Loop)
- **ollama-client.ts** → Section 3.2 (High-Level System Structure, model call interface)
- **error-handling.ts** → Section 4.4 (Recovery Mechanisms)
- **task-loop.ts** → Section 4.1 (The Query Pipeline, autonomous execution)

## Attachments and uploads

Files dragged into the chat input or uploaded via `POST /api/upload` are stored under `.harness/uploads/`. Agents and recipes interact with them through three layers:

- **`list_uploads` tool.** Takes no arguments and returns each attachment as `path<TAB>size<TAB>modified`. Use it before reading any attachment when the conversation does not already include the exact path.
- **Authoritative system block.** When the chat request includes an `attachments` array, the harness validates each entry and appends a `--- Session Attachments (authoritative) ---` block to the system prompt. The block lists every attachment with its exact `.harness/uploads/<name>` path so the model cannot lose it through paraphrasing.
- **Uploads-aware path resolver.** `file_read`, `pdf_read`, `pdf_metadata`, `pdf_extract_tables`, `pdf_render` (input only), `image_analyze`, and `audio_transcribe` resolve through `resolveProjectReadPath`. When the model passes a bare filename that does not exist at the cwd, the resolver falls back to `.harness/uploads/<basename>` if present, emits a `PathResolution` warn log, and surfaces a `uploads_fallback` SSE event to the UI trace.

The chat UI surfaces a `⚠️ uploads fallback` trace entry whenever the resolver had to rewrite a path. Treat repeated entries from the same model as a signal to tighten its system prompt or switch to `list_uploads`.
