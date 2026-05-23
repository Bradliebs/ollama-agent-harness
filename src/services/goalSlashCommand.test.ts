/**
 * Tests for the /goal slash command handler.
 */
import * as path from 'node:path';
import { tryGoalSlashCommand } from './goalSlashCommand';

const REPO = path.resolve('/repo');
const PLAN = path.resolve(REPO, 'IMPLEMENTATION_PLAN.md');
const SIDE_PLAN = path.resolve(REPO, 'side-plan.md');

function makeFakeFs(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    hooks: {
      readFile: async (p: string) => {
        if (!store.has(p)) throw new Error('ENOENT');
        return store.get(p)!;
      },
      appendFile: async (p: string, data: string) => {
        store.set(p, (store.get(p) ?? '') + data);
      },
      writeFile: async (p: string, data: string) => {
        store.set(p, data);
      },
      access: async (p: string) => {
        if (!store.has(p)) throw new Error('ENOENT');
      },
    },
  };
}

describe('tryGoalSlashCommand', () => {
  it('ignores messages that do not start with /goal', async () => {
    const fake = makeFakeFs();
    const result = await tryGoalSlashCommand('hello there', { projectDir: REPO, fs: fake.hooks });
    expect(result.handled).toBe(false);
    expect(result.mutated).toBe(false);
  });

  it('returns usage help when /goal is passed with no intent', async () => {
    const fake = makeFakeFs();
    const result = await tryGoalSlashCommand('/goal', { projectDir: REPO, fs: fake.hooks });
    expect(result.handled).toBe(true);
    expect(result.mutated).toBe(false);
    expect(result.response).toMatch(/Usage:/);
    expect(result.response).toMatch(/--dry/);
  });

  it('creates the plan file when it does not exist', async () => {
    const fake = makeFakeFs();
    const result = await tryGoalSlashCommand('/goal Build a todo app', { projectDir: REPO, fs: fake.hooks });
    expect(result.handled).toBe(true);
    expect(result.mutated).toBe(true);
    expect(result.tasks.length).toBeGreaterThan(0);
    const written = fake.store.get(PLAN);
    expect(written).toContain('# Implementation Plan');
    expect(written).toMatch(/- \[ \] design-a-todo-app/);
    expect(result.response).toMatch(/Appended \*\*\d+\*\* task\(s\)/);
  });

  it('appends to an existing plan and avoids duplicate IDs', async () => {
    const initial = '# Implementation Plan\n\n- [x] design-a-todo-app — old\n';
    const fake = makeFakeFs({ [PLAN]: initial });
    const result = await tryGoalSlashCommand('/goal Build a todo app', { projectDir: REPO, fs: fake.hooks });
    expect(result.mutated).toBe(true);
    const final = fake.store.get(PLAN)!;
    expect(final).toContain('- [x] design-a-todo-app — old');
    expect(final).toMatch(/- \[ \] design-a-todo-app-2/);
    expect(final).toMatch(/- \[ \] scaffold-a-todo-app/);
  });

  it('respects --dry: does not touch filesystem and labels output as dry run', async () => {
    const initial = '# Implementation Plan\n';
    const fake = makeFakeFs({ [PLAN]: initial });
    const result = await tryGoalSlashCommand('/goal --dry Research https://acme.example.com', { projectDir: REPO, fs: fake.hooks });
    expect(result.handled).toBe(true);
    expect(result.mutated).toBe(false);
    expect(fake.store.get(PLAN)).toBe(initial);
    expect(result.response).toMatch(/Dry run/);
    expect(result.response).toMatch(/acme\.example\.com/);
  });

  it('respects --plan to target a non-default file', async () => {
    const fake = makeFakeFs();
    const result = await tryGoalSlashCommand('/goal --plan side-plan.md Build a thing', { projectDir: REPO, fs: fake.hooks });
    expect(result.mutated).toBe(true);
    expect(fake.store.has(PLAN)).toBe(false);
    expect(fake.store.has(SIDE_PLAN)).toBe(true);
  });

  it('returns usage when /goal is passed with only whitespace', async () => {
    const fake = makeFakeFs();
    const result = await tryGoalSlashCommand('/goal    ', { projectDir: REPO, fs: fake.hooks });
    expect(result.response).toMatch(/Usage:/);
  });
});
