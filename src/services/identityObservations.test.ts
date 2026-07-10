import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from '../persistence/sessionStorage';
import { gatherIdentityObservations } from './identityObservations';

async function seedSession(
  projectDir: string,
  sessionId: string,
  updatedAt: string,
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>,
): Promise<void> {
  const storage = new SessionStorage(projectDir, 'test-model', sessionId);
  await storage.initialize();
  for (const m of messages) {
    if (m.role === 'user') {
      await storage.append('user_message', { kind: 'message', message: { role: 'user', content: m.content } });
    } else if (m.role === 'assistant') {
      await storage.append('assistant_message', { kind: 'message', message: { role: 'assistant', content: m.content } });
    } else {
      await storage.append('system', { kind: 'system', content: m.content });
    }
  }
  await storage.updateMeta({ updatedAt });
}

describe('gatherIdentityObservations', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-obs-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty result when no sessions exist', async () => {
    const result = await gatherIdentityObservations(projectDir);
    expect(result.text).toBe('');
    expect(result.sessionsRead).toBe(0);
    expect(result.messagesIncluded).toBe(0);
  });

  it('filters out sessions older than sinceMs', async () => {
    await seedSession(projectDir, 'old-session', '2026-06-01T12:00:00Z', [
      { role: 'user', content: 'ancient ask' },
      { role: 'assistant', content: 'ancient reply' },
    ]);
    await seedSession(projectDir, 'new-session', '2026-06-07T12:00:00Z', [
      { role: 'user', content: 'recent ask' },
      { role: 'assistant', content: 'recent reply' },
    ]);
    const sinceMs = Date.parse('2026-06-05T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs });
    expect(result.sessionsRead).toBe(1);
    expect(result.text).toContain('recent ask');
    expect(result.text).toContain('recent reply');
    expect(result.text).not.toContain('ancient');
  });

  it('extracts user + assistant messages and skips other event kinds', async () => {
    await seedSession(projectDir, 'mixed', '2026-06-07T12:00:00Z', [
      { role: 'system', content: 'this is a system event' },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi back' },
    ]);
    const sinceMs = Date.parse('2026-06-01T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs });
    expect(result.messagesIncluded).toBe(2);
    expect(result.text).toContain('[user] hello there');
    expect(result.text).toContain('[assistant] hi back');
    expect(result.text).not.toContain('system event');
  });

  it('orders sessions most-recent first', async () => {
    await seedSession(projectDir, 'session-a', '2026-06-07T08:00:00Z', [
      { role: 'user', content: 'earlier today' },
    ]);
    await seedSession(projectDir, 'session-b', '2026-06-07T14:00:00Z', [
      { role: 'user', content: 'this afternoon' },
    ]);
    const sinceMs = Date.parse('2026-06-01T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs });
    const aIdx = result.text.indexOf('earlier today');
    const bIdx = result.text.indexOf('this afternoon');
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(bIdx);
  });

  it('truncates individual messages over maxCharsPerMessage', async () => {
    const long = 'x'.repeat(2000);
    await seedSession(projectDir, 'long', '2026-06-07T12:00:00Z', [
      { role: 'user', content: long },
    ]);
    const sinceMs = Date.parse('2026-06-01T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs, maxCharsPerMessage: 50 });
    expect(result.text).toContain('…');
    expect(result.text.length).toBeLessThan(300);
  });

  it('respects the overall maxChars cap', async () => {
    await seedSession(projectDir, 's1', '2026-06-07T10:00:00Z', [
      { role: 'user', content: 'a'.repeat(500) },
    ]);
    await seedSession(projectDir, 's2', '2026-06-07T11:00:00Z', [
      { role: 'user', content: 'b'.repeat(500) },
    ]);
    const sinceMs = Date.parse('2026-06-01T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs, maxChars: 200 });
    expect(result.text.length).toBeLessThanOrEqual(200);
  });

  it('defaults sinceMs to ~24h before now', async () => {
    const now = new Date('2026-06-07T12:00:00Z');
    await seedSession(projectDir, 'within', '2026-06-06T18:00:00Z', [
      { role: 'user', content: 'within window' },
    ]);
    await seedSession(projectDir, 'outside', '2026-06-05T18:00:00Z', [
      { role: 'user', content: 'outside window' },
    ]);
    const result = await gatherIdentityObservations(projectDir, { now });
    expect(result.text).toContain('within window');
    expect(result.text).not.toContain('outside window');
  });

  it('skips sessions whose only events are non-message kinds', async () => {
    await seedSession(projectDir, 'noisy', '2026-06-07T12:00:00Z', [
      { role: 'system', content: 'noise' },
    ]);
    await seedSession(projectDir, 'real', '2026-06-07T13:00:00Z', [
      { role: 'user', content: 'signal' },
    ]);
    const sinceMs = Date.parse('2026-06-01T00:00:00Z');
    const result = await gatherIdentityObservations(projectDir, { sinceMs });
    expect(result.messagesIncluded).toBe(1);
    expect(result.text).toContain('signal');
    expect(result.text).not.toContain('noise');
  });
});
