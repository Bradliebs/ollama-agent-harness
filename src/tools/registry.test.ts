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

    registry.register({ tool, toolset: 'test', source: 'runtime', enabledByDefault: true });
    expect(() => registry.register({ tool, toolset: 'test', source: 'runtime', enabledByDefault: true })).toThrow('Tool already registered');
  });
});
