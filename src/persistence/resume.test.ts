import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from './sessionStorage';
import { resumeSession } from './resume';

describe('resumeSession', () => {
  it('reports a truncated final event while recovering valid messages without rewriting the transcript', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-partial-resume-'));
    try {
      const storage = new SessionStorage(projectDir, 'fixture', 'partial');
      await storage.initialize();
      await storage.append('user_message', { kind: 'message', message: { role: 'user', content: 'Keep this request.' } });
      await fs.appendFile(storage.getTranscriptPath(), '{"id":"interrupted');
      const before = await fs.readFile(storage.getTranscriptPath(), 'utf8');
      const result = await resumeSession(projectDir, 'partial', 'fixture');
      expect(result.messages).toEqual([{ role: 'user', content: 'Keep this request.' }]);
      expect(result.diagnostics).toMatchObject({ validEvents: 1, corruptLines: 1, missing: false, unreadable: false });
      expect(await fs.readFile(storage.getTranscriptPath(), 'utf8')).toBe(before);
      expect((await resumeSession(projectDir, 'missing', 'fixture')).diagnostics.missing).toBe(true);
      const continued = new SessionStorage(projectDir, 'fixture', 'partial');
      await continued.append('assistant_message', { kind: 'message', message: { role: 'assistant', content: 'Recovered answer.' } });
      const recoveredAgain = await resumeSession(projectDir, 'partial', 'fixture');
      expect(recoveredAgain.messages).toEqual([
        { role: 'user', content: 'Keep this request.' },
        { role: 'assistant', content: 'Recovered answer.' },
      ]);
      expect(recoveredAgain.diagnostics).toMatchObject({ validEvents: 2, corruptLines: 1 });
      expect((await fs.readFile(storage.getTranscriptPath(), 'utf8')).startsWith(before)).toBe(true);
    } finally { await fs.rm(projectDir, { recursive: true, force: true }); }
  });

  it('preserves tool result IDs across resume without inventing IDs for legacy events', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-tool-resume-'));
    try {
      const storage = new SessionStorage(projectDir, 'test-model', 'tool-session');
      await storage.initialize();
      await storage.append('tool_result', {
        kind: 'tool_result',
        call: { id: 'write-1', name: 'file_write', input: { path: 'result.json' } },
        result: { success: true, output: 'Written' },
      });
      await storage.append('tool_result', {
        kind: 'tool_result',
        call: { name: 'file_read', input: { path: 'result.json' } },
        result: { success: true, output: 'Verified' },
      });

      const result = await resumeSession(projectDir, 'tool-session', 'test-model');

      expect(result.messages).toEqual([
        { role: 'tool', content: 'Written', tool_call_id: 'write-1' },
        { role: 'tool', content: 'Verified' },
      ]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

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
