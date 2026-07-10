/**
 * Tests for goalExpander — meta-prompting for autonomous task decomposition.
 */
import { detectIntent, expandGoal, renderTasksAsPlanMarkdown, slugify } from './goalExpander';

describe('goalExpander.detectIntent', () => {
  it.each([
    ['Build a wiki from D:\\big.pdf', 'ingest'],
    ['Split this PDF into chapters', 'ingest'],
    ['Research Acme\'s tech stack', 'research'],
    ['Investigate the slow startup time', 'research'],
    ['Build me a todo app', 'build'],
    ['Add OAuth login to the API', 'build'],
    ['Schedule a 9am check-in', 'schedule'],
    ['Every morning ask my top priority', 'schedule'],
    ['Daily backup of the database', 'schedule'],
    ['xyzzy', 'generic'],
  ] as const)('classifies %p as %p', (intent, expected) => {
    expect(detectIntent(intent)).toBe(expected);
  });
});

describe('goalExpander.slugify', () => {
  it('produces kebab-case ascii slugs', () => {
    expect(slugify('Build a Wiki!')).toBe('build-a-wiki');
    expect(slugify('   trim   me   ')).toBe('trim-me');
    expect(slugify('Über-Räsearch 2026')).toBe('ber-r-search-2026');
  });

  it('appends -2, -3 on collision', () => {
    const taken = new Set<string>();
    expect(slugify('task', taken)).toBe('task');
    expect(slugify('task', taken)).toBe('task-2');
    expect(slugify('task', taken)).toBe('task-3');
  });

  it('falls back to "task" when input has no usable characters', () => {
    expect(slugify('!!!')).toBe('task');
    expect(slugify('')).toBe('task');
  });

  it('caps slug length at 60 characters', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe('goalExpander.expandGoal — ingest', () => {
  it('emits a 6-step pipeline for a Windows path PDF ingest', () => {
    const result = expandGoal('Build a wiki from D:\\big.pdf');
    expect(result.shape).toBe('ingest');
    expect(result.tasks).toHaveLength(6);
    // First task is external because path is outside the repo
    expect(result.tasks[0].kind).toBe('external');
    // Anchors carry the source path
    expect(result.tasks[0].anchors).toContain('D:\\big.pdf');
    // Pipeline shape: survey → outline → chunk → rag → wiki → smoke
    const ids = result.tasks.map((t) => t.id);
    expect(ids[0]).toMatch(/^survey-/);
    expect(ids[ids.length - 1]).toMatch(/^smoke-/);
    // Chunk/rag/wiki/smoke are code tasks
    expect(result.tasks.slice(2).every((t) => t.kind === 'code')).toBe(true);
  });

  it('uses research kind when the source is inside the repo', () => {
    const result = expandGoal('Split docs/specs.md into chapters');
    // No drive letter / leading slash means relative path → research, not external
    expect(result.tasks[0].kind).toBe('research');
  });
});

describe('goalExpander.expandGoal — research', () => {
  it('emits scope → gather → analyse → report with mostly research kinds', () => {
    const result = expandGoal('Research https://acme.example.com tech stack');
    expect(result.shape).toBe('research');
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.slice(0, 3).every((t) => t.kind === 'research')).toBe(true);
    // Final report is a code task that renders an artifact
    expect(result.tasks[3].kind).toBe('code');
    expect(result.tasks[3].title).toMatch(/\.html/);
  });
});

describe('goalExpander.expandGoal — build', () => {
  it('emits design → scaffold → implement → test → document', () => {
    const result = expandGoal('Build a todo app');
    expect(result.shape).toBe('build');
    expect(result.tasks).toHaveLength(5);
    expect(result.tasks.every((t) => t.kind === 'code')).toBe(true);
    const ids = result.tasks.map((t) => t.id);
    expect(ids[0]).toMatch(/^design-/);
    expect(ids[1]).toMatch(/^scaffold-/);
    expect(ids[2]).toMatch(/^implement-/);
    expect(ids[3]).toMatch(/^test-/);
    expect(ids[4]).toMatch(/^document-/);
  });
});

describe('goalExpander.expandGoal — schedule', () => {
  it('emits design → add → test for recurring triggers', () => {
    const result = expandGoal('Schedule a 9am morning priority prompt');
    expect(result.shape).toBe('schedule');
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.every((t) => t.kind === 'code')).toBe(true);
  });
});

describe('goalExpander.expandGoal — generic fallback', () => {
  it('wraps unparsed intent in a single external task', () => {
    const result = expandGoal('xyzzy frobnicate the bazinga');
    expect(result.shape).toBe('generic');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].kind).toBe('external');
    expect(result.tasks[0].title).toBe('xyzzy frobnicate the bazinga');
  });

  it('returns an empty task list for empty input', () => {
    const result = expandGoal('   ');
    expect(result.tasks).toHaveLength(0);
  });
});

describe('goalExpander.expandGoal — collision avoidance', () => {
  it('does not collide with pre-existing task IDs', () => {
    const result = expandGoal('Build a todo app', { existingIds: ['design-a-todo-app', 'scaffold-a-todo-app'] });
    const ids = result.tasks.map((t) => t.id);
    expect(ids).toContain('design-a-todo-app-2');
    expect(ids).toContain('scaffold-a-todo-app-2');
  });
});

describe('goalExpander.expandGoal — maxTasks cap', () => {
  it('truncates the result to maxTasks', () => {
    const result = expandGoal('Build a wiki from D:\\big.pdf', { maxTasks: 3 });
    expect(result.tasks).toHaveLength(3);
  });
});

describe('goalExpander.renderTasksAsPlanMarkdown', () => {
  it('renders task-loop-compatible Markdown with anchors, target, and kind', () => {
    const md = renderTasksAsPlanMarkdown([
      { id: 'a', title: 'First', kind: 'code' },
      { id: 'b', title: 'Second', kind: 'research', anchors: ['x.md'] },
      { id: 'c', title: 'Third', kind: 'external', anchors: ['D:\\y.pdf', 'D:\\z.pdf'], target: 'out.md' },
    ]);
    // Default "code" kind must NOT be serialized (matches writePlan)
    expect(md).not.toMatch(/kind: code/);
    expect(md).toContain('- [ ] a — First');
    expect(md).toContain('- [ ] b — Second');
    expect(md).toContain('  - anchor: x.md');
    expect(md).toContain('  - kind: research');
    expect(md).toContain('- [ ] c — Third');
    expect(md).toContain('  - anchor: D:\\y.pdf');
    expect(md).toContain('  - anchor: D:\\z.pdf');
    expect(md).toContain('  - target: out.md');
    expect(md).toContain('  - kind: external');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('returns empty string for empty input', () => {
    expect(renderTasksAsPlanMarkdown([])).toBe('');
  });

  it('round-trips through cookbook/task-loop parsePlan', async () => {
    // Integration check: rendered Markdown must be parseable by the loop.
    const { parsePlan } = await import('../../cookbook/task-loop');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-'));
    try {
      const md = '# Implementation Plan\n\n' + renderTasksAsPlanMarkdown([
        { id: 'survey-d-big-pdf', title: 'Survey D:\\big.pdf', kind: 'external', anchors: ['D:\\big.pdf'] },
        { id: 'chunk-d-big-pdf', title: 'Chunk it', kind: 'code' },
      ]);
      const planPath = join(dir, 'IMPLEMENTATION_PLAN.md');
      writeFileSync(planPath, md, 'utf-8');
      const parsed = parsePlan(planPath);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: 'survey-d-big-pdf', kind: 'external', anchors: ['D:\\big.pdf'] });
      expect(parsed[1].id).toBe('chunk-d-big-pdf');
      expect(parsed[1].kind).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
