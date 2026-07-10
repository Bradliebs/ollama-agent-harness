import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initReplayConsumer, readReplayCandidates, consumeReplayCandidates } from './replayConsumer';

describe('replayConsumer', () => {
  let projectDir: string;
  let seamPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-consumer-'));
    seamPath = path.join(projectDir, '.harness', 'needs-review-replay.jsonl');
    fs.mkdirSync(path.dirname(seamPath), { recursive: true });
    initReplayConsumer(projectDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns an empty list when the seam does not exist', async () => {
    fs.rmSync(seamPath, { force: true });
    expect(await readReplayCandidates()).toEqual([]);
    expect(await consumeReplayCandidates()).toEqual([]);
  });

  it('parses staged candidates and skips malformed lines without consuming', async () => {
    fs.writeFileSync(
      seamPath,
      [
        JSON.stringify({ id: 'a', content: 'first', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }),
        'not-json',
        '',
        JSON.stringify({ id: 'b', content: 'second', reason: 'flagged', drainedAt: '2026-01-02T00:00:00.000Z' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const candidates = await readReplayCandidates();
    expect(candidates.map((c) => c.id)).toEqual(['a', 'b']);
    expect(candidates[0].content).toBe('first');
    // read is non-destructive: the seam is unchanged.
    expect(fs.existsSync(seamPath)).toBe(true);
    expect(await readReplayCandidates()).toHaveLength(2);
  });

  it('consumes each candidate exactly once by clearing the seam', async () => {
    fs.writeFileSync(
      seamPath,
      JSON.stringify({ id: 'a', content: 'only', reason: 'flagged', drainedAt: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    );

    const first = await consumeReplayCandidates();
    expect(first.map((c) => c.id)).toEqual(['a']);
    // A second consume sees nothing — the seam was drained.
    expect(await consumeReplayCandidates()).toEqual([]);
    expect(fs.readFileSync(seamPath, 'utf-8')).toBe('');
  });
});
