import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createBuiltinToolRegistry, createToolRegistry, ToolRegistry } from './registry';
import { upsertMcpServer } from '../extensibility/mcpRuntime';
import type { Tool } from '../types';

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

describe('ToolRegistry', () => {
  it('groups built-in tools by toolset', () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.get('file_read')?.toolset).toBe('files');
    expect(registry.listToolsets()).toEqual(expect.arrayContaining(['files', 'web', 'learning']));
    expect(registry.listToolsForToolset('files').map((tool) => tool.name)).toContain('file_read');
  });

  it('rejects duplicate tool registrations', () => {
    const registry = new ToolRegistry();
    const tool = makeTool('same');

    registry.register({ tool, toolset: 'test', source: 'runtime', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false });
    expect(() => registry.register({ tool, toolset: 'test', source: 'runtime', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false })).toThrow('Tool already registered');
  });

  it('exposes risk and permission category metadata for the dashboard', () => {
    const registry = createBuiltinToolRegistry();
    const bash = registry.get('bash');
    expect(bash?.riskLevel).toBe('high');
    expect(bash?.permissionCategory).toBe('shell');
    const telegram = registry.get('telegram_notify');
    expect(telegram?.toolset).toBe('communications');
    expect(telegram?.riskLevel).toBe('high');
    expect(telegram?.enabledByDefault).toBe(false);
    const slack = registry.get('slack_notify');
    expect(slack?.toolset).toBe('communications');
    expect(slack?.riskLevel).toBe('high');
    expect(slack?.enabledByDefault).toBe(false);
    const fileRead = registry.get('file_read');
    expect(fileRead?.riskLevel).toBe('low');
    expect(fileRead?.permissionCategory).toBe('read');
    const desktopInput = registry.get('desktop_input_replay');
    expect(desktopInput?.toolset).toBe('desktop');
    expect(desktopInput?.riskLevel).toBe('high');
    expect(desktopInput?.enabledByDefault).toBe(false);
    expect(desktopInput?.canDryRun).toBe(true);
  });

  it('registers configured MCP tools as runtime entries', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-registry-mcp-'));
    try {
      await upsertMcpServer(projectDir, {
        id: 'demo',
        command: 'node',
        tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
      });

      const registry = createToolRegistry(projectDir);
      const entry = registry.get('mcp_demo__echo');

      expect(entry).toMatchObject({ toolset: 'mcp:demo', source: 'runtime', enabledByDefault: false, riskLevel: 'high', permissionCategory: 'shell' });
      expect(entry?.tool.parameters).toMatchObject({ type: 'object' });
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});
