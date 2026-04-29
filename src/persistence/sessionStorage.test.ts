import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionStorage } from './sessionStorage';

describe('SessionStorage metadata', () => {
  it('tracks recoverable running sessions and clears completed ones', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-session-meta-'));
    const running = new SessionStorage(projectDir, 'test-model', 'running');
    await running.initialize();
    const completed = new SessionStorage(projectDir, 'test-model', 'completed');
    await completed.initialize();
    await completed.markStatus('completed');

    const recoverable = await SessionStorage.listRecoverableSessions(projectDir);

    expect(recoverable.map((session) => session.sessionId)).toEqual(['running']);
  });
});
