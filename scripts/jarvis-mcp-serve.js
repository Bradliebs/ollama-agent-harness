#!/usr/bin/env node
// Jarvis MCP stdio server entry point.
//
// Exposes the harness's tool registry over MCP so external clients
// (Claude Desktop, Cursor, VS Code MCP-compatible extensions) can use the
// harness as their backend.
//
// Usage:
//   node scripts/jarvis-mcp-serve.js
//
// One JSON-RPC request per line on stdin, one response per line on stdout.
// Logs go to stderr to keep stdout clean for the protocol.
//
// Currently exposes the read-only built-in tools only. Mutating tools are
// gated by capability grants and the trust ladder; expose them by setting
// HARNESS_MCP_INCLUDE_WRITE=1 and accepting the risk.

const path = require('path');

async function main() {
  // Use ts-node to load the TypeScript modules directly when invoked from source.
  // When packaged from `dist/`, this script can be replaced with the compiled entry.
  try {
    require('ts-node/register');
  } catch (err) {
    process.stderr.write('jarvis-mcp-serve requires ts-node (already a dev dep).\n');
    process.exit(1);
  }

  const projectDir = process.cwd();
  process.env.HARNESS_PROJECT_DIR = process.env.HARNESS_PROJECT_DIR || projectDir;

  const { getRuntimeTools } = require(path.resolve(__dirname, '..', 'src', 'tools'));
  const { HarnessMcpServer } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'mcpServer'));
  const { startMcpStdioServer } = require(path.resolve(__dirname, '..', 'src', 'jarvis', 'mcpStdio'));

  const allTools = getRuntimeTools(projectDir);
  const includeWrite = process.env.HARNESS_MCP_INCLUDE_WRITE === '1';
  const tools = includeWrite ? allTools : allTools.filter((t) => t.isReadOnly);

  process.stderr.write(`[jarvis-mcp] exposing ${tools.length} tool(s) (read-only=${!includeWrite})\n`);

  const server = new HarnessMcpServer({ tools, serverName: 'ollama-agent-harness', version: '0.4.7' });
  startMcpStdioServer({
    server,
    onParseError: (line, err) => process.stderr.write(`[jarvis-mcp] parse error: ${err.message} | line=${line.slice(0, 120)}\n`),
  });

  process.stderr.write('[jarvis-mcp] ready on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[jarvis-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
