/**
 * Coverage for cookbook/task-loop.ts task-kind annotations.
 *
 * The `kind:` annotation lets the plan declare a per-task success contract:
 *   - code     (default) must produce ≥1 file change and validate
 *   - research must validate; 0 file changes is allowed
 *   - external touches paths outside the repo; the loop auto-writes a
 *              runbook so a tracked artifact always exists
 *
 * This guarantees research / external-investigation tasks no longer trip
 * the "0 file changes → failed" guard that previously stranded plans.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureRunbook, parsePlan, writePlan } from '../../cookbook/task-loop';

describe('cookbook/task-loop kind annotation', () => {
  const originalCwd = process.cwd();
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'forge-kind-'));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('parses kind: research|external|code and defaults to undefined when absent', () => {
    const planPath = join(workDir, 'IMPLEMENTATION_PLAN.md');
    writeFileSync(
      planPath,
      [
        '# Implementation Plan',
        '',
        '- [ ] plain-task — A normal code task',
        '- [ ] research-task — Investigate something',
        '  - kind: research',
        '- [ ] external-task — Look in C:\\Some\\Path',
        '  - kind: external',
        '- [ ] code-task — Explicit code kind',
        '  - kind: code',
        '',
      ].join('\n'),
      'utf-8',
    );

    const tasks = parsePlan(planPath);
    expect(tasks).toHaveLength(4);
    expect(tasks[0].kind).toBeUndefined();
    expect(tasks[1].kind).toBe('research');
    expect(tasks[2].kind).toBe('external');
    expect(tasks[3].kind).toBe('code');
  });

  it('round-trips kind annotations through writePlan (only emits non-code kinds)', () => {
    const planPath = join(workDir, 'IMPLEMENTATION_PLAN.md');
    const original = [
      '# Implementation Plan',
      '',
      '- [ ] plain — Plain task',
      '- [ ] r — Research task',
      '  - kind: research',
      '- [ ] e — External task',
      '  - anchor: notes.md',
      '  - kind: external',
      '',
    ].join('\n');
    writeFileSync(planPath, original, 'utf-8');

    const tasks = parsePlan(planPath);
    writePlan(planPath, tasks);
    const reparsed = parsePlan(planPath);

    expect(reparsed.map((t) => ({ id: t.id, kind: t.kind, anchors: t.anchors }))).toEqual([
      { id: 'plain', kind: undefined, anchors: [] },
      { id: 'r', kind: 'research', anchors: [] },
      { id: 'e', kind: 'external', anchors: ['notes.md'] },
    ]);

    const rewritten = readFileSync(planPath, 'utf-8');
    // Default "code" kind must NOT be serialized — keeps existing plans diff-free.
    expect(rewritten).not.toMatch(/kind: code/);
    expect(rewritten).toMatch(/kind: research/);
    expect(rewritten).toMatch(/kind: external/);
  });

  it('ensureRunbook creates .forge-runbooks/{id}.md with task metadata when missing', () => {
    ensureRunbook({
      id: 'look-outside-repo',
      title: 'Look in D:\\Brad\\AI\\Brain and report',
      status: 'pending',
      anchors: ['D:\\Brad\\AI\\Brain\\spec.md'],
      kind: 'external',
    });

    const path = join(workDir, '.forge-runbooks', 'look-outside-repo.md');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    expect(body).toMatch(/Look in D:\\Brad\\AI\\Brain and report/);
    expect(body).toMatch(/D:\\Brad\\AI\\Brain\\spec\.md/);
    expect(body).toMatch(/## Findings/);
  });

  it('ensureRunbook is idempotent — does not overwrite existing runbook content', () => {
    const dir = join(workDir, '.forge-runbooks');
    require('node:fs').mkdirSync(dir, { recursive: true });
    const path = join(dir, 'already-there.md');
    writeFileSync(path, 'AGENT-AUTHORED CONTENT', 'utf-8');

    ensureRunbook({
      id: 'already-there',
      title: 'Anything',
      status: 'pending',
      anchors: [],
      kind: 'external',
    });

    expect(readFileSync(path, 'utf-8')).toBe('AGENT-AUTHORED CONTENT');
  });
});
