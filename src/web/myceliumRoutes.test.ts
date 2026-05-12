import type { Server } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app, setWebRuntimeOverrides, stopUploadsAutoPrune } from './server';
import type { LoopEvent } from '../types';

jest.setTimeout(30_000);

describe('web mycelium route API validation', () => {
  let server: Server;
  let baseUrl: string;
  let originalSettings: string | null = null;
  let originalGraph: string | null = null;
  const settingsPath = path.join(process.cwd(), '.harness', 'settings.json');
  const graphPath = path.join(process.cwd(), '.harness', 'mycelium', 'graph.json');

  beforeAll(async () => {
    try {
      originalSettings = await fs.readFile(settingsPath, 'utf-8');
    } catch {
      originalSettings = null;
    }
    try {
      originalGraph = await fs.readFile(graphPath, 'utf-8');
    } catch {
      originalGraph = null;
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
      server.close((error) => error ? reject(error) : resolve());
    });
    stopUploadsAutoPrune();
    await restoreFile(settingsPath, originalSettings);
    await restoreFile(graphPath, originalGraph);
  });

  async function request(route: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${route}`, init);
  }

  it('returns mycelium graph data via GET /api/mycelium', async () => {
    const response = await request('/api/mycelium');
    expect(response.status).toBe(200);
    const body = await response.json() as { stats: { nodes: number; protectedNodes?: number; archivedEdges?: number }; nodes: unknown[]; edges: unknown[]; episodes: unknown[]; archivedEdges: unknown[] };
    expect(body.stats).toBeDefined();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.episodes)).toBe(true);
    expect(Array.isArray(body.archivedEdges)).toBe(true);
  });

  it('returns last route data via GET /api/mycelium/last-route', async () => {
    const response = await request('/api/mycelium/last-route');
    expect(response.status).toBe(200);
    const body = await response.json() as { episode: unknown; nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it('resets mycelium graph via DELETE /api/mycelium', async () => {
    const response = await request('/api/mycelium', { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reset: true });
  });

  it('rejects mycelium feedback with an invalid vote', async () => {
    const response = await request('/api/mycelium/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: 'maybe' }),
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 when feedback is sent with no recorded episode', async () => {
    await request('/api/mycelium', { method: 'DELETE' });
    const response = await request('/api/mycelium/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: 'up' }),
    });
    expect(response.status).toBe(404);
  });

  it('records mycelium episode with blocked=true when output_validation fails', async () => {
    await request('/api/mycelium', { method: 'DELETE' });
    const { runMyceliumCli } = await import('../mycelium/cli');
    await runMyceliumCli({ projectDir: process.cwd(), args: ['seed'] });

    await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputValidation: { enabled: true, profile: 'coding-answer' },
        agentName: '',
        agentAvatar: '',
        agentPersonality: '',
      }),
    });

    const restore = setWebRuntimeOverrides({
      createClient: jest.fn(() => ({}) as never),
      getModelContextWindow: jest.fn().mockResolvedValue(8192),
      getTools: () => [],
      createPermissionEngine: () => ({ evaluate: jest.fn() }) as never,
      createSession: () => ({
        initialize: jest.fn().mockResolvedValue(undefined),
        markStatus: jest.fn().mockResolvedValue(undefined),
        append: jest.fn().mockResolvedValue(undefined),
        readAll: jest.fn().mockResolvedValue([]),
        getSessionId: jest.fn().mockReturnValue('blocked-session'),
      }) as never,
      startNewSession: jest.fn(),
      getEvolvedPrompt: async (basePrompt) => basePrompt,
      assembleSystemContext: async ({ systemPrompt }) => systemPrompt,
      runQueryLoop: async function* (): AsyncGenerator<LoopEvent> {
        yield { type: 'output_validation', validation: { profile: 'coding-answer', status: 'fail', score: 0.1, findings: [], missingSections: [] } };
        yield { type: 'text', content: 'Done.' };
        yield { type: 'done', reason: 'completed', turns: 1 };
      },
      onSessionEnd: async () => ({ reflection: { insights: [] }, newPatterns: [] }),
      rebuildSemanticMemory: async () => [],
    });

    try {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Plan a workflow for code review with the verifier agent', model: 'test-model' }),
      });
      expect(response.status).toBe(200);
      await response.text();

      const lastRoute = await request('/api/mycelium/last-route');
      expect(lastRoute.status).toBe(200);
      const body = await lastRoute.json() as { episode: { blocked?: boolean; blockReason?: string; appliedVerifiers?: string[]; rewardComponents?: Record<string, number> } | null };
      expect(body.episode).not.toBeNull();
      expect(body.episode!.blocked).toBe(true);
      expect(body.episode!.blockReason).toMatch(/fail|hard|verifier/i);
      expect(body.episode!.appliedVerifiers).toEqual(expect.arrayContaining(['verifier.task_completion']));
    } finally {
      restore();
    }
  });
});

async function restoreFile(filePath: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}