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
  // Track registries created inside a test so afterEach can drain any
  // in-flight persist writes before rm'ing the temp dir. Without this the
  // fire-and-forget persist from startRun/pause/resume/cancel can race the
  // directory removal and surface as ENOENT noise.
  let registriesUnderTest: WorkflowRegistry[] = [];

  function track<T extends WorkflowRegistry>(registry: T): T {
    registriesUnderTest.push(registry);
    return registry;
  }

  beforeEach(async () => {
    workflowsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-workflows-'));
    registriesUnderTest = [];
  });

  afterEach(async () => {
    for (const registry of registriesUnderTest) {
      await registry.flush();
    }
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

    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
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
    const registry = track(new WorkflowRegistry(workflowsDir));
    const defs = await registry.list();
    expect(defs.some((d) => d.name === 'json-workflow')).toBe(true);
  });

  it('listRuns returns all runs sorted by startedAt descending', async () => {
    await writeWorkflow(workflowsDir, 'lr.yaml', 'name: lr\nsteps:\n  - id: s\n    tool: t\n    input: {}');
    const registry = track(new WorkflowRegistry(workflowsDir));
    const def = (await registry.list())[0];
    registry.startRun(def);
    registry.startRun(def);
    const runs = registry.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt >= runs[1].startedAt).toBe(true);
  });

  it('fails when step references unknown tool', async () => {
    await writeWorkflow(workflowsDir, 'unknown-tool.yaml', 'name: unknown\nsteps:\n  - id: bad\n    tool: nonexistent\n    input: {}');
    const registry = track(new WorkflowRegistry(workflowsDir));
    const def = (await registry.list())[0];
    const run = registry.startRun(def);
    const tools: Tool[] = [];
    const permissions = new PermissionEngine([], 'dontAsk');
    const result = await registry.execute(run.id, { tools, permissions });
    expect(result.status).toBe('failed');
    expect(result.steps[0].error).toContain('Unknown tool');
  });

  it('returns empty list from empty workflows directory', async () => {
    const registry = track(new WorkflowRegistry(workflowsDir));
    const defs = await registry.list();
    expect(defs).toEqual([]);
  });

  describe('run persistence', () => {
    async function writeSimpleDef(): Promise<void> {
      await writeWorkflow(workflowsDir, 'persist.yaml', [
        'name: persist',
        'steps:',
        '  - id: a',
        '    tool: t',
        '    input: { v: 1 }',
        '  - id: b',
        '    tool: t',
        '    input: { v: 2 }',
      ].join('\n'));
    }

    function runFilePath(runId: string): string {
      return path.join(workflowsDir, 'runs', `${runId}.json`);
    }

    it('persists a completed run to disk that a fresh registry can restore', async () => {
      await writeSimpleDef();
      const first = track(new WorkflowRegistry(workflowsDir));
      const def = (await first.list())[0];
      const run = first.startRun(def);
      const tools = [makeTool('t', true, 'ok')];
      const permissions = new PermissionEngine([], 'dontAsk');
      const completed = await first.execute(run.id, { tools, permissions });
      expect(completed.status).toBe('completed');
      await first.flush();

      const persistedRaw = await fs.readFile(runFilePath(run.id), 'utf-8');
      const persisted = JSON.parse(persistedRaw);
      expect(persisted.status).toBe('completed');
      expect(persisted.steps).toHaveLength(2);
      expect(persisted.steps.every((s: { status: string }) => s.status === 'completed')).toBe(true);

      // Simulate a server restart: brand new registry instance over the same dir.
      const restored = track(new WorkflowRegistry(workflowsDir));
      const counts = await restored.restoreRuns();
      expect(counts).toEqual({ restored: 1, demoted: 0 });
      const seen = restored.listRuns();
      expect(seen).toHaveLength(1);
      expect(seen[0].id).toBe(run.id);
      expect(seen[0].status).toBe('completed');
    });

    it('demotes a run found in running status to failed on restore (no auto-resume)', async () => {
      // Hand-craft an "interrupted" run file. We do not actually crash the
      // executor mid-step in this test \u2014 the file represents what would be on
      // disk after a hard kill while runStep was awaiting tool.execute().
      const runsDir = path.join(workflowsDir, 'runs');
      await fs.mkdir(runsDir, { recursive: true });
      const inflight = {
        id: 'run-inflight-1',
        workflowName: 'persist',
        status: 'running',
        dryRun: false,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        variables: {},
        steps: [
          { step: { id: 'a', tool: 't' }, status: 'completed', startedAt: 'x', finishedAt: 'y', result: { success: true, output: 'ok' } },
          { step: { id: 'b', tool: 't' }, status: 'running', startedAt: 'z' },
        ],
        currentStepIndex: 1,
      };
      await fs.writeFile(path.join(runsDir, 'run-inflight-1.json'), JSON.stringify(inflight), 'utf-8');

      const registry = track(new WorkflowRegistry(workflowsDir));
      const counts = await registry.restoreRuns();
      expect(counts).toEqual({ restored: 1, demoted: 1 });
      const restored = registry.getRun('run-inflight-1');
      expect(restored?.status).toBe('failed');
      expect(restored?.finishedAt).toBeDefined();
      expect(restored?.steps[0].status).toBe('completed');
      expect(restored?.steps[1].status).toBe('failed');
      expect(restored?.steps[1].error).toContain('not auto-resumed');

      // Re-persisted demotion must be idempotent: a second restore on the
      // same dir reports 0 demoted because the file now says 'failed'.
      await registry.flush();
      const second = track(new WorkflowRegistry(workflowsDir));
      const counts2 = await second.restoreRuns();
      expect(counts2).toEqual({ restored: 1, demoted: 0 });
    });

    it('demotes a pending run that never began executing', async () => {
      const runsDir = path.join(workflowsDir, 'runs');
      await fs.mkdir(runsDir, { recursive: true });
      const pendingRun = {
        id: 'run-pending-1',
        workflowName: 'persist',
        status: 'pending',
        dryRun: false,
        startedAt: new Date().toISOString(),
        variables: {},
        steps: [{ step: { id: 'a', tool: 't' }, status: 'pending' }],
        currentStepIndex: 0,
      };
      await fs.writeFile(path.join(runsDir, 'run-pending-1.json'), JSON.stringify(pendingRun), 'utf-8');

      const registry = track(new WorkflowRegistry(workflowsDir));
      const counts = await registry.restoreRuns();
      expect(counts).toEqual({ restored: 1, demoted: 1 });
      const restored = registry.getRun('run-pending-1');
      expect(restored?.status).toBe('failed');
      // The step itself was never running, so it must stay pending; only
      // currently-running steps get the recovery error.
      expect(restored?.steps[0].status).toBe('pending');
    });

    it('skips malformed run files without throwing', async () => {
      const runsDir = path.join(workflowsDir, 'runs');
      await fs.mkdir(runsDir, { recursive: true });
      await fs.writeFile(path.join(runsDir, 'broken.json'), '{ not valid json', 'utf-8');
      await fs.writeFile(path.join(runsDir, 'wrong-shape.json'), '{"hello": "world"}', 'utf-8');

      const registry = track(new WorkflowRegistry(workflowsDir));
      const counts = await registry.restoreRuns();
      expect(counts).toEqual({ restored: 0, demoted: 0 });
    });

    it('returns zeros when the runs directory does not exist', async () => {
      const registry = track(new WorkflowRegistry(workflowsDir));
      const counts = await registry.restoreRuns();
      expect(counts).toEqual({ restored: 0, demoted: 0 });
    });

    it('persists a paused run so a fresh registry sees it as paused', async () => {
      await writeSimpleDef();
      const first = track(new WorkflowRegistry(workflowsDir));
      const def = (await first.list())[0];
      const run = first.startRun(def);
      first.pause(run.id, 'manual hold');
      await first.flush();

      const persistedRaw = await fs.readFile(runFilePath(run.id), 'utf-8');
      expect(JSON.parse(persistedRaw).status).toBe('paused');

      const restored = track(new WorkflowRegistry(workflowsDir));
      await restored.restoreRuns();
      const seen = restored.getRun(run.id);
      expect(seen?.status).toBe('paused');
      expect(seen?.pauseReason).toBe('manual hold');
    });

    it('persists run-level cancellation reason', async () => {
      await writeSimpleDef();
      const first = track(new WorkflowRegistry(workflowsDir));
      const def = (await first.list())[0];
      const run = first.startRun(def);
      first.cancel(run.id, 'operator stop');
      const tools = [makeTool('t', true, 'ok')];
      const permissions = new PermissionEngine([], 'dontAsk');
      await first.execute(run.id, { tools, permissions });
      await first.flush();

      const restored = track(new WorkflowRegistry(workflowsDir));
      await restored.restoreRuns();
      const seen = restored.getRun(run.id);
      expect(seen?.status).toBe('cancelled');
      expect(seen?.cancelReason).toBe('operator stop');
    });

    it('concurrent step persists on a single run do not lose state (race coverage)', async () => {
      // Two parallel mutator chains on different runs must not corrupt each
      // other; each run owns its own lock keyed by file path. This is the
      // multi-run analogue of the per-store race tests added in v0.5.1.
      await writeSimpleDef();
      const registry = track(new WorkflowRegistry(workflowsDir));
      const def = (await registry.list())[0];
      const tools = [makeTool('t', true, 'ok')];
      const permissions = new PermissionEngine([], 'dontAsk');

      const runs = Array.from({ length: 4 }, () => registry.startRun(def));
      await Promise.all(runs.map((r) => registry.execute(r.id, { tools, permissions })));
      await registry.flush();

      // Every run-file must be present and parse as completed.
      const entries = await fs.readdir(path.join(workflowsDir, 'runs'));
      expect(entries.filter((e) => e.endsWith('.json'))).toHaveLength(4);
      for (const run of runs) {
        const persisted = JSON.parse(await fs.readFile(runFilePath(run.id), 'utf-8'));
        expect(persisted.id).toBe(run.id);
        expect(persisted.status).toBe('completed');
      }
      // No orphaned temp files left behind.
      const orphans = entries.filter((e) => e.includes('.tmp.'));
      expect(orphans).toEqual([]);
    });
  });
});
