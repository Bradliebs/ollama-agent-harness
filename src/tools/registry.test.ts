import { createBuiltinToolRegistry, ToolRegistry } from './registry';
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
    const fileRead = registry.get('file_read');
    expect(fileRead?.riskLevel).toBe('low');
    expect(fileRead?.permissionCategory).toBe('read');
  });
});
