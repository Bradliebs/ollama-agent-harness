import type { Server } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app, stopUploadsAutoPrune } from './server';

jest.setTimeout(15_000);

describe('GET /api/autonomy/state', () => {
  let server: Server;
  let baseUrl: string;
  const statePath = path.join(process.cwd(), '.forge-state.json');
  let originalState: string | null = null;

  beforeAll(async () => {
    try {
      originalState = await fs.readFile(statePath, 'utf-8');
    } catch {
      originalState = null;
    }
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopUploadsAutoPrune();
    if (originalState === null) {
      await fs.rm(statePath, { force: true });
    } else {
      await fs.writeFile(statePath, originalState, 'utf-8');
    }
  });

  it('returns 204 when no autonomy run has happened', async () => {
    await fs.rm(statePath, { force: true });
    const response = await fetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(204);
  });

  it('returns the parsed checkpoint when .forge-state.json exists', async () => {
    const checkpoint = {
      iteration: 7,
      startedAt: '2026-05-02T10:00:00.000Z',
      lastTaskId: 'verify-something',
      lastTaskTitle: 'Add a verification test',
      lastTaskStatus: 'done',
      lastTaskElapsedMs: 12345,
      lastTaskFilesChanged: 2,
      totalDone: 18,
      totalFailed: 1,
      totalPending: 5,
    };
    await fs.writeFile(statePath, JSON.stringify(checkpoint), 'utf-8');

    const response = await fetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(checkpoint);
  });

  it('returns 500 with a readable error when the file is malformed JSON', async () => {
    await fs.writeFile(statePath, '{ not json', 'utf-8');
    const response = await fetch(`${baseUrl}/api/autonomy/state`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/JSON|parse|token/i);
  });
});
