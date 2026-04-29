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
});
