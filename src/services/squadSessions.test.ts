import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  clearSquadForSession,
  getSquadForSession,
  resolveSessionSquad,
  setSquadForSession,
} from './squadSessions';

describe('squadSessions', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-squad-sessions-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns undefined when no association exists', async () => {
    expect(await getSquadForSession(projectDir, 'sess-1')).toBeUndefined();
  });

  it('persists and reads back an association', async () => {
    await setSquadForSession(projectDir, 'sess-1', 'eng');
    expect(await getSquadForSession(projectDir, 'sess-1')).toBe('eng');
  });

  it('clear removes the association', async () => {
    await setSquadForSession(projectDir, 'sess-1', 'eng');
    expect(await clearSquadForSession(projectDir, 'sess-1')).toBe(true);
    expect(await getSquadForSession(projectDir, 'sess-1')).toBeUndefined();
    expect(await clearSquadForSession(projectDir, 'sess-1')).toBe(false);
  });

  it('resolveSessionSquad falls back to stored association', async () => {
    await setSquadForSession(projectDir, 'sess-1', 'eng');
    expect(await resolveSessionSquad(projectDir, 'sess-1')).toBe('eng');
  });

  it('resolveSessionSquad with explicit id overrides and persists', async () => {
    await setSquadForSession(projectDir, 'sess-1', 'eng');
    expect(await resolveSessionSquad(projectDir, 'sess-1', 'support')).toBe('support');
    expect(await getSquadForSession(projectDir, 'sess-1')).toBe('support');
  });

  it('ignores empty session id or squad id', async () => {
    await setSquadForSession(projectDir, '', 'eng');
    await setSquadForSession(projectDir, 'sess-1', '');
    expect(await getSquadForSession(projectDir, '')).toBeUndefined();
    expect(await getSquadForSession(projectDir, 'sess-1')).toBeUndefined();
  });
});
