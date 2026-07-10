import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initReplayLedger, appendReplayLedgerEntry, readReplayLedger } from './replayLedger';

describe('replayLedger', () => {
  let projectDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-ledger-'));
    ledgerPath = path.join(projectDir, '.harness', 'idle-replay-log.jsonl');
    initReplayLedger(projectDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns an empty list when nothing has been recorded', async () => {
    expect(await readReplayLedger()).toEqual([]);
  });

  it('appends entries and reads them back in order', async () => {
    await appendReplayLedgerEntry({ at: '2026-01-01T00:00:00.000Z', consumed: 2, replayed: 2, reQueued: 1 });
    await appendReplayLedgerEntry({ at: '2026-01-02T00:00:00.000Z', consumed: 1, replayed: 0, reQueued: 0 });

    const entries = await readReplayLedger();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ at: '2026-01-01T00:00:00.000Z', consumed: 2, replayed: 2, reQueued: 1 });
    expect(entries[1].consumed).toBe(1);

    const raw = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(2);
  });

  it('skips malformed ledger lines', async () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(
      ledgerPath,
      'not json\n' + JSON.stringify({ at: '2026-01-03T00:00:00.000Z', consumed: 3, replayed: 3, reQueued: 2 }) + '\n',
      'utf-8',
    );
    const entries = await readReplayLedger();
    expect(entries).toHaveLength(1);
    expect(entries[0].reQueued).toBe(2);
  });
});
