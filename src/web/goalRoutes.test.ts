import type { Server } from 'http';
import express from 'express';
import http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGoalRouter } from './goalRoutes';
import { createGoal, transitionGoal } from '../goal/store';
import { writeFileTracked } from '../persistence/recordingFileOps';
import { readAuditLog } from '../permissions/audit';
import { _resetFileLocksForTest } from '../persistence/atomicFile';
import { _resetRunRegistryForTest } from '../goal/runRegistry';
import type { Goal } from '../goal/types';

jest.setTimeout(20_000);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-routes-test-'));
}
async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function noopRunner(): () => Promise<{ action: string }> {
  return async () => ({ action: 'noop' });
}

interface TestHarness {
  server: Server;
  baseUrl: string;
  projectDir: string;
}

async function startHarness(overrides?: Partial<Parameters<typeof createGoalRouter>[0]>): Promise<TestHarness> {
  const projectDir = await makeTempDir();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const router = createGoalRouter({
    projectDir,
    makeRunner: noopRunner,
    ...overrides,
  });
  app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, projectDir };
}

async function stopHarness(h: TestHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => h.server.close((err) => err ? reject(err) : resolve()));
  await cleanup(h.projectDir);
}

describe('web/goalRoutes', () => {
  let h: TestHarness;
  beforeEach(() => { _resetFileLocksForTest(); _resetRunRegistryForTest(); });
  afterEach(async () => { if (h) await stopHarness(h); });

  it('POST /api/goals creates and GET /api/goals lists', async () => {
    h = await startHarness();
    const create = await fetch(`${h.baseUrl}/api/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'do thing' }),
    });
    expect(create.status).toBe(201);
    const { goal } = await create.json() as { goal: Goal };
    expect(goal.target).toBe('do thing');
    expect(goal.status).toBe('draft');

    const list = await fetch(`${h.baseUrl}/api/goals`);
    expect(list.status).toBe(200);
    const body = await list.json() as { goals: Goal[] };
    expect(body.goals.map((g) => g.id)).toContain(goal.id);
  });

  it('POST /api/goals returns 400 on missing target', async () => {
    h = await startHarness();
    const r = await fetch(`${h.baseUrl}/api/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/target/i);
  });

  it('GET /api/goals/:id returns 404 for unknown goal', async () => {
    h = await startHarness();
    const r = await fetch(`${h.baseUrl}/api/goals/nope`);
    expect(r.status).toBe(404);
  });

  it('GET /api/goals/active returns {kind:none} when no active goal', async () => {
    h = await startHarness();
    const r = await fetch(`${h.baseUrl}/api/goals/active`);
    expect(r.status).toBe(200);
    const body = await r.json() as { kind: string };
    expect(body.kind).toBe('none');
  });

  it('requireAuth gates create/pause/resume/abandon/start', async () => {
    h = await startHarness({ requireAuth: (_req, res) => { res.status(401).json({ error: 'no' }); return false; } });
    const create = await fetch(`${h.baseUrl}/api/goals`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 't' }),
    });
    expect(create.status).toBe(401);
  });

  it('POST /:id/pause transitions an active goal and clears in-flight run', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    await transitionGoal(h.projectDir, g.id, 'active');
    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/pause`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'human says wait' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { goal: Goal };
    expect(body.goal.status).toBe('paused');
    expect(body.goal.pause?.reason).toBe('human says wait');
  });

  it('POST /:id/resume re-activates a paused goal', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    await transitionGoal(h.projectDir, g.id, 'active');
    await transitionGoal(h.projectDir, g.id, 'paused', { pause: { reason: 'r', pausedAt: new Date().toISOString(), pausedBy: 'human' } });
    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/resume`, { method: 'POST' });
    expect(r.status).toBe(200);
    const { goal } = await r.json() as { goal: Goal };
    expect(goal.status).toBe('active');
  });

  it('POST /:id/abandon rejects already-terminal goals with 409', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    await transitionGoal(h.projectDir, g.id, 'active');
    await transitionGoal(h.projectDir, g.id, 'complete');
    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/abandon`, { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/start streams SSE events and ends with loop_end', async () => {
    h = await startHarness();
    // Goal with no checks → initial verification "passes" (0 of 0 required) → already_satisfied
    const g = await createGoal(h.projectDir, { target: 'instant' });
    const res = await fetch(`${h.baseUrl}/api/goals/${g.id}/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // SSE frames are `event: <type>\ndata: <json>\n\n`. We don't parse strictly;
    // we just assert the loop reached its terminal frame.
    expect(text).toContain('event: loop_end');
    expect(text).toMatch(/"reason":"already_satisfied"/);
  });

  it('POST /:id/start returns 409 for a terminal goal', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    await transitionGoal(h.projectDir, g.id, 'active');
    await transitionGoal(h.projectDir, g.id, 'abandoned');
    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/start`, { method: 'POST' });
    expect(r.status).toBe(409);
  });

  it('POST /:id/undo reverts files recorded under the goal as a unit', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    // Seed a recorded create under runId = goal.id.
    await writeFileTracked({ projectDir: h.projectDir, runId: g.id, filePath: 'made.txt', content: 'hi' });
    expect(await fs.readFile(path.join(h.projectDir, 'made.txt'), 'utf-8')).toBe('hi');

    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/undo`, { method: 'POST' });
    expect(r.status).toBe(200);
    const { result } = await r.json() as { result: { reverted: unknown[]; failed: unknown[] } };
    expect(result.reverted).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    await expect(fs.access(path.join(h.projectDir, 'made.txt'))).rejects.toThrow();
  });

  it('POST /:id/undo writes an audit entry recording the rollback', async () => {
    h = await startHarness();
    const g = await createGoal(h.projectDir, { target: 'x' });
    await writeFileTracked({ projectDir: h.projectDir, runId: g.id, filePath: 'made.txt', content: 'hi' });

    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/undo`, { method: 'POST' });
    expect(r.status).toBe(200);

    const entries = await readAuditLog(h.projectDir);
    const undoEntry = entries.find((e) => e.tool === 'goal_undo');
    expect(undoEntry).toBeDefined();
    expect(undoEntry?.input).toContain(g.id);
    expect(undoEntry?.output).toContain('reverted 1');
  });

  it('POST /:id/undo does not audit when auth is rejected', async () => {
    h = await startHarness({ requireAuth: (_req, res) => { res.status(401).json({ error: 'no' }); return false; } });
    const g = await createGoal(h.projectDir, { target: 'x' });
    await fetch(`${h.baseUrl}/api/goals/${g.id}/undo`, { method: 'POST' });
    const entries = await readAuditLog(h.projectDir);
    expect(entries.find((e) => e.tool === 'goal_undo')).toBeUndefined();
  });

  it('POST /:id/undo returns 404 for an unknown goal', async () => {
    h = await startHarness();
    const r = await fetch(`${h.baseUrl}/api/goals/nope/undo`, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('POST /:id/undo is gated by requireAuth', async () => {
    h = await startHarness({ requireAuth: (_req, res) => { res.status(401).json({ error: 'no' }); return false; } });
    const g = await createGoal(h.projectDir, { target: 'x' });
    const r = await fetch(`${h.baseUrl}/api/goals/${g.id}/undo`, { method: 'POST' });
    expect(r.status).toBe(401);
  });
});
