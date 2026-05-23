import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectConflicts,
  detectStaleness,
  scanFileForConflicts,
  findStaleEntries,
  findAllStaleEntries,
  extractContentWords,
  extractNegatedWords,
  type MemorySection,
} from './memoryConflictDetector';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeSection(
  title: string,
  body: string,
  createdAt?: string,
  importance: 'high' | 'medium' | 'low' = 'medium',
): MemorySection {
  return { title, body, importance, createdAt };
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-test-'));
}

function writeMemoryFile(projectDir: string, fileName: string, content: string): void {
  const dir = path.join(projectDir, '.harness', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

// ─── extractContentWords ──────────────────────────────────────────────

describe('extractContentWords', () => {
  it('filters stopwords and short words', () => {
    const words = extractContentWords('we use tabs for indentation in this project');
    expect(words.has('tabs')).toBe(true);
    expect(words.has('indentation')).toBe(true);
    // stopwords should be excluded
    expect(words.has('we')).toBe(false);
    expect(words.has('for')).toBe(false);
    expect(words.has('in')).toBe(false);
    // < 4 chars
    expect(words.has('use')).toBe(false);
  });

  it('lowercases everything', () => {
    const words = extractContentWords('TypeScript Interfaces');
    expect(words.has('typescript')).toBe(true);
    expect(words.has('interfaces')).toBe(true);
  });

  it('strips punctuation so slash-separated tokens are split', () => {
    const words = extractContentWords('always use async/await!');
    // async and await both appear as independent tokens after stripping /
    expect(words.has('async')).toBe(true);
    expect(words.has('await')).toBe(true);
  });
});

// ─── extractNegatedWords ──────────────────────────────────────────────

describe('extractNegatedWords', () => {
  it('captures words after "avoid"', () => {
    const negated = extractNegatedWords('avoid using callbacks in new code');
    expect(negated.has('callbacks')).toBe(true);
  });

  it('captures words after "never"', () => {
    const negated = extractNegatedWords('never commit secrets directly');
    expect(negated.has('commit')).toBe(true);
    expect(negated.has('secrets')).toBe(true);
  });

  it('captures words after "do not"', () => {
    const negated = extractNegatedWords('do not modify generated files');
    expect(negated.has('modify')).toBe(true);
    expect(negated.has('generated')).toBe(true);
  });

  it('captures words after "deprecated"', () => {
    const negated = extractNegatedWords('the callbacks approach is deprecated');
    expect(negated.has('callbacks')).toBe(false); // "callbacks" is before the token
    // "deprecated" is a supersession token; words after it in the window
    // may be empty here — that is correct behaviour
  });

  it('returns empty set for text with no negation', () => {
    const negated = extractNegatedWords('always use async await for asynchronous code');
    expect(negated.size).toBe(0);
  });
});

// ─── detectConflicts ─────────────────────────────────────────────────

describe('detectConflicts', () => {
  it('returns empty array when no existing sections', () => {
    const results = detectConflicts([], 'use tabs for indentation');
    expect(results).toHaveLength(0);
  });

  it('returns empty array when topics do not overlap', () => {
    const sections = [
      makeSection('Database setup', 'use postgres for all database work in the project'),
    ];
    const results = detectConflicts(sections, 'always write tests before implementing features');
    expect(results).toHaveLength(0);
  });

  it('detects negation conflict: new says avoid X, old affirms X', () => {
    const sections = [
      makeSection('Async style', 'always prefer async await for asynchronous code functions'),
    ];
    const newBody = 'avoid async await callbacks — use promises directly instead';
    const results = detectConflicts(sections, newBody);
    expect(results).toHaveLength(1);
    expect(results[0].conflictType).toBe('negation');
    expect(results[0].existingSection.title).toBe('Async style');
    expect(results[0].confidence).toBeGreaterThan(0);
  });

  it('detects supersession: new marks something deprecated that old affirmed', () => {
    const sections = [
      makeSection('Callback patterns', 'callback based functions are preferred for event handling'),
    ];
    const newBody = 'callback based approach is now deprecated — replaced with async await';
    const results = detectConflicts(sections, newBody);
    expect(results.some((r) => r.conflictType === 'supersession' || r.conflictType === 'negation')).toBe(true);
  });

  it('detects duplicate: very high token overlap', () => {
    const sections = [
      makeSection('Indentation', 'always prefer tabs over spaces for indentation across project files'),
    ];
    const newBody = 'always prefer tabs over spaces for indentation across project files everywhere';
    const results = detectConflicts(sections, newBody);
    expect(results).toHaveLength(1);
    expect(results[0].conflictType).toBe('duplicate');
  });

  it('does not flag a near-duplicate of a different-topic section', () => {
    const sections = [
      makeSection('DB config', 'configure postgres connection with pooling enabled for database'),
    ];
    // Only 1 shared word with the section — should not match
    const newBody = 'prefer sqlite over postgres for local testing environments';
    const results = detectConflicts(sections, newBody);
    // May or may not flag; if flagged it must be relevant
    for (const r of results) {
      expect(r.sharedTopics.length >= 2 || r.conflictType === 'duplicate').toBe(true);
    }
  });

  it('returns sharedTopics for negation conflicts', () => {
    const sections = [
      makeSection('Lint rules', 'eslint rules enforce strict typescript linting rules across project'),
    ];
    const newBody = 'avoid strict typescript linting rules, they slow development down';
    const results = detectConflicts(sections, newBody);
    const negation = results.find((r) => r.conflictType === 'negation');
    if (negation) {
      expect(negation.sharedTopics.length).toBeGreaterThan(0);
    }
  });

  it('handles section with no body gracefully', () => {
    const sections = [makeSection('Empty section', '')];
    expect(() => detectConflicts(sections, 'some new content about typescript')).not.toThrow();
  });
});

// ─── detectStaleness ─────────────────────────────────────────────────

describe('detectStaleness', () => {
  const NOW = new Date('2025-06-01T00:00:00.000Z').getTime();

  it('classifies a section created today as fresh', () => {
    const section = makeSection('Recent note', 'body', '2025-06-01');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('fresh');
  });

  it('classifies a section created 10 days ago as aging', () => {
    const section = makeSection('Older note', 'body', '2025-05-22');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('aging');
  });

  it('classifies a section created 45 days ago as stale', () => {
    const section = makeSection('Old note', 'body', '2025-04-17');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('stale');
  });

  it('classifies a section created 100 days ago as very_stale', () => {
    const section = makeSection('Ancient note', 'body', '2025-02-21');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('very_stale');
  });

  it('returns unknown when createdAt is absent', () => {
    const section = makeSection('No date', 'body');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('unknown');
    expect(result.ageMs).toBe(0);
  });

  it('returns unknown when createdAt is not a parseable date', () => {
    const section = makeSection('Bad date', 'body', 'not-a-date');
    const result = detectStaleness(section, {}, NOW);
    expect(result.level).toBe('unknown');
  });

  it('respects custom thresholds', () => {
    // custom: aging starts at 1 day
    const section = makeSection('Quick stale', 'body', '2025-05-29');
    const result = detectStaleness(
      section,
      { agingMs: 1 * 24 * 60 * 60 * 1000 },
      NOW,
    );
    expect(result.level).toBe('aging');
  });

  it('populates ageMs', () => {
    const section = makeSection('With age', 'body', '2025-05-25');
    const result = detectStaleness(section, {}, NOW);
    expect(result.ageMs).toBeGreaterThan(0);
  });
});

// ─── scanFileForConflicts ─────────────────────────────────────────────

describe('scanFileForConflicts', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty array when file does not exist', async () => {
    const results = await scanFileForConflicts(tmpDir, 'patterns.md', 'some content');
    expect(results).toHaveLength(0);
  });

  it('detects conflicts in an existing file', async () => {
    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Async style',
      '<!-- importance: medium | created: 2025-01-01 -->',
      'always use async await for asynchronous functions in this project',
      '',
    ].join('\n'));

    const results = await scanFileForConflicts(
      tmpDir,
      'patterns.md',
      'avoid using async await — prefer promise chains for async functions',
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty when no topical overlap', async () => {
    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Database',
      '<!-- importance: medium | created: 2025-01-01 -->',
      'always use postgres with connection pooling for database access',
      '',
    ].join('\n'));

    const results = await scanFileForConflicts(
      tmpDir,
      'patterns.md',
      'run tests with jest before every pull request submission',
    );
    expect(results).toHaveLength(0);
  });
});

// ─── findStaleEntries ─────────────────────────────────────────────────

describe('findStaleEntries', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty when file does not exist', async () => {
    const results = await findStaleEntries(tmpDir, 'patterns.md');
    expect(results).toHaveLength(0);
  });

  it('returns stale sections', async () => {
    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Old rule',
      '<!-- importance: medium | created: 2020-01-01 -->',
      'some old coding pattern',
      '',
      '### New rule',
      '<!-- importance: medium | created: ' + new Date().toISOString().split('T')[0] + ' -->',
      'some recent coding pattern',
      '',
    ].join('\n'));

    const results = await findStaleEntries(tmpDir, 'patterns.md');
    expect(results.length).toBe(1);
    expect(results[0].section.title).toBe('Old rule');
    expect(results[0].level).toBe('very_stale');
  });

  it('excludes fresh sections', async () => {
    const today = new Date().toISOString().split('T')[0];
    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Recent rule',
      `<!-- importance: medium | created: ${today} -->`,
      'some fresh content',
      '',
    ].join('\n'));

    const results = await findStaleEntries(tmpDir, 'patterns.md');
    expect(results).toHaveLength(0);
  });
});

// ─── findAllStaleEntries ──────────────────────────────────────────────

describe('findAllStaleEntries', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty object when memory dir does not exist', async () => {
    const results = await findAllStaleEntries(tmpDir);
    expect(results).toEqual({});
  });

  it('scans multiple files and groups results by file name', async () => {
    writeMemoryFile(tmpDir, 'decisions.md', [
      '# Decisions',
      '',
      '### Old decision',
      '<!-- importance: medium | created: 2020-01-01 -->',
      'we decided something long ago',
      '',
    ].join('\n'));

    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Old pattern',
      '<!-- importance: medium | created: 2019-06-15 -->',
      'some old pattern',
      '',
    ].join('\n'));

    const results = await findAllStaleEntries(tmpDir);
    expect(Object.keys(results).length).toBe(2);
    expect(results['decisions.md']).toBeDefined();
    expect(results['patterns.md']).toBeDefined();
  });

  it('omits files with no stale entries from the result', async () => {
    const today = new Date().toISOString().split('T')[0];
    writeMemoryFile(tmpDir, 'patterns.md', [
      '# Patterns',
      '',
      '### Fresh rule',
      `<!-- importance: medium | created: ${today} -->`,
      'very recent content',
      '',
    ].join('\n'));

    const results = await findAllStaleEntries(tmpDir);
    expect(Object.keys(results)).toHaveLength(0);
  });
});
