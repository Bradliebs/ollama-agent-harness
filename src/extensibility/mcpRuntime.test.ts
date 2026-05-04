import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listMcpServers, removeMcpServer, startMcpServer, stopAllMcpServers, stopMcpServer, upsertMcpServer } from './mcpRuntime';

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
});
