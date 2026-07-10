import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maybeSpoolLargeResponse, DEFAULT_LARGE_RESPONSE_THRESHOLD } from './largeResponseHandler';

describe('maybeSpoolLargeResponse', () => {
  let spoolDir: string;

  beforeEach(() => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-spool-'));
  });

  afterEach(() => {
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  it('passes small responses through untouched', () => {
    const outcome = maybeSpoolLargeResponse(
      'file_read',
      { success: true, output: 'hi there' },
      { thresholdChars: 100, spoolDir },
    );
    expect(outcome.spooled).toBe(false);
    expect(outcome.result.output).toBe('hi there');
  });

  it('spools when output exceeds threshold', () => {
    const big = 'x'.repeat(500);
    const outcome = maybeSpoolLargeResponse(
      'grep',
      { success: true, output: big },
      { thresholdChars: 100, spoolDir },
    );
    expect(outcome.spooled).toBe(true);
    expect(outcome.spoolPath).toBeDefined();
    expect(outcome.result.output).toContain('large response');
    expect(outcome.result.output).toContain(outcome.spoolPath!);
    expect(fs.readFileSync(outcome.spoolPath!, 'utf-8')).toBe(big);
  });

  it('does not spool failed tool results', () => {
    const outcome = maybeSpoolLargeResponse(
      'bash',
      { success: false, output: 'x'.repeat(500), error: 'died' },
      { thresholdChars: 100, spoolDir },
    );
    expect(outcome.spooled).toBe(false);
    expect(outcome.result.output.length).toBe(500);
  });

  it('counts code points (grapheme-safe length)', () => {
    // 'a😀' has length 3 in code units but 2 in code points
    const s = 'a😀';
    const outcome = maybeSpoolLargeResponse(
      'x',
      { success: true, output: s },
      { thresholdChars: 1, spoolDir },
    );
    expect(outcome.spooled).toBe(true);
    expect(outcome.originalChars).toBe(2);
  });

  it('returns warning text when spool dir cannot be created', () => {
    // Use a path that cannot be created (file where dir is expected).
    const blocker = path.join(spoolDir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf-8');
    const outcome = maybeSpoolLargeResponse(
      'x',
      { success: true, output: 'y'.repeat(500) },
      { thresholdChars: 100, spoolDir: path.join(blocker, 'subdir') },
    );
    expect(outcome.spooled).toBe(false);
    expect(outcome.result.output).toContain('could not be spooled');
  });

  it('uses DEFAULT_LARGE_RESPONSE_THRESHOLD when not overridden', () => {
    const justUnder = 'x'.repeat(DEFAULT_LARGE_RESPONSE_THRESHOLD);
    const outcome = maybeSpoolLargeResponse(
      'x',
      { success: true, output: justUnder },
      { spoolDir },
    );
    expect(outcome.spooled).toBe(false);
  });
});
