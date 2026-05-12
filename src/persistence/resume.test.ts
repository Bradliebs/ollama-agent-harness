import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from './sessionStorage';
import { resumeSession } from './resume';

describe('resumeSession', () => {
  it('uses the latest compact boundary as the continuity point', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-resume-'));
    const storage = new SessionStorage(projectDir, 'test-model', 'session-1');
    await storage.initialize();

    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'old request' },
    });
    await storage.append('assistant_message', {
      kind: 'message',
      message: { role: 'assistant', content: 'old answer' },
    });
    await storage.append('compact_boundary', {
      kind: 'compact_boundary',
      summary: 'old request and answer summarized',
      compactedCount: 2,
    });
    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'new request' },
    });

    const result = await resumeSession(projectDir, 'session-1', 'test-model');

    expect(result.messages).toEqual([
      { role: 'system', content: '[Compacted summary]\nold request and answer summarized' },
      { role: 'user', content: 'new request' },
    ]);
  });

  it('uses the latest continuity checkpoint as richer resume context', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-checkpoint-'));
    const storage = new SessionStorage(projectDir, 'test-model', 'session-2');
    await storage.initialize();

    await storage.append('user_message', {
      kind: 'message',
      message: { role: 'user', content: 'old request' },
    });
    await storage.append('continuity_checkpoint', {
      kind: 'continuity_checkpoint',
      checkpoint: {
        sessionId: 'session-2',
        timestamp: new Date().toISOString(),
        summary: 'checkpoint summary',
        currentGoal: 'finish the context system',
        recentMessages: ['user: old request'],
        pendingToolCalls: [],
        openQuestions: ['Should recovery resume here?'],
        nextAction: 'continue implementation',
        tokenEstimate: 500,
        contextPressure: 0.5,
        strategy: 'auto_compact',
      },
    });

    const result = await resumeSession(projectDir, 'session-2', 'test-model');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain('Goal: finish the context system');
    expect(result.messages[0].content).toContain('Next action: continue implementation');
  });
});
