import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatUnverifiedFooter, verifyPathClaims } from './pathClaims';

describe('verifyPathClaims', () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-claims-'));
    // Lay down a small fixture tree so we have real paths to detect.
    fs.mkdirSync(path.join(scratchRoot, 'src', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, 'src', 'agents', 'health-agent.js'), '// real');
    fs.writeFileSync(path.join(scratchRoot, 'src', 'orchestrator.js'), '// real');
    fs.writeFileSync(path.join(scratchRoot, 'README.md'), '# real');
  });

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('classifies real and made-up paths in mixed prose', () => {
    const text = [
      'Status:',
      '- src/orchestrator.js — implemented',
      '- src/orchestration/heartbeat.ts — implemented (this one is fabricated)',
      '- src/agents/health-agent.js works',
      '- src/integrations/telegram.ts is on the roadmap',
    ].join('\n');

    const report = verifyPathClaims(text, scratchRoot);

    expect(report.verified).toEqual(expect.arrayContaining(['src/orchestrator.js', 'src/agents/health-agent.js']));
    expect(report.unverified).toEqual(expect.arrayContaining(['src/orchestration/heartbeat.ts', 'src/integrations/telegram.ts']));
  });

  it('handles backslash-separated paths from Windows-style claims', () => {
    const text = 'Touched src\\agents\\health-agent.js and missing src\\agents\\fitness-agent.js.';

    const report = verifyPathClaims(text, scratchRoot);

    expect(report.verified).toContain('src\\agents\\health-agent.js');
    expect(report.unverified).toContain('src\\agents\\fitness-agent.js');
  });

  it('ignores URLs and bare filenames without separators', () => {
    const text = 'See https://example.com/foo.ts and the file foo.ts (no path) and ./README.md.';

    const report = verifyPathClaims(text, scratchRoot);

    // URL host and bare "foo.ts" should not appear as candidates.
    expect(report.candidates).not.toContain('foo.ts');
    expect(report.candidates.find((c) => c.includes('example.com'))).toBeUndefined();
    expect(report.verified).toContain('./README.md');
  });

  it('returns null footer when nothing is unverified', () => {
    const report = verifyPathClaims('All good — see src/orchestrator.js.', scratchRoot);

    expect(report.unverified).toEqual([]);
    expect(formatUnverifiedFooter(report)).toBeNull();
  });

  it('renders a footer listing unverified paths when present', () => {
    const text = 'See src/orchestration/heartbeat.ts and src/integrations/telegram.ts.';

    const report = verifyPathClaims(text, scratchRoot);
    const footer = formatUnverifiedFooter(report);

    expect(footer).not.toBeNull();
    expect(footer).toContain('Unverified file references');
    expect(footer).toContain('src/orchestration/heartbeat.ts');
    expect(footer).toContain('src/integrations/telegram.ts');
  });

  it('returns an empty report for empty input', () => {
    const report = verifyPathClaims('', scratchRoot);

    expect(report).toEqual({ candidates: [], verified: [], unverified: [] });
  });
});
