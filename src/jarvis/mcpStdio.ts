// MCP stdio transport — line-delimited JSON-RPC over stdin/stdout.
//
// Implements the minimum needed to round-trip MCP `initialize`,
// `tools/list`, and `tools/call` against `HarnessMcpServer` from
// `mcpServer.ts`. Reads requests one line at a time, dispatches, writes
// responses as one JSON object per line.
//
// This is wire-compatible with simple MCP clients that speak line-delimited
// JSON-RPC (the canonical MCP shape uses Content-Length framing; for that,
// install `@modelcontextprotocol/sdk` and swap this transport — the
// HarnessMcpServer class stays unchanged).
//
// To run:
//   node scripts/jarvis-mcp-serve.js
//   echo '{"id":1,"method":"tools/list"}' | node scripts/jarvis-mcp-serve.js

import * as readline from 'readline';
import { HarnessMcpServer, StubTransport, type McpRequest, type McpResponse } from './mcpServer';

export interface StdioServerOptions {
  server: HarnessMcpServer;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Called on JSON parse errors. Defaults to silent. */
  onParseError?: (line: string, err: Error) => void;
}

export interface StdioServerHandle {
  stop: () => void;
}

export function startMcpStdioServer(options: StdioServerOptions): StdioServerHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const server = options.server;

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: McpRequest;
    try {
      request = JSON.parse(trimmed) as McpRequest;
    } catch (err) {
      if (options.onParseError) options.onParseError(trimmed, err as Error);
      return;
    }
    const transport = new StubTransport();
    await server.handle(request, transport);
    for (const response of transport.sent) {
      output.write(JSON.stringify(response) + '\n');
    }
  });

  return {
    stop: () => rl.close(),
  };
}

/** Helper for tests: run a single request through the server and return the response. */
export async function singleRequest(server: HarnessMcpServer, request: McpRequest): Promise<McpResponse> {
  const transport = new StubTransport();
  await server.handle(request, transport);
  return transport.sent[0];
}
