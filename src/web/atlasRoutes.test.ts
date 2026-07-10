import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { createAtlasRouter, buildAtlasMap, parsePlanTasks } from './atlasRoutes';
import type { AtlasMap } from './atlasRoutes';

describe('buildAtlasMap', () => {
  const fixedNow = () => new Date('2026-06-22T12:00:00.000Z');

  it('joins plan tasks with history into file and task nodes', () => {
    const map = buildAtlasMap({
      now: fixedNow,
      planTasks: [
        { id: 'setup-express', title: 'Create Express server', status: 'done', anchors: ['src/server.ts'], target: 'src/server.ts' },
        { id: 'add-health', title: 'Add health endpoint', status: 'pending', anchors: [], target: 'src/health.ts' },
      ],
      historyEntries: [
        { timestamp: '2026-06-22T10:00:00.000Z', taskId: 'setup-express', taskTitle: 'Create Express server', status: 'done', changedFiles: ['src/server.ts'], model: 'm' },
        { timestamp: '2026-06-22T11:00:00.000Z', taskId: 'setup-express', taskTitle: 'Create Express server', status: 'done', changedFiles: ['src/server.ts', 'package.json'], model: 'm' },
      ],
    });

    expect(map.summary).toEqual({
      filesTracked: 2,
      tasksTotal: 2,
      tasksDone: 1,
      tasksPending: 1,
      tasksFailed: 0,
      lastActivityAt: '2026-06-22T11:00:00.000Z',
    });

    const server = map.files.find((f) => f.path === 'src/server.ts');
    expect(server).toMatchObject({
      path: 'src/server.ts',
      changeCount: 2,
      lastChangedAt: '2026-06-22T11:00:00.000Z',
      lastChangedByTaskId: 'setup-express',
      planStatus: 'done',
    });

    const setup = map.tasks.find((t) => t.id === 'setup-express');
    expect(setup).toMatchObject({
      id: 'setup-express',
      planStatus: 'done',
      runCount: 2,
      lastRunStatus: 'done',
      inPlan: true,
      inHistory: true,
    });
    expect(setup?.changedFiles).toEqual(['package.json', 'src/server.ts']);

    // A planned-but-never-run task is present with zero runs.
    const health = map.tasks.find((t) => t.id === 'add-health');
    expect(health).toMatchObject({ runCount: 0, inPlan: true, inHistory: false });
  });

  it('preserves plan order and appends history-only (orphan) tasks last', () => {
    const map = buildAtlasMap({
      now: fixedNow,
      planTasks: [{ id: 'a', title: 'A', status: 'pending', anchors: [] }],
      historyEntries: [
        { timestamp: '2026-06-22T09:00:00.000Z', taskId: 'removed-task', taskTitle: 'Old work', status: 'done', changedFiles: ['old.ts'] },
      ],
    });
    expect(map.tasks.map((t) => t.id)).toEqual(['a', 'removed-task']);
    const orphan = map.tasks.find((t) => t.id === 'removed-task');
    expect(orphan).toMatchObject({ inPlan: false, inHistory: true, title: 'Old work' });
  });

  it('sorts files most-recently-changed first', () => {
    const map = buildAtlasMap({
      now: fixedNow,
      planTasks: [],
      historyEntries: [
        { timestamp: '2026-06-22T08:00:00.000Z', taskId: 't1', changedFiles: ['early.ts'] },
        { timestamp: '2026-06-22T09:00:00.000Z', taskId: 't2', changedFiles: ['late.ts'] },
      ],
    });
    expect(map.files.map((f) => f.path)).toEqual(['late.ts', 'early.ts']);
  });

  it('tolerates entries with no changed files or no timestamp', () => {
    const map = buildAtlasMap({
      now: fixedNow,
      planTasks: [],
      historyEntries: [
        { taskId: 'research-task', status: 'done' },
        { taskId: 'research-task', status: 'done', changedFiles: [] },
      ],
    });
    expect(map.summary.filesTracked).toBe(0);
    expect(map.tasks.find((t) => t.id === 'research-task')?.runCount).toBe(2);
  });
});

describe('parsePlanTasks', () => {
  it('parses status markers, ids, titles, anchors, and target', () => {
    const tasks = parsePlanTasks([
      '- [ ] setup-express — Create Express server with health check',
      '  - anchor: src/server.ts',
      '  - target: src/server.ts',
      '- [x] add-tests — Add unit tests',
      '- [!] broken — Failed task',
    ].join('\n'));
    expect(tasks).toEqual([
      { id: 'setup-express', title: 'Create Express server with health check', status: 'pending', anchors: ['src/server.ts'], target: 'src/server.ts' },
      { id: 'add-tests', title: 'Add unit tests', status: 'done', anchors: [] },
      { id: 'broken', title: 'Failed task', status: 'failed', anchors: [] },
    ]);
  });
});

describe('atlas route API', () => {
  let projectDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-routes-'));
    const app = express();
    app.use(createAtlasRouter({ projectDir }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns an empty map for an un-planned, never-run workspace', async () => {
    const res = await fetch(`${baseUrl}/api/atlas/map`);
    expect(res.status).toBe(200);
    const body = await res.json() as AtlasMap;
    expect(body.summary.filesTracked).toBe(0);
    expect(body.summary.tasksTotal).toBe(0);
    expect(body.files).toEqual([]);
    expect(body.tasks).toEqual([]);
  });

  it('synthesizes a map from plan + history files on disk', async () => {
    fs.writeFileSync(path.join(projectDir, 'IMPLEMENTATION_PLAN.md'), [
      '- [x] setup-express — Create Express server',
      '  - target: src/server.ts',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, '.forge-history.jsonl'), [
      JSON.stringify({ timestamp: '2026-06-22T10:00:00.000Z', taskId: 'setup-express', taskTitle: 'Create Express server', status: 'done', changedFiles: ['src/server.ts'] }),
      '', // tolerate trailing blank line
    ].join('\n'));

    const res = await fetch(`${baseUrl}/api/atlas/map`);
    expect(res.status).toBe(200);
    const body = await res.json() as AtlasMap;
    expect(body.summary.tasksTotal).toBe(1);
    expect(body.summary.filesTracked).toBe(1);
    expect(body.files[0]).toMatchObject({ path: 'src/server.ts', planStatus: 'done' });
    expect(body.tasks[0]).toMatchObject({ id: 'setup-express', runCount: 1, inPlan: true, inHistory: true });
  });
});
