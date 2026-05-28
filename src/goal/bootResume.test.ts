import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { surfaceResumableGoalOnBoot } from './bootResume';
import { createGoal, setActiveGoal, transitionGoal } from './store';
import { _resetFileLocksForTest } from '../persistence/atomicFile';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-boot-resume-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

interface CapturedLog { level: 'info' | 'warn'; msg: string; meta?: Record<string, unknown> }

function makeRecorder(): { logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void }; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  return {
    entries,
    logger: {
      info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    },
  };
}

describe('goal/bootResume', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); _resetFileLocksForTest(); });
  afterEach(async () => { await cleanup(dir); });

  it('returns {kind:none} when no goals exist', async () => {
    const { logger, entries } = makeRecorder();
    const res = await surfaceResumableGoalOnBoot(dir, { logger });
    expect(res.kind).toBe('none');
    expect(entries).toEqual([]);
  });

  it('logs at info level for auto-resume (active goal survived restart)', async () => {
    const g = await createGoal(dir, { target: 'do thing' });
    await transitionGoal(dir, g.id, 'active');
    await setActiveGoal(dir, g.id);
    const { logger, entries } = makeRecorder();
    const res = await surfaceResumableGoalOnBoot(dir, { logger });
    expect(res.kind).toBe('auto');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].meta?.goalId).toBe(g.id);
  });

  it('logs at warn level for needs_ack (paused goal)', async () => {
    const g = await createGoal(dir, { target: 'do thing' });
    await transitionGoal(dir, g.id, 'active');
    await transitionGoal(dir, g.id, 'paused', { pause: { reason: 'r', pausedAt: new Date().toISOString(), pausedBy: 'human' } });
    await setActiveGoal(dir, g.id);
    const { logger, entries } = makeRecorder();
    const res = await surfaceResumableGoalOnBoot(dir, { logger });
    expect(res.kind).toBe('needs_ack');
    expect(entries[0].level).toBe('warn');
  });
});
