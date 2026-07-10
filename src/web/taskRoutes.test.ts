import express from 'express';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { createTaskRoutesRouter, type CodexTaskRunner } from './taskRoutes';
import { createTask } from '../services/taskStore';

async function startServer(projectDir: string, runner?: CodexTaskRunner): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use(createTaskRoutesRouter({ projectDir, runCodexTask: runner }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('task routes Codex runner', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-task-routes-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('streams task execution events and moves completed runs to review', async () => {
    const runner: CodexTaskRunner = async ({ onEvent }) => {
      onEvent({ type: 'model', model: 'test-model' });
      onEvent({ type: 'done', status: 'completed', steps: 1 });
      return {
        status: 'completed',
        assistantText: 'done',
        toolCallCount: 0,
        toolSuccessCount: 0,
        verifications: [],
        capabilityGaps: [],
      };
    };
    const { baseUrl, server } = await startServer(projectDir, runner);
    try {
      const createResponse = await fetch(`${baseUrl}/api/codex/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Fix the parser bug and run tests.' }),
      });
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json() as { task: { id: string } };

      const runResponse = await fetch(`${baseUrl}/api/codex/tasks/${created.task.id}/run`, { method: 'POST' });
      expect(runResponse.status).toBe(200);
      const body = await runResponse.text();
      expect(body).toContain('"type":"task_status","status":"in_progress"');
      expect(body).toContain('"type":"model","model":"test-model"');
      expect(body).toContain('"type":"run_result"');
      expect(body).toContain('data: [DONE]');

      const statusResponse = await fetch(`${baseUrl}/api/codex/tasks/${created.task.id}/status`);
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json() as { task: { status: string; progressPercent: number } };
      expect(status.task.status).toBe('review');
      expect(status.task.progressPercent).toBe(95);
    } finally {
      await closeServer(server);
    }
  });

  it('returns 501 when no runner is configured', async () => {
    const task = await createTask(projectDir, {
      title: 'Manual Codex task',
      description: 'Do something.',
      priority: 'normal',
      metadata: {
        codex: {
          contract: {
            goal: 'Do something.',
            mode: 'execute',
            intent_type: 'code_edit',
            constraints: [],
            allowed_paths: [],
            blocked_paths: [],
            validation: [],
            success_criteria: [],
            failure_triggers: [],
            approval_required: false,
            max_turns: 1,
            high_risk: false,
            source: 'freeform',
          },
        },
      },
    });
    const { baseUrl, server } = await startServer(projectDir);
    try {
      const response = await fetch(`${baseUrl}/api/codex/tasks/${task.id}/run`, { method: 'POST' });
      expect(response.status).toBe(501);
    } finally {
      await closeServer(server);
    }
  });
});
