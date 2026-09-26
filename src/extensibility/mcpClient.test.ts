import { spawn } from 'child_process';
import { McpStdioClient } from './mcpClient';

describe('MCP stdio interoperability', () => {
  it.each(['newline', 'content-length'] as const)('handles byte-split Unicode, pagination, and server requests with %s framing', async (framing) => {
    const child = spawn(process.execPath, ['-e', `
      const readline = require('readline');
      function send(message) {
        const body = JSON.stringify(message);
        const payload = Buffer.from(${JSON.stringify(framing)} === 'content-length' ? 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body : body + '\\n');
        let offset = 0;
        function next() { if (offset < payload.length) { process.stdout.write(payload.subarray(offset, ++offset)); setImmediate(next); } }
        next();
      }
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05' } });
        if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: message.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first', description: 'caf\\u00e9' }], nextCursor: 'next' } });
        if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, method: 'ping' });
        if (message.result) send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });
      });
    `], { windowsHide: true });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const client = new McpStdioClient(child);
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'first', description: 'caf\u00e9' }),
        expect.objectContaining({ name: 'second' }),
      ]);
      await expect(client.callTool('first', {})).resolves.toEqual({ content: [{ type: 'text', text: 'pong' }] });
    } finally {
      child.kill();
      await exited;
    }
  }, 20000);

  it('rejects unsupported initialization versions before listing tools', async () => {
    const child = spawn(process.execPath, ['-e', `
      require('readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 'unsupported' } }) + '\\n');
      });
    `], { windowsHide: true });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await expect(new McpStdioClient(child).listTools()).rejects.toThrow('unsupported protocol version');
    } finally {
      child.kill();
      await exited;
    }
  });

  it('notifies the peer when a tool request times out and propagates RPC errors', async () => {
    const child = spawn(process.execPath, ['-e', `
      let cancelled = false;
      require('readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'notifications/cancelled') { cancelled = Number.isInteger(message.params.requestId); return; }
        if (!message.id) return;
        if (message.method === 'tools/call') {
          if (message.params.name === 'error') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'fixture failure' } }) + '\\n');
          return;
        }
        const result = message.method === 'initialize' ? { protocolVersion: '2024-11-05' } : { tools: [{ name: cancelled ? 'cancelled' : 'waiting' }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `], { windowsHide: true });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const client = new McpStdioClient(child, 1000);
      await client.initialize();
      await expect(client.callTool('error', {})).rejects.toThrow('fixture failure');
      await expect(client.callTool('slow', {})).rejects.toThrow('timed out');
      await expect(client.listTools()).resolves.toEqual([expect.objectContaining({ name: 'cancelled' })]);
    } finally {
      child.kill();
      await exited;
    }
  });

  it('discovers and calls tools on the official SDK server', async () => {
    const serverModule = require.resolve('@modelcontextprotocol/sdk/server/index.js');
    const transportModule = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
    const typesModule = require.resolve('@modelcontextprotocol/sdk/types.js');
    const child = spawn(process.execPath, ['-e', `
      const { Server } = require(${JSON.stringify(serverModule)});
      const { StdioServerTransport } = require(${JSON.stringify(transportModule)});
      const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(typesModule)});
      const server = new Server({ name: 'interop', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: request.params.arguments.text }] }));
      server.connect(new StdioServerTransport());
    `], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const client = new McpStdioClient(child);
      await expect(client.listTools()).resolves.toEqual([expect.objectContaining({ name: 'echo' })]);
      await expect(client.callTool('echo', { text: 'caf\u00e9 \ud83c\udf0d' })).resolves.toMatchObject({ content: [{ type: 'text', text: 'caf\u00e9 \ud83c\udf0d' }] });
    } catch (error) {
      throw new Error(`${String(error)}\nSDK stderr: ${stderr}`);
    } finally {
      child.kill();
      await exited;
    }
  }, 20000);
});