import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import express from 'express';
import { createRunRouter } from './runRoutes';
import { RunLog } from '../persistence/runLog';
import { recordSideEffect } from '../persistence/sideEffectLedger';

describe('run routes', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let authorised = true;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-routes-'));
    const app = express();
    app.use(express.json());
    app.use(createRunRouter({
      projectDir: dir,
      requireAuth: (_req, res) => {
        if (!authorised) res.status(401).json({ error: 'auth required' });
        return authorised;
      },
      logger: { info: () => {} },
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedRun(runId: string): Promise<void> {
    const log = new RunLog(dir, runId);
    log.startLoop({ model: 'fixture', sessionId: 's1' });
    const step1 = log.nextStep('t1.1');
    const step2 = log.nextStep('t2.1');
    log.append('tool_call', { name: 'file_write', input: { path: 'a.txt' } }, step1);
    log.append('tool_call', { name: 'file_write', input: { path: 'b.txt' } }, step2);
    log.append('run_end', { reason: 'completed', turns: 2 });
    await log.flush();
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    await fs.writeFile(path.join(dir, 'b.txt'), 'b');
    await recordSideEffect(dir, { runId, kind: 'file_create', description: 'created a.txt', reversal: { kind: 'delete_file', path: 'a.txt' }, stepId: 't1.1', stepSeq: step1.stepSeq });
    await recordSideEffect(dir, { runId, kind: 'file_create', description: 'created b.txt', reversal: { kind: 'delete_file', path: 'b.txt' }, stepId: 't2.1', stepSeq: step2.stepSeq });
  }

  it('lists runs and returns one run with filtered events and side effects', async () => {
    await seedRun('run-routes-1');
    const list = await (await fetch(`${base}/api/run-logs`)).json() as { runs: Array<{ runId: string; model: string }> };
    expect(list.runs).toEqual([expect.objectContaining({ runId: 'run-routes-1', model: 'fixture' })]);

    const detail = await (await fetch(`${base}/api/run-logs/run-routes-1?kinds=tool_call`)).json() as { summary: { reason: string }; events: Array<{ kind: string }>; sideEffects: unknown[] };
    expect(detail.summary.reason).toBe('completed');
    expect(detail.events.map((event) => event.kind)).toEqual(['tool_call', 'tool_call']);
    expect(detail.sideEffects).toHaveLength(2);
  });

  it('rejects bad ids, unknown runs, bad steps and unauthorised reverts', async () => {
    expect((await fetch(`${base}/api/run-logs/..%2Fescape`)).status).toBe(400);
    expect((await fetch(`${base}/api/run-logs/missing-run`)).status).toBe(404);
    const badStep = await fetch(`${base}/api/run-logs/run-routes-1/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toStepSeq: -1 }) });
    expect(badStep.status).toBe(400);
    authorised = false;
    try {
      expect((await fetch(`${base}/api/run-logs/run-routes-1/revert`, { method: 'POST' })).status).toBe(401);
    } finally {
      authorised = true;
    }
  });

  it('reverts to a step, then the whole run', async () => {
    await seedRun('run-routes-2');
    const toStep = await (await fetch(`${base}/api/run-logs/run-routes-2/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toStepSeq: 1 }) })).json() as { reverted: string[] };
    expect(toStep.reverted).toEqual(['created b.txt']);
    await expect(fs.access(path.join(dir, 'b.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf-8')).toBe('a');

    const all = await (await fetch(`${base}/api/run-logs/run-routes-2/revert`, { method: 'POST' })).json() as { reverted: string[]; alreadyReversed: number };
    expect(all.reverted).toEqual(['created a.txt']);
    expect(all.alreadyReversed).toBe(1);
  });

  it('reports a missing git checkpoint for git-mode revert', async () => {
    const response = await fetch(`${base}/api/run-logs/run-routes-1/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'git' }) });
    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toMatch(/No git checkpoint/);
  });
});
