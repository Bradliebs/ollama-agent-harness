import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from '../persistence/sessionStorage';
import { writeIdentityAutoUpdateConfig } from './identityAutoUpdate';
import { writeIdentityFile } from './identity';
import { IdentityAutoUpdateScheduler } from './identityAutoUpdateScheduler';

const MAINTENANCE_WINDOW_MS = 60 * 60 * 1000;

async function seedSession(projectDir: string, sessionId: string, updatedAt: string): Promise<void> {
  const storage = new SessionStorage(projectDir, 'test-model', sessionId);
  await storage.initialize();
  await storage.append('user_message', {
    kind: 'message',
    message: { role: 'user', content: 'tell me what you learned' },
  });
  await storage.updateMeta({ updatedAt });
}

describe('IdentityAutoUpdateScheduler.tick', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-sched-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  function makeScheduler(overrides: Partial<ConstructorParameters<typeof IdentityAutoUpdateScheduler>[0]> = {}) {
    return new IdentityAutoUpdateScheduler({
      projectDir,
      callModel: async () => 'NO_CHANGE',
      intervalHours: 1,
      idleThresholdMinutes: 1,
      getLastUserActivityMs: () => Date.now() - 10 * 60 * 1000,
      isEnabled: () => true,
      ...overrides,
    });
  }

  it('skips when disabled', async () => {
    const scheduler = makeScheduler({ isEnabled: () => false });
    const result = await scheduler.tick(new Date(Date.now() + MAINTENANCE_WINDOW_MS + 1));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('skips a second tick inside the maintenance check window', async () => {
    const scheduler = makeScheduler({ intervalHours: 24 });
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const first = await scheduler.tick(new Date(fakeNow));
    expect(first.ran).toBe(true);
    const second = await scheduler.tick(new Date(fakeNow + 60_000));
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('within maintenance check window');
  });

  it('skips when system is not idle', async () => {
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const scheduler = makeScheduler({
      getLastUserActivityMs: () => fakeNow,
      idleThresholdMinutes: 10,
    });
    const result = await scheduler.tick(new Date(fakeNow));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('system not idle');
  });

  it('runs the tick when due and idle, with both targets off (no model call)', async () => {
    const callModel = jest.fn(async (_prompt: string) => 'NO_CHANGE');
    const scheduler = makeScheduler({ callModel });
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const result = await scheduler.tick(new Date(fakeNow));
    expect(result.ran).toBe(true);
    expect(result.result?.user.status).toBe('disabled');
    expect(result.result?.soul.status).toBe('disabled');
    expect(callModel).not.toHaveBeenCalled();
  });

  it('feeds gathered observations into the proposal layer when USER is enabled', async () => {
    await writeIdentityAutoUpdateConfig(projectDir, { version: 1, user: true, soul: false });
    await writeIdentityFile(projectDir, 'USER.md', '# Old');
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const observationStamp = new Date(fakeNow - 60 * 60 * 1000).toISOString();
    await seedSession(projectDir, 'recent-session', observationStamp);
    const promptsSeen: string[] = [];
    const callModel = jest.fn(async (prompt: string) => {
      promptsSeen.push(prompt);
      return '```identity\n# New\n```';
    });
    const scheduler = makeScheduler({ callModel });
    const result = await scheduler.tick(new Date(fakeNow));
    expect(result.ran).toBe(true);
    expect(result.result?.user.status).toBe('applied');
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(promptsSeen[0]).toContain('tell me what you learned');
  });

  it('enforces the interval gate after a successful run', async () => {
    const callModel = jest.fn(async () => 'NO_CHANGE');
    const scheduler = makeScheduler({ callModel, intervalHours: 24 });
    const fakeNow = Date.now() + MAINTENANCE_WINDOW_MS + 1;
    const first = await scheduler.tick(new Date(fakeNow));
    expect(first.ran).toBe(true);
    const second = await scheduler.tick(new Date(fakeNow + MAINTENANCE_WINDOW_MS + 1));
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('interval not elapsed');
  });

  it('start() registers a heartbeat and stop() clears it', async () => {
    const scheduler = makeScheduler();
    scheduler.start();
    // No way to peek at private state; just confirm stop() is safe to call.
    scheduler.stop();
    scheduler.stop();
  });
});
