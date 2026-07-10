import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { createWorkingMemoryRouter } from './workingMemoryRoutes';
import { SessionStorage } from '../persistence/sessionStorage';

describe('working-memory route API', () => {
  let projectDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-routes-'));
    const app = express();
    app.use(createWorkingMemoryRouter({ projectDir }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns null when no session exists', async () => {
    const res = await fetch(`${baseUrl}/api/working-memory`);
    expect(res.status).toBe(200);
    const body = await res.json() as { workingMemory: unknown };
    expect(body.workingMemory).toBeNull();
  });

  it('returns the latest checkpoint mapped into working memory', async () => {
    const storage = new SessionStorage(projectDir, 'test-model');
    await storage.initialize();
    await storage.append('continuity_checkpoint', {
      kind: 'continuity_checkpoint',
      checkpoint: {
        sessionId: storage.getSessionId(),
        timestamp: '2026-06-11T00:00:00.000Z',
        summary: 's',
        currentGoal: 'Govern the loop',
        recentMessages: [],
        pendingToolCalls: ['web_fetch'],
        openQuestions: ['threshold?'],
        nextAction: 'review',
        tokenEstimate: 10,
        contextPressure: 0.1,
        strategy: 'snip',
      },
    });

    const res = await fetch(`${baseUrl}/api/working-memory`);
    expect(res.status).toBe(200);
    const body = await res.json() as { workingMemory: { currentGoal: string; openQuestions: string[]; blocked: string[] } };
    expect(body.workingMemory.currentGoal).toBe('Govern the loop');
    expect(body.workingMemory.openQuestions).toEqual(['threshold?']);
    expect(body.workingMemory.blocked).toEqual(['pending: web_fetch']);
  });
});
