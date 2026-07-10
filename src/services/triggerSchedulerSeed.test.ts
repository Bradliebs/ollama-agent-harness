import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  DEFAULT_TRIGGERS,
  ensureDefaultTriggers,
  loadTriggers,
  saveTriggers,
} from './triggerScheduler';

describe('ensureDefaultTriggers', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-triggers-seed-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  const triggersPath = (dir: string) => path.join(dir, '.harness', 'triggers', 'triggers.json');

  it('creates triggers.json with the morning-priority entry on first run', async () => {
    await ensureDefaultTriggers(projectDir);
    const triggers = await loadTriggers(projectDir);
    const morning = triggers.find((t) => t.id === 'morning-priority');
    expect(morning).toBeDefined();
    expect(morning).toMatchObject({
      id: 'morning-priority',
      command: 'node',
      args: ['scripts/morning-priority.js'],
      intervalSeconds: 900,
      enabled: true,
    });
  });

  it('is a no-op on the second run (file unchanged byte-for-byte)', async () => {
    await ensureDefaultTriggers(projectDir);
    const firstBytes = await fs.readFile(triggersPath(projectDir));
    await ensureDefaultTriggers(projectDir);
    const secondBytes = await fs.readFile(triggersPath(projectDir));
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  it('does not overwrite a user-defined trigger that shares the default id', async () => {
    const userVersion = {
      id: 'morning-priority',
      command: 'python',
      args: ['my-script.py'],
      intervalSeconds: 60,
      enabled: false,
    };
    await saveTriggers(projectDir, [userVersion]);
    await ensureDefaultTriggers(projectDir);
    const triggers = await loadTriggers(projectDir);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toEqual(userVersion);
  });

  it('preserves unrelated user triggers and appends missing defaults', async () => {
    const userTrigger = { id: 'my-custom', command: 'node', args: ['x.js'], intervalSeconds: 30, enabled: true };
    await saveTriggers(projectDir, [userTrigger]);
    await ensureDefaultTriggers(projectDir);
    const triggers = await loadTriggers(projectDir);
    expect(triggers.find((t) => t.id === 'my-custom')).toEqual(userTrigger);
    expect(triggers.find((t) => t.id === 'morning-priority')).toBeDefined();
    expect(triggers).toHaveLength(1 + DEFAULT_TRIGGERS.length);
  });
});
