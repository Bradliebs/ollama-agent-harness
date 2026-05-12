import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PermissionEngine } from '../permissions/engine';
import type { Tool, ToolResult } from '../types';
import { WorkflowRegistry } from './workflowRegistry';

function makeTool(name: string, isReadOnly: boolean, output: string, fail = false): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      if (fail) return { success: false, output: 'forced failure', error: 'forced failure' };
      return { success: true, output: `${output}::${JSON.stringify(input)}` };
    },
  };
}

async function writeWorkflow(dir: string, name: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body, 'utf-8');
}

describe('WorkflowRegistry', () => {
  let workflowsDir: string;

  beforeEach(async () => {
    workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-workflows-'));
  });

  afterEach(async () => {
    await fs.rm(workflowsDir, { recursive: true, force: true });
  });

  it('lists workflow definitions and resolves variables in step input', async () => {
    await writeWorkflow(workflowsDir, 'list-and-status.yaml', [
      'name: list-and-status',
      'description: Smoke workflow.',
      'risk_level: low',
      'variables:',
      '  greeting: hello',
      'steps:',
      '  - id: say',
      '    tool: echo',
      '    input:',
      '      message: "${variables.greeting} world"',
    ].join('\n'));

    const registry = new WorkflowRegistry(workflowsDir);
    const definitions = await registry.list();
    expect(definitions).toHaveLength(1);
    const def = definitions[0];
    expect(def.name).toBe('list-and-status');
    expect(def.steps).toHaveLength(1);

    const run = registry.startRun(def);
    const tools = [makeTool('echo', true, 'ok')];
    const permissions = new PermissionEngine([], 'dontAsk');
    const completed = await registry.execute(run.id, { tools, permissions });
    expect(completed.status).toBe('completed');
    expect(completed.steps[0].status).toBe('completed');
    expect(completed.steps[0].resolvedInput).toEqual({ message: 'hello world' });
    expect(completed.steps[0].result?.output).toContain('hello world');
  });

  it('respects dry-run mode without invoking tools', async () => {
    await writeWorkflow(workflowsDir, 'dry.yaml', [
      'name: dry',
      'steps:',
      '  - id: write',
      '    tool: file_write',
      '    input: { path: "out.txt", content: "x" }',
    ].join('\n'));
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def, { dryRun: true });
    let executed = false;
    const tools: Tool[] = [{
      name: 'file_write', description: '', parameters: {}, isReadOnly: false,
      async execute() { executed = true; return { success: true, output: 'ok' }; },
    }];
    const permissions = new PermissionEngine([], 'dontAsk');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(executed).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.steps[0].dryRun).toBe(true);
  });

  it('marks denied steps when the permission engine denies them', async () => {
    await writeWorkflow(workflowsDir, 'denied.yaml', [
      'name: denied',
      'steps:',
      '  - id: shell',
      '    tool: bash',
      '    input: { command: "ls" }',
    ].join('\n'));
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    const tools = [makeTool('bash', false, 'shell ok')];
    const permissions = new PermissionEngine([], 'default');
    permissions.engageKillSwitch('test stop');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('denied');
    expect(result.steps[0].permissionReason).toContain('test stop');
  });

  it('pause + resume continues from the next step', async () => {
    await writeWorkflow(workflowsDir, 'pausable.yaml', [
      'name: pausable',
      'steps:',
      '  - id: a',
      '    tool: t',
      '    input: { v: 1 }',
      '  - id: b',
      '    tool: t',
      '    input: { v: 2 }',
    ].join('\n'));
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    const tools = [makeTool('t', true, 'tool')];
    const permissions = new PermissionEngine([], 'dontAsk');
    // Pause before any step runs.
    registry.pause(run.id);
    const paused = await registry.execute(run.id, { tools, permissions });
    expect(paused.status).toBe('paused');
    expect(paused.steps[0].status).toBe('pending');
    expect(registry.resume(run.id)).toBe(true);
    const completed = await registry.execute(run.id, { tools, permissions });
    expect(completed.status).toBe('completed');
    expect(completed.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('cancel during execution stops further steps', async () => {
    await writeWorkflow(workflowsDir, 'cancellable.yaml', [
      'name: cancellable',
      'steps:',
      '  - id: a',
      '    tool: t',
      '    input: {}',
      '  - id: b',
      '    tool: t',
      '    input: {}',
    ].join('\n'));
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    registry.cancel(run.id, 'manual stop');
    const tools = [makeTool('t', true, 'tool')];
    const permissions = new PermissionEngine([], 'dontAsk');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(result.status).toBe('cancelled');
    expect(result.cancelReason).toBe('manual stop');
  });

  it('continues past failed steps when continueOnError is set', async () => {
    await writeWorkflow(workflowsDir, 'continue.yaml', [
      'name: continue-on-error',
      'steps:',
      '  - id: fail-ok',
      '    tool: broken',
      '    input: {}',
      '    continue_on_error: true',
      '  - id: after',
      '    tool: ok',
      '    input: {}',
    ].join('\n'));
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    const tools = [makeTool('broken', true, '', true), makeTool('ok', true, 'done')];
    const permissions = new PermissionEngine([], 'dontAsk');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(result.status).toBe('completed');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('completed');
  });

  it('loads JSON workflow definitions', async () => {
    await writeWorkflow(workflowsDir, 'json-test.json', JSON.stringify({
      name: 'json-workflow',
      steps: [{ id: 'echo-step', tool: 'echo', input: { msg: 'hi' } }],
    }));
    const registry = new WorkflowRegistry(workflowsDir);
    const defs = await registry.list();
    expect(defs.some((d) => d.name === 'json-workflow')).toBe(true);
  });

  it('listRuns returns all runs sorted by startedAt descending', async () => {
    await writeWorkflow(workflowsDir, 'lr.yaml', 'name: lr\nsteps:\n  - id: s\n    tool: t\n    input: {}');
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    registry.startRun(def);
    registry.startRun(def);
    const runs = registry.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt >= runs[1].startedAt).toBe(true);
  });

  it('fails when step references unknown tool', async () => {
    await writeWorkflow(workflowsDir, 'unknown-tool.yaml', 'name: unknown\nsteps:\n  - id: bad\n    tool: nonexistent\n    input: {}');
    const registry = new WorkflowRegistry(workflowsDir);
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    const tools: Tool[] = [];
    const permissions = new PermissionEngine([], 'dontAsk');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('Unknown tool');
  });

  it('returns empty list from empty workflows directory', async () => {
    const registry = new WorkflowRegistry(workflowsDir);
    const defs = await registry.list();
    expect(defs).toEqual([]);
  });
});
