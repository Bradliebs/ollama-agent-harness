// Harness-as-MCP-Server.
//
// Flips the direction of `src/tools/mcpTools.ts` — instead of the harness
// CONSUMING MCP tools from external servers, this module EXPOSES the
// harness's tool registry, RAG, memory, and sessions over the
// Model Context Protocol so other clients (Claude Desktop, Cursor, VS Code
// MCP-compatible extensions) can use the harness as their backend.
//
// Implementation status: protocol-shaped catalog + dispatch only. A real
// stdio transport requires `@modelcontextprotocol/sdk` which is not in
// dependencies. To enable for real:
//
//   1. `npm install @modelcontextprotocol/sdk`
//   2. Replace `StubTransport` below with `StdioServerTransport` from the SDK.
//   3. Run via `harness mcp serve` (CLI command added in the same follow-up).
//   4. Point Claude Desktop / Cursor settings at the executable.
//
// The catalog generation, request handlers, and capability advertisement
// stay correct as written so the SDK swap is mechanical.

import type { Tool, ToolResult } from '../types';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpServerOptions {
  tools: Tool[];
  /** Optional name advertised to clients. */
  serverName?: string;
  /** Optional version string. */
  version?: string;
}

export interface McpRequest {
  method: 'tools/list' | 'tools/call' | 'initialize';
  params?: Record<string, unknown>;
  id: number | string;
}

export interface McpResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Stub transport — collects messages in-memory; replaced by stdio in production. */
export class StubTransport {
  sent: McpResponse[] = [];
  send(response: McpResponse): void {
    this.sent.push(response);
  }
}

export class HarnessMcpServer {
  private tools: Map<string, Tool>;
  private serverName: string;
  private version: string;

  constructor(options: McpServerOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.serverName = options.serverName ?? 'ollama-agent-harness';
    this.version = options.version ?? '0.4.7';
  }

  /** Build the tool catalog in MCP shape. */
  catalog(): McpToolDescriptor[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
  }

  async handle(request: McpRequest, transport: StubTransport): Promise<void> {
    try {
      if (request.method === 'initialize') {
        transport.send({
          id: request.id,
          result: {
            serverInfo: { name: this.serverName, version: this.version },
            capabilities: { tools: {} },
          },
        });
        return;
      }
      if (request.method === 'tools/list') {
        transport.send({ id: request.id, result: { tools: this.catalog() } });
        return;
      }
      if (request.method === 'tools/call') {
        const params = request.params ?? {};
        const name = String(params.name ?? '');
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const tool = this.tools.get(name);
        if (!tool) {
          transport.send({ id: request.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
          return;
        }
        const result: ToolResult = await tool.execute(args);
        transport.send({
          id: request.id,
          result: {
            content: [{ type: 'text', text: result.output }],
            isError: !result.success,
          },
        });
        return;
      }
      transport.send({ id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } });
    } catch (err) {
      transport.send({ id: request.id, error: { code: -32000, message: (err as Error).message } });
    }
  }
}

export interface McpServerStatus {
  ready: boolean;
  toolCount: number;
  serverName: string;
  transport: 'stub' | 'stdio';
  /** Hint surfaced to /api/jarvis/status for users. */
  enableHint?: string;
}

export function getMcpServerStatus(toolCount: number): McpServerStatus {
  return {
    ready: false, // becomes true when the real stdio transport is wired
    toolCount,
    serverName: 'ollama-agent-harness',
    transport: 'stub',
    enableHint: 'Install @modelcontextprotocol/sdk and run "harness mcp serve" to expose tools to Claude Desktop / Cursor.',
  };
}
