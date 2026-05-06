import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SelfLearningHeartbeat, createReflectAndLearnAction, createSkillEvolutionAction, createWorkAssignedTasksAction, readHeartbeatHistory, type HeartbeatAction } from './selfLearningHeartbeat';
import { createTask, recordCheckIn, getTask } from './taskStore';

describe('SelfLearningHeartbeat', () => {
  let projectDir: string;
  let lastRunMs = 0;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-heartbeat-'));
    lastRunMs = 0;
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  function makeOpts(overrides: Partial<ConstructorParameters<typeof SelfLearningHeartbeat>[0]> = {}) {
    return {
      projectDir,
      intervalMinutes: 1,
      tickMs: 1_000_000,
      isEnabled: () => true,
      isKillSwitchActive: () => false,
      getLastRunMs: () => lastRunMs,
      recordRunMs: (ts: number) => { lastRunMs = ts; },
      ...overrides,
    };
  }

  it('skips when disabled', async () => {
    const heartbeat = new SelfLearningHeartbeat(makeOpts({ isEnabled: () => false }));
    const result = await heartbeat.tick();
    expect(result.reason).toBe('disabled');
  });

  it('skips when kill switch is active', async () => {
    const heartbeat = new SelfLearningHeartbeat(makeOpts({ isKillSwitchActive: () => true }));
    const result = await heartbeat.tick();
    expect(result.reason).toBe('kill switch');
  });

  it('skips when interval has not elapsed', async () => {
    lastRunMs = Date.now();
    const heartbeat = new SelfLearningHeartbeat(makeOpts());
    const result = await heartbeat.tick();
    expect(result.reason).toBe('interval not elapsed');
  });

  it('runs all actions when interval elapsed', async () => {
    const calls: string[] = [];
    const fakeAction = (name: string): HeartbeatAction => ({
      name,
      async run() { calls.push(name); return { ok: true, summary: name }; },
    });
    const heartbeat = new SelfLearningHeartbeat(makeOpts({
      actions: [fakeAction('a'), fakeAction('b')],
    }));
    const result = await heartbeat.tick();
    expect(result.ranActions).toBe(true);
    expect(calls).toEqual(['a', 'b']);
    expect(result.results).toHaveLength(2);
  });

  it('continues running actions when one throws', async () => {
    const calls: string[] = [];
    const heartbeat = new SelfLearningHeartbeat(makeOpts({
      actions: [
        { name: 'boom', async run() { throw new Error('explode'); } },
        { name: 'ok', async run() { calls.push('ok'); return { ok: true, summary: 'ok' }; } },
      ],
    }));
    const result = await heartbeat.tick();
    expect(result.ranActions).toBe(true);
    expect(calls).toEqual(['ok']);
    expect(result.results?.[0].ok).toBe(false);
    expect(result.results?.[0].summary).toContain('boom threw');
  });

  it('default monitor_tasks action flags stale tasks as blocked', async () => {
    const task = await createTask(projectDir, { title: 'work' });
    await recordCheckIn(projectDir, task.id, { message: 'started' }, new Date(Date.now() - 60 * 60 * 1000));
    const heartbeat = new SelfLearningHeartbeat(makeOpts());
    await heartbeat.tick();
    const reread = await getTask(projectDir, task.id);
    expect(reread?.status).toBe('blocked');
  });

  it('createWorkAssignedTasksAction picks assigned tasks and marks them done', async () => {
    const task = await createTask(projectDir, { title: 'do thing', assigneeId: 'researcher' });
    expect(task.status).toBe('assigned');
    const calls: Array<{ taskId: string; agentId: string }> = [];
    const action = createWorkAssignedTasksAction({
      knownAgentIds: async () => new Set(['researcher', 'developer']),
      runner: async ({ task: t, agentId }) => { calls.push({ taskId: t.id, agentId }); return 'completed by ' + agentId; },
    });
    const heartbeat = new SelfLearningHeartbeat(makeOpts({ actions: [action] }));
    await heartbeat.tick();
    expect(calls).toEqual([{ taskId: task.id, agentId: 'researcher' }]);
    const reread = await getTask(projectDir, task.id);
    expect(reread?.status).toBe('done');
    expect(reread?.progressPercent).toBe(100);
  });

  it('createWorkAssignedTasksAction marks failed runs as failed and continues', async () => {
    const t1 = await createTask(projectDir, { title: 'a', assigneeId: 'researcher' });
    const t2 = await createTask(projectDir, { title: 'b', assigneeId: 'developer' });
    let call = 0;
    const action = createWorkAssignedTasksAction({
      knownAgentIds: async () => new Set(['researcher', 'developer']),
      runner: async () => { call += 1; if (call === 1) throw new Error('boom'); return 'done'; },
    });
    const heartbeat = new SelfLearningHeartbeat(makeOpts({ actions: [action] }));
    await heartbeat.tick();
    const a = await getTask(projectDir, t1.id);
    const b = await getTask(projectDir, t2.id);
    // The order depends on listTasks order; both outcomes (one done, one failed) must hold.
    const statuses = [a?.status, b?.status].sort();
    expect(statuses).toEqual(['done', 'failed']);
  });

  it('createWorkAssignedTasksAction skips tasks with unknown assignees', async () => {
    await createTask(projectDir, { title: 'lone', assigneeId: 'who-knows' });
    const action = createWorkAssignedTasksAction({
      knownAgentIds: async () => new Set(['researcher']),
      runner: async () => { throw new Error('should not be called'); },
    });
    const heartbeat = new SelfLearningHeartbeat(makeOpts({ actions: [action] }));
    const result = await heartbeat.tick();
    expect(result.results?.[0].summary).toContain('No assigned tasks ready');
  });

  it('records each tick to .harness/heartbeat/runs.jsonl', async () => {
    const calls: string[] = [];
    const fakeAction = (name: string): HeartbeatAction => ({
      name,
      async run() { calls.push(name); return { ok: true, summary: name }; },
    });
    const heartbeat = new SelfLearningHeartbeat(makeOpts({
      actions: [fakeAction('a'), fakeAction('b')],
    }));
    await heartbeat.tick();
    const history = await readHeartbeatHistory(projectDir);
    expect(history).toHaveLength(1);
    expect(history[0].actions.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(history[0].actions.every((entry) => typeof entry.durationMs === 'number')).toBe(true);
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('createReflectAndLearnAction', () => {
  let projectDir: string;
  beforeEach(async () => { projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-reflect-')); });
  afterEach(async () => { await fs.rm(projectDir, { recursive: true, force: true }); });

  it('returns ok with zero count when no reflections file exists', async () => {
    const action = createReflectAndLearnAction();
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
    expect((result.details as { reflections?: number }).reflections).toBe(0);
  });

  it('summarizes recent reflections from the JSONL log', async () => {
    const dir = path.join(projectDir, '.harness', 'learning');
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ sessionId: 's1', successRate: 0.5, insights: ['a'], suggestedImprovements: ['x'] }),
      JSON.stringify({ sessionId: 's2', successRate: 1.0, insights: ['b', 'c'], suggestedImprovements: [] }),
    ].join('\n');
    await fs.writeFile(path.join(dir, 'reflections.jsonl'), lines + '\n', 'utf-8');
    const action = createReflectAndLearnAction();
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
    const details = result.details as { sessions: number; insightCount: number; improvementCount: number; avgSuccessPercent: number };
    expect(details.sessions).toBe(2);
    expect(details.insightCount).toBe(3);
    expect(details.improvementCount).toBe(1);
    expect(details.avgSuccessPercent).toBe(75);
  });
});

describe('createSkillEvolutionAction', () => {
  let projectDir: string;
  beforeEach(async () => { projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skillevo-')); });
  afterEach(async () => { await fs.rm(projectDir, { recursive: true, force: true }); });

  it('returns ok with zero candidates on an empty skills dir', async () => {
    const action = createSkillEvolutionAction({});
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
    const details = result.details as { candidates: number };
    expect(details.candidates).toBe(0);
  });

  it('surfaces high-severity safety hits from active skill content', async () => {
    const skillsDir = path.join(projectDir, '.harness', 'skills', 'leaky');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'SKILL.md'),
      '---\nname: leaky\ndescription: leaky\ndomain: t\n---\n# leaky\nAKIAIOSFODNN7EXAMPLE',
      'utf-8',
    );
    const action = createSkillEvolutionAction({});
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
    const details = result.details as { safetyHits: Array<{ skill: string; severity: string }>; blockingSafetyHits: number };
    expect(details.safetyHits.find((hit) => hit.skill === 'leaky')).toBeTruthy();
    expect(details.blockingSafetyHits).toBeGreaterThanOrEqual(1);
    expect(result.summary).toMatch(/Safety: \d+ hit/);
  });
});

