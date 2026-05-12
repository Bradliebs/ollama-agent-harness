import { ToolDispatcher } from './dispatcher';
import { RuntimeTracer } from '../core/tracing';
import type { Tool, ToolResult } from '../types';

function makeTool(name: string, isReadOnly: boolean, handler?: (input: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute: handler ?? (async () => ({ success: true, output: `${name} executed` })),
  };
}

describe('ToolDispatcher', () => {
  it('dispatches to the correct tool by name', async () => {
    const tools = [makeTool('alpha', true), makeTool('beta', false)];
    const dispatcher = new ToolDispatcher(tools);

    const results = await dispatcher.dispatch([{ name: 'alpha', input: {} }]);
    expect(results).toHaveLength(1);
    expect(results[0].result.output).toBe('alpha executed');
  });

  it('returns error for unknown tool', async () => {
    const dispatcher = new ToolDispatcher([makeTool('alpha', true)]);

    const results = await dispatcher.dispatch([{ name: 'missing', input: {} }]);
    expect(results[0].result.success).toBe(false);
    expect(results[0].result.output).toContain('Unknown tool');
  });

  it('runs read-only tools in parallel', async () => {
    const order: string[] = [];
    const slowTool = makeTool('slow', true, async () => {
      order.push('slow-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('slow-end');
      return { success: true, output: 'slow done' };
    });
    const fastTool = makeTool('fast', true, async () => {
      order.push('fast');
      return { success: true, output: 'fast done' };
    });

    const dispatcher = new ToolDispatcher([slowTool, fastTool]);
    await dispatcher.dispatch([
      { name: 'slow', input: {} },
      { name: 'fast', input: {} },
    ]);

    // Both should start before slow finishes (parallel execution)
    expect(order.indexOf('fast')).toBeLessThan(order.indexOf('slow-end'));
  });

  it('runs exclusive tools serially', async () => {
    const order: string[] = [];
    const first = makeTool('first', false, async () => {
      order.push('first');
      return { success: true, output: 'first done' };
    });
    const second = makeTool('second', false, async () => {
      order.push('second');
      return { success: true, output: 'second done' };
    });

    const dispatcher = new ToolDispatcher([first, second]);
    await dispatcher.dispatch([
      { name: 'first', input: {} },
      { name: 'second', input: {} },
    ]);

    expect(order).toEqual(['first', 'second']);
  });

  it('runs two read-only tools concurrently while a write tool serializes after them', async () => {
    const order: string[] = [];
    const read1 = makeTool('read1', true, async () => {
      order.push('read1-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('read1-end');
      return { success: true, output: 'read1 done' };
    });
    const read2 = makeTool('read2', true, async () => {
      order.push('read2-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('read2-end');
      return { success: true, output: 'read2 done' };
    });
    const write = makeTool('write', false, async () => {
      order.push('write');
      return { success: true, output: 'write done' };
    });

    const dispatcher = new ToolDispatcher([read1, read2, write]);
    await dispatcher.dispatch([
      { name: 'read1', input: {} },
      { name: 'read2', input: {} },
      { name: 'write', input: {} },
    ]);

    // Both read-only tools should start before either ends (parallel execution)
    const read1StartIdx = order.indexOf('read1-start');
    const read2StartIdx = order.indexOf('read2-start');
    const read1EndIdx = order.indexOf('read1-end');
    const read2EndIdx = order.indexOf('read2-end');
    const writeIdx = order.indexOf('write');

    // Both reads start before either ends
    expect(read1StartIdx).toBeLessThan(read1EndIdx);
    expect(read2StartIdx).toBeLessThan(read2EndIdx);
    expect(read1StartIdx).toBeLessThan(read2EndIdx);
    expect(read2StartIdx).toBeLessThan(read1EndIdx);

    // Write happens only after both read-only tools complete
    expect(writeIdx).toBeGreaterThan(read1EndIdx);
    expect(writeIdx).toBeGreaterThan(read2EndIdx);

    // Full sequence: both reads start, both reads end, then write
    expect(order.slice(0, 2).sort()).toEqual(['read1-start', 'read2-start']);
    expect(order.slice(2, 4).sort()).toEqual(['read1-end', 'read2-end']);
    expect(order[4]).toBe('write');
  });

  it('catches tool execution errors and returns them as results', async () => {
    const failing = makeTool('fail', false, async () => {
      throw new Error('kaboom');
    });
    const dispatcher = new ToolDispatcher([failing]);

    const results = await dispatcher.dispatch([{ name: 'fail', input: {} }]);
    expect(results[0].result.success).toBe(false);
    expect(results[0].result.output).toContain('kaboom');
  });

  it('respects permission check and denies tool execution', async () => {
    const tool = makeTool('blocked', false);
    const dispatcher = new ToolDispatcher([tool]);

    const results = await dispatcher.dispatch(
      [{ name: 'blocked', input: {} }],
      async () => ({ allowed: false, reason: 'test deny' }),
    );

    expect(results[0].result.success).toBe(false);
    expect(results[0].result.output).toContain('Permission denied');
  });

  it('records dispatch, permission, and tool spans when tracing is enabled', async () => {
    const tracer = new RuntimeTracer();
    const tool = makeTool('traced', false);
    const dispatcher = new ToolDispatcher([tool]);

    await dispatcher.dispatch(
      [{ name: 'traced', input: {} }],
      async () => ({ allowed: true }),
      undefined,
      { tracer },
    );

    expect(tracer.snapshot().spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tool.dispatch', status: 'ok' }),
      expect.objectContaining({ name: 'permission.check', status: 'ok' }),
      expect.objectContaining({ name: 'tool.execute', status: 'ok' }),
    ]));
  });

  describe('tool name aliases', () => {
    it.each([
      ['search', 'grep'],
      ['ripgrep', 'grep'],
      ['rg', 'grep'],
      ['read_file', 'file_read'],
      ['cat', 'file_read'],
      ['write_file', 'file_write'],
      ['create_file', 'file_write'],
      ['edit', 'file_edit'],
      ['patch', 'file_edit'],
      ['ls', 'list_files'],
      ['list_dir', 'list_files'],
      ['shell', 'bash'],
      ['exec', 'bash'],
      ['run', 'bash'],
    ])('aliases %s -> %s when the canonical tool is registered', async (alias, canonical) => {
      const tool = makeTool(canonical, false, async () => ({ success: true, output: `${canonical} executed` }));
      const dispatcher = new ToolDispatcher([tool]);

      const results = await dispatcher.dispatch([{ name: alias, input: { x: 1 } }]);

      expect(results).toHaveLength(1);
      expect(results[0].result.success).toBe(true);
      expect(results[0].result.output).toBe(`${canonical} executed`);
      // The dispatched call should be rewritten to the canonical name so
      // tracing, hooks, and learning all see a consistent identifier.
      expect(results[0].call.name).toBe(canonical);
      expect(results[0].call.input).toEqual({ x: 1 });
    });

    it('does not alias when the canonical tool is not registered', async () => {
      // No file_write tool registered, so 'write_file' should fall through
      // and surface as an unknown tool rather than silently succeeding.
      const dispatcher = new ToolDispatcher([makeTool('grep', true)]);

      const results = await dispatcher.dispatch([{ name: 'write_file', input: {} }]);

      expect(results[0].result.success).toBe(false);
      expect(results[0].result.output).toContain('Unknown tool');
      expect(results[0].result.output).toContain('write_file');
    });

    it('does not alias when the requested name is itself a registered tool', async () => {
      // If a project happens to register a literal 'search' tool, the alias
      // must defer to the real registration rather than rewriting it to grep.
      const realSearch = makeTool('search', true, async () => ({ success: true, output: 'real search' }));
      const realGrep = makeTool('grep', true, async () => ({ success: true, output: 'real grep' }));
      const dispatcher = new ToolDispatcher([realSearch, realGrep]);

      const results = await dispatcher.dispatch([{ name: 'search', input: {} }]);

      expect(results[0].call.name).toBe('search');
      expect(results[0].result.output).toBe('real search');
    });
  });
});
