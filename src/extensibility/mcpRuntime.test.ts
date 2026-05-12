import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverMcpServerTools, invokeMcpServerTool, listMcpServers, removeMcpServer, startMcpServer, stopAllMcpServers, stopMcpServer, upsertMcpServer } from './mcpRuntime';

describe('mcpRuntime', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mcp-'));
  });

  afterEach(async () => {
    await stopAllMcpServers();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('persists sanitized MCP server definitions', async () => {
    const server = await upsertMcpServer(projectDir, {
      id: 'Demo_Server',
      catalogName: 'filesystem',
      command: 'node',
      args: ['server.js'],
      env: { DEMO_TOKEN: 'secret', 'bad key': 'ignored' },
      tools: [{ name: 'read_file', description: 'Read files' }, { name: 'bad tool name' }],
    });

    expect(server).toMatchObject({ id: 'demo_server', command: 'node', running: false, catalogName: 'filesystem' });
    expect(server.env).toEqual({ DEMO_TOKEN: 'secret' });
    expect(server.tools).toEqual([{ name: 'read_file', description: 'Read files', inputSchema: undefined }]);

    await expect(listMcpServers(projectDir)).resolves.toEqual([expect.objectContaining({ id: 'demo_server', running: false })]);
    await expect(fs.readFile(path.join(projectDir, '.harness', 'mcp', 'servers.json'), 'utf-8')).resolves.toContain('demo_server');
  });

  it('rejects invalid server ids and missing commands', async () => {
    await expect(upsertMcpServer(projectDir, { id: '../bad', command: 'node' })).rejects.toThrow('MCP server id is required');
    await expect(upsertMcpServer(projectDir, { id: 'valid' })).rejects.toThrow('MCP server command is required');
  });

  it('starts and stops configured MCP server processes', async () => {
    await upsertMcpServer(projectDir, {
      id: 'demo',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      tools: [{ name: 'ping' }],
    });

    const started = await startMcpServer(projectDir, 'demo');

    expect(started.running).toBe(true);
    expect(started.pid).toEqual(expect.any(Number));
    await expect(listMcpServers(projectDir)).resolves.toEqual([expect.objectContaining({ id: 'demo', running: true })]);
    await expect(stopMcpServer('demo')).resolves.toBe(true);
    await expect(listMcpServers(projectDir)).resolves.toEqual([expect.objectContaining({ id: 'demo', running: false })]);
  });

  it('removes definitions and stops running processes', async () => {
    await upsertMcpServer(projectDir, { id: 'demo', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await startMcpServer(projectDir, 'demo');

    await expect(removeMcpServer(projectDir, 'demo')).resolves.toBe(true);
    await expect(listMcpServers(projectDir)).resolves.toEqual([]);
  });

  it('discovers and invokes tools over MCP stdio', async () => {
    const serverScript = path.join(projectDir, 'fake-mcp-server.js');
    await fs.writeFile(serverScript, `
let buffer = '';
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf-8') + '\\r\\n\\r\\n' + body);
}
function handle(message) {
  if (message.method === 'initialize') send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
  else if (message.method === 'tools/list') send(message.id, { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  else if (message.method === 'tools/call') send(message.id, { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] });
}
function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) return;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.slice(bodyStart, bodyStart + length);
    buffer = buffer.slice(bodyStart + length);
    handle(JSON.parse(body));
  }
}
process.stdin.on('data', (chunk) => { buffer += String(chunk); drain(); });
`, 'utf-8');
    await upsertMcpServer(projectDir, { id: 'demo', command: process.execPath, args: [serverScript] });
    await startMcpServer(projectDir, 'demo');

    const discovered = await discoverMcpServerTools(projectDir, 'demo');
    expect(discovered.tools).toEqual([expect.objectContaining({ name: 'echo', description: 'Echo input' })]);

    const result = await invokeMcpServerTool(projectDir, 'demo', 'echo', { text: 'hello' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:hello' }] });
  });
});
