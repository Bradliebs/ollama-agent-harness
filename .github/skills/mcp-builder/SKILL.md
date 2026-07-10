---
name: "mcp-builder"
description: "Build a new MCP (Model Context Protocol) server from scratch — a stdio program that exposes tools to AI agents. Use when the user wants to wrap an API, CLI, or internal service as an MCP server the harness (or Claude Desktop, Cursor, etc.) can load. Adapted from anthropics/skills."
domain: "extensibility"
confidence: "medium"
source: "distilled from anthropics/skills/mcp-builder, adapted for the Ollama Agent Harness"
triggers:
  - "build an mcp"
  - "build an mcp server"
  - "create an mcp server"
  - "wrap this api as mcp"
  - "make this a tool for the agent"
  - "add a custom tool to the harness"
  - "expose this as a tool"
  - "mcp-builder"
---

<!-- 👋 Human? This file contains instructions for AI assistants, not for you.
     For the human-friendly guide, see docs/GETTING-STARTED.md -->

# MCP Builder

> Build a Model Context Protocol server: a small program that speaks JSON over stdio and exposes tools an agent can call. The harness loads these via the MCP Hub (Tools tab → MCP servers). This skill guides you from "user wants to wrap X" to a working, loadable server.

## What This Does

When the user wants to expose something — an API, a CLI tool, a local script, a database — as a tool the agent can call, you build an MCP server. This skill walks the four phases: **plan → implement → test → register**.

The harness already runs stdio MCP servers — see [src/extensibility/mcpRuntime.ts](src/extensibility/mcpRuntime.ts) and [src/extensibility/mcpCatalog.ts](src/extensibility/mcpCatalog.ts). Your server just needs to be a stdio program the harness can `spawn` with an install command like `npx -y your-package` or `node ./dist/server.js`.

## When NOT to Use This Skill

- **The capability already exists as an MCP server.** Check the catalog (`src/extensibility/mcpCatalog.ts`) and search npm/GitHub first. Adding a duplicate wastes effort.
- **The user just wants the agent to run one shell command.** Use the `shell` tool with permission rules — don't build a server for one-off tasks.
- **The integration is one-shot scripting glue.** Write a script and call it. MCP is for reusable, multi-tool surfaces.

If you're unsure, ask: "Are you going to use this more than 3 times across different sessions?" If no, skip the server.

## Phase 1 — Plan

Before writing code, answer four questions out loud:

1. **What service/API are you wrapping?** Get the docs URL. If the user doesn't have one, ask.
2. **What tools does the agent actually need?** List 3–10 concrete operations. Prefer comprehensive API coverage over a few "smart" workflow tools — agents compose better than they obey.
3. **How does auth work?** API key in an env var is the default. OAuth means significant added complexity (token storage, refresh) — flag it to the user before committing.
4. **Local or remote?** Default to local stdio. The harness only supports stdio today; HTTP/SSE servers won't load until that runtime is added.

If any answer is "I don't know", ask. Don't guess.

## Phase 2 — Implement (TypeScript)

TypeScript is the default for this harness — matches the existing codebase and the SDK is mature. Python (FastMCP) is fine if the wrapped service has a Python-only SDK.

### Project layout

```
my-mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts          # the server entry point
└── README.md
```

### Minimal package.json

```json
{
  "name": "my-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "bin": { "my-mcp-server": "dist/index.js" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

### Minimal server (TypeScript SDK)

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server(
  { name: 'my-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const SearchInput = z.object({
  query: z.string().describe('What to search for'),
  limit: z.number().int().positive().max(50).optional().describe('Max results, default 10'),
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: 'Search the example service. Returns up to N matching items.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          limit: { type: 'number', description: 'Max results, default 10' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'search') {
    const args = SearchInput.parse(request.params.arguments);
    // ...call the real service here...
    const results = [{ id: 1, title: `Echo: ${args.query}` }];
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Tool design rules (the ones that actually matter)

- **Name tools `verb_noun` consistently.** `github_create_issue`, `github_list_repos`. Agents pick the right tool from the name far more than from the description.
- **Descriptions are for disambiguation, not tutorials.** One sentence on what the tool does, one on when to use it. Save the long story for the README.
- **Validate inputs with Zod.** Free schema docs for the agent, free runtime checks for you.
- **Errors must guide the next action.** Bad: `"401 Unauthorized"`. Good: `"401: API key missing or expired. Set EXAMPLE_API_KEY env var."`
- **Paginate everything that could return more than ~50 items.** Returning 10,000 search results blows the agent's context window and crashes the conversation.
- **Return structured data as JSON text.** The agent parses it. Don't pre-format as markdown unless the tool's only purpose is presentation.

## Phase 3 — Test

Two layers:

### 3a. MCP Inspector (catches protocol bugs)

```bash
npm run build
npx @modelcontextprotocol/inspector node ./dist/index.js
```

Opens a web UI. Verify: tools list appears, each tool callable with sample input, errors are readable.

### 3b. Load in the harness (catches integration bugs)

1. `cd` into your server, `npm link` (or `npm publish`).
2. In the harness UI: **Tools tab → MCP servers → Add custom**.
3. Set install command to `node /absolute/path/to/dist/index.js` (or `npx your-package-name`).
4. Click **Start**, then **Discover tools**. Tools should appear.
5. Open chat, ask the agent to use one. Watch for: tool calls happen, results come back, errors are actionable.

If discovery fails: check stderr in the server window. Most failures are a missing dependency, a typo in the binary path, or stdout pollution (any `console.log` in your server breaks the JSON stream — use `console.error` for logs).

## Phase 4 — Register

If it's useful to others, add it to the harness catalog so it appears as a one-click install:

1. Edit `src/extensibility/mcpCatalog.ts`.
2. Add an entry following the existing pattern (see the playwright/duckduckgo/youtube entries as recent examples).
3. `npx tsc --noEmit` to verify.
4. Restart the harness. Your entry appears in **Tools → MCP servers → catalog**.

Entry template:

```ts
{
  name: 'my-mcp-server',
  description: 'One sentence on what it does. One sentence on when to use it.',
  tags: ['relevant', 'short', 'tags'],
  install: 'npx -y my-mcp-server',
  homepage: 'https://github.com/you/my-mcp-server',
  requiresEnv: ['MY_API_KEY'], // empty array if no env needed
},
```

## Common Pitfalls

- **`console.log` in the server** — breaks the JSON stream over stdio. Use `console.error` for all diagnostic output. The harness captures stderr separately.
- **Forgetting `"type": "module"` in package.json** — the SDK is ESM-only. Without this, imports fail silently.
- **Tools that need state across calls** — MCP servers can hold in-memory state (the process stays alive across calls), but don't rely on session-scoped state unless you've thought through reconnection. If the harness restarts the server, state vanishes.
- **Returning huge blobs** — a 50KB response is fine, a 5MB one will choke a small local model. Paginate, summarise, or return references the agent can fetch on demand.
- **OAuth flows in stdio** — painful. Either prompt the user to set a long-lived token via env var (see how the gmail entry handles this), or build the OAuth dance into a separate one-time CLI command that writes a token file the server reads.

## Reference

- **Official MCP spec**: https://modelcontextprotocol.io/ (fetch `/specification/draft.md` for the full thing)
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Python SDK (FastMCP)**: https://github.com/modelcontextprotocol/python-sdk
- **Example servers** to read for patterns: https://github.com/modelcontextprotocol/servers
- **Harness runtime** for understanding how servers are launched: [src/extensibility/mcpRuntime.ts](src/extensibility/mcpRuntime.ts)
- **Harness catalog** for entry format: [src/extensibility/mcpCatalog.ts](src/extensibility/mcpCatalog.ts)

## Honesty Notes

- This skill is distilled from `anthropics/skills/mcp-builder`. The original has bundled reference files (`mcp_best_practices.md`, `node_mcp_server.md`, `python_mcp_server.md`, `evaluation.md`) and a benchmarking pipeline that don't exist here. If you need that depth, fetch them from `https://github.com/anthropics/skills/tree/main/skills/mcp-builder/reference`.
- The harness's stdio-only constraint is real today. If a user asks to build a remote HTTP+OAuth MCP server (like the official Google Workspace ones), say so explicitly — the harness won't load it without a transport upgrade first.
- For local Ollama models (7B–30B), aim for ≤5 tools per server. Long tool lists degrade selection accuracy more than they help.
