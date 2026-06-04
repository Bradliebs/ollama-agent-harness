import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCheck, runAllChecks, RunCheckContext, ModelJudgeFn, parseJestSummary } from './verification';
import { GoalCheck } from './types';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goal-verify-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const baseCtx: RunCheckContext = { goalTarget: 'test target' };

function check(spec: GoalCheck['spec'], required = true, id = 'c1'): GoalCheck {
  return { id, description: 'test', required, spec };
}

describe('verification: command', () => {
  it('passes when exit code matches expectExitCode (default 0)', async () => {
    const r = await runCheck(check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(0)'] }), baseCtx);
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('exit=0');
  });

  it('fails when exit code does not match', async () => {
    const r = await runCheck(check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(7)'] }), baseCtx);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('exit=7');
  });

  it('matches stdout against expectStdoutMatches', async () => {
    const pass = await runCheck(check({ kind: 'command', command: 'node', args: ['-e', 'process.stdout.write("hello world")'], expectStdoutMatches: 'hello' }), baseCtx);
    expect(pass.passed).toBe(true);
    const fail = await runCheck(check({ kind: 'command', command: 'node', args: ['-e', 'process.stdout.write("hello world")'], expectStdoutMatches: 'goodbye' }), baseCtx);
    expect(fail.passed).toBe(false);
  });

  it('honours expectExitCode when set explicitly', async () => {
    const r = await runCheck(check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(3)'], expectExitCode: 3 }), baseCtx);
    expect(r.passed).toBe(true);
  });
});

describe('verification: file_exists', () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await cleanup(dir); });

  it('passes when the file exists', async () => {
    const fp = path.join(dir, 'present.txt');
    await fs.writeFile(fp, 'hi');
    const r = await runCheck(check({ kind: 'file_exists', path: fp }), baseCtx);
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('file present');
  });

  it('fails when the file is missing', async () => {
    const r = await runCheck(check({ kind: 'file_exists', path: path.join(dir, 'nope.txt') }), baseCtx);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('stat failed');
  });

  it('fails when path is a directory, not a file', async () => {
    const r = await runCheck(check({ kind: 'file_exists', path: dir }), baseCtx);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('not a regular file');
  });

  it('matches mustContain against file body', async () => {
    const fp = path.join(dir, 'with-body.txt');
    await fs.writeFile(fp, 'version: 0.6.5');
    const pass = await runCheck(check({ kind: 'file_exists', path: fp, mustContain: '0\\.6\\.5' }), baseCtx);
    expect(pass.passed).toBe(true);
    const fail = await runCheck(check({ kind: 'file_exists', path: fp, mustContain: '0\\.7\\.0' }), baseCtx);
    expect(fail.passed).toBe(false);
    expect(fail.evidence).toContain('NOT matched');
  });
});

describe('verification: http', () => {
  function mockFetch(impl: (url: string) => { status: number; body: string }): typeof fetch {
    return (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const { status, body } = impl(url);
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }

  it('passes when status matches and body regex matches', async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: '{"status":"ok","cells":0}' }));
    const r = await runCheck(
      check({ kind: 'http', url: 'http://localhost/health', expectStatus: 200, expectBodyMatches: '"status":"ok"' }),
      { ...baseCtx, fetchImpl },
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('status=200');
  });

  it('fails on status mismatch', async () => {
    const fetchImpl = mockFetch(() => ({ status: 500, body: 'oops' }));
    const r = await runCheck(check({ kind: 'http', url: 'http://x/y' }), { ...baseCtx, fetchImpl });
    expect(r.passed).toBe(false);
  });

  it('fails when fetch throws', async () => {
    const fetchImpl = (async () => { throw new Error('refused'); }) as typeof fetch;
    const r = await runCheck(check({ kind: 'http', url: 'http://nowhere/' }), { ...baseCtx, fetchImpl });
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('fetch failed');
  });
});

describe('verification: model_judge', () => {
  it('passes when judge score >= minScore', async () => {
    const judge: ModelJudgeFn = async () => ({ score: 0.85, rationale: 'looks good' });
    const r = await runCheck(check({ kind: 'model_judge', rubric: 'is it good?', minScore: 0.7 }), { ...baseCtx, judge });
    expect(r.passed).toBe(true);
    expect(r.judgeScore).toBe(0.85);
    expect(r.evidence).toContain('looks good');
  });

  it('fails when judge score below minScore', async () => {
    const judge: ModelJudgeFn = async () => ({ score: 0.4, rationale: 'thin' });
    const r = await runCheck(check({ kind: 'model_judge', rubric: 'r', minScore: 0.8 }), { ...baseCtx, judge });
    expect(r.passed).toBe(false);
    expect(r.judgeScore).toBe(0.4);
  });

  it('fails gracefully when no judge is provided', async () => {
    const r = await runCheck(check({ kind: 'model_judge', rubric: 'r' }), baseCtx);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('no model judge provided');
  });

  it('falls back to minScore 0.7 when none specified', async () => {
    const judge: ModelJudgeFn = async () => ({ score: 0.69, rationale: '' });
    const r = await runCheck(check({ kind: 'model_judge', rubric: 'r' }), { ...baseCtx, judge });
    expect(r.passed).toBe(false);
  });
});

describe('verification: test_suite', () => {
  const jestOutput = `
PASS  src/sample.test.ts
Tests:       1 failed, 11 passed, 12 total
Snapshots:   0 total
Time:        2.345 s
`;

  it('falls back to exit code when no minPassRate is set', async () => {
    const r = await runCheck(check({ kind: 'test_suite', command: 'node', args: ['-e', 'process.exit(0)'] }), baseCtx);
    expect(r.passed).toBe(true);
  });

  it('fails on non-zero exit when no minPassRate', async () => {
    const r = await runCheck(check({ kind: 'test_suite', command: 'node', args: ['-e', 'process.exit(1)'] }), baseCtx);
    expect(r.passed).toBe(false);
  });

  it('parses Jest output and respects minPassRate', async () => {
    // Use a script that emits Jest-style summary and exits non-zero (a failing suite).
    const args = ['-e', `process.stdout.write(${JSON.stringify(jestOutput)}); process.exit(1)`];
    const r = await runCheck(check({ kind: 'test_suite', command: 'node', args, minPassRate: 0.9 }), baseCtx);
    expect(r.testCounts).toEqual({ passed: 11, failed: 1, total: 12 });
    // 11/12 ≈ 0.917 >= 0.9 → passes
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('passRate=0.917');
  });

  it('fails minPassRate gate when below threshold', async () => {
    const args = ['-e', `process.stdout.write(${JSON.stringify(jestOutput)}); process.exit(1)`];
    const r = await runCheck(check({ kind: 'test_suite', command: 'node', args, minPassRate: 0.95 }), baseCtx);
    expect(r.passed).toBe(false);
  });
});

describe('verification: parseJestSummary', () => {
  it('parses a passed/failed/total summary line', () => {
    expect(parseJestSummary('Tests:       11 passed, 1 failed, 12 total')).toEqual({ passed: 11, failed: 1, total: 12 });
  });

  it('parses failed-first ordering and embedded preamble', () => {
    const output = `Command 'npx' failed with exit code 1\nPASS src/a.test.ts\nTests:       1 failed, 11 passed, 12 total\n`;
    expect(parseJestSummary(output)).toEqual({ passed: 11, failed: 1, total: 12 });
  });

  it('returns null when no recognisable summary is present', () => {
    expect(parseJestSummary('build succeeded\nno tests here')).toBeNull();
  });
});

describe('verification: runAllChecks', () => {
  it('aggregates required-only and reports passed count', async () => {
    const required = check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(0)'] }, true, 'req-1');
    const optionalFail = check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(1)'] }, false, 'opt-1');
    const requiredFail = check({ kind: 'command', command: 'node', args: ['-e', 'process.exit(1)'] }, true, 'req-2');

    const allPass = await runAllChecks([required], baseCtx);
    expect(allPass.allRequiredPassed).toBe(true);
    expect(allPass.requiredCount).toBe(1);
    expect(allPass.requiredPassed).toBe(1);

    const oneFails = await runAllChecks([required, requiredFail, optionalFail], baseCtx);
    expect(oneFails.allRequiredPassed).toBe(false);
    expect(oneFails.requiredCount).toBe(2);
    expect(oneFails.requiredPassed).toBe(1);
  });

  it('reports allRequiredPassed=true when there are no required checks', async () => {
    const r = await runAllChecks([], baseCtx);
    expect(r.allRequiredPassed).toBe(true);
    expect(r.requiredCount).toBe(0);
  });
});
