/**
 * Tests for scripts/research-report.js.
 *
 * Hermetic: runs the CLI as a child process in --offline mode against a JSON
 * fixture so it never hits the network or Ollama.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('scripts/research-report.js (offline + fixture)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'research-runner-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('renders an HTML report from a fixture without network or model calls', () => {
    const fixture = {
      subject: 'Hermetic Subject',
      summary: 'A short summary used only by the test fixture.',
      oneLineAnswer: 'Fixture answer.',
      findings: [
        { label: 'Hermetic Finding', body: 'This finding came from the fixture.', confidence: 0.9, sourceIds: [0] },
      ],
      sources: [{ title: 'Fixture source', url: 'https://example.com/fixture' }],
      generatedAt: '2026-05-23T12:00:00.000Z',
    };
    const fixturePath = join(workDir, 'fixture.json');
    const outPath = join(workDir, 'report.html');
    writeFileSync(fixturePath, JSON.stringify(fixture), 'utf-8');

    const script = resolve(__dirname, '..', '..', 'scripts', 'research-report.js');
    execFileSync(
      process.execPath,
      [script, '--subject', 'Hermetic Subject', '--offline', '--fixture', fixturePath, '--out', outPath],
      { stdio: 'pipe', encoding: 'utf-8' },
    );

    expect(existsSync(outPath)).toBe(true);
    const html = readFileSync(outPath, 'utf-8');
    expect(html).toContain('<h1>Hermetic Subject</h1>');
    expect(html).toMatch(/<h3>Hermetic Finding/);
  }, 60_000);
});
