import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { MemoryWriteTool } from './memoryTools';
import { runWithSessionId } from './sessionContext';
import { parseMemoryFile } from '../services/memoryIntelligence';

// Exercises the provenance stamping and opt-in conflict enforce gate added to
// the `remember` tool. ccmem dual-write is best-effort and offline here, so it
// never affects these assertions.

describe('MemoryWriteTool provenance + enforce', () => {
  let projectDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-remember-'));
    for (const key of ['HARNESS_PROJECT_DIR', 'HARNESS_SESSION_ID', 'HARNESS_MEMORY_CONFLICT_ENFORCE', 'HARNESS_MEMORY_CONFLICT_THRESHOLD']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HARNESS_PROJECT_DIR = projectDir;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function readNotes(): Promise<string> {
    return fs.readFile(path.join(projectDir, '.harness', 'memory', 'notes.md'), 'utf-8');
  }

  it('stamps created-by and source-session when HARNESS_SESSION_ID is set', async () => {
    process.env.HARNESS_SESSION_ID = 'sess-xyz';
    const result = await MemoryWriteTool.execute({ category: 'note', title: 'Greeting', content: 'Say hello.' });
    expect(result.success).toBe(true);

    const parsed = parseMemoryFile(await readNotes(), 'notes.md');
    const section = parsed.sections.find((s) => s.title.includes('Greeting'));
    expect(section?.createdByTool).toBe('remember');
    expect(section?.sourceSessionId).toBe('sess-xyz');
  });

  it('stamps source-session from the async context (no env var)', async () => {
    const result = await runWithSessionId('ctx-session', () =>
      MemoryWriteTool.execute({ category: 'note', title: 'ContextGreeting', content: 'Hi from context.' }));
    expect(result.success).toBe(true);
    expect(process.env.HARNESS_SESSION_ID).toBeUndefined();

    const parsed = parseMemoryFile(await readNotes(), 'notes.md');
    const section = parsed.sections.find((s) => s.title.includes('ContextGreeting'));
    expect(section?.sourceSessionId).toBe('ctx-session');
  });

  it('records created-by but no source-session when no session is set', async () => {
    const result = await MemoryWriteTool.execute({ category: 'note', title: 'NoSession', content: 'Body.' });
    expect(result.success).toBe(true);

    const content = await readNotes();
    expect(content).toContain('created-by: remember');
    expect(content).not.toContain('source-session');
  });

  it('blocks a conflicting write when enforce mode is on', async () => {
    await MemoryWriteTool.execute({
      category: 'note',
      title: 'Async style',
      content: 'always use async await callbacks promises for asynchronous code in this project',
    });

    process.env.HARNESS_MEMORY_CONFLICT_ENFORCE = '1';
    process.env.HARNESS_MEMORY_CONFLICT_THRESHOLD = '0.1';
    const blocked = await MemoryWriteTool.execute({
      category: 'note',
      title: 'Async style',
      content: 'avoid async await callbacks promises entirely, never use async await callbacks',
    });

    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe('memory-conflict');
    const content = await readNotes();
    expect(content).not.toContain('avoid async await callbacks promises entirely');
  });

  it('writes through with a warning when enforce mode is off (default)', async () => {
    await MemoryWriteTool.execute({
      category: 'note',
      title: 'Async style',
      content: 'always use async await callbacks promises for asynchronous code in this project',
    });

    const second = await MemoryWriteTool.execute({
      category: 'note',
      title: 'Async style',
      content: 'avoid async await callbacks promises entirely, never use async await callbacks',
    });

    expect(second.success).toBe(true);
    expect(second.output).toContain('Conflict warning');
    const content = await readNotes();
    expect(content).toContain('avoid async await callbacks promises entirely');
  });
});
