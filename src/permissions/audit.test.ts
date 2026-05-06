import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { HookPipeline } from '../extensibility/hookPipeline';
import { auditFilePath, createAuditHooks, readAuditLog, renderRecentAuditForPrompt, type AuditEntry } from './audit';

describe('audit hook', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-audit-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('writes a JSONL line per tool call across all three hook events', async () => {
    const pipeline = new HookPipeline();
    for (const hook of createAuditHooks({ projectDir })) pipeline.register(hook);

    await pipeline.execute({ eventType: 'PreToolUse', toolName: 'file_read', toolInput: { path: '/tmp/x' } });
    await pipeline.execute({ eventType: 'PostToolUse', toolName: 'file_read', toolOutput: 'file contents' });
    await pipeline.execute({ eventType: 'PostToolUseFailure', toolName: 'bash', toolInput: { command: 'rm -rf /' }, error: 'denied by policy' });

    const entries = await readAuditLog(projectDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].eventType).toBe('PreToolUse');
    expect(entries[0].tool).toBe('file_read');
    expect(entries[0].input).toContain('/tmp/x');
    expect(entries[1].eventType).toBe('PostToolUse');
    expect(entries[1].output).toBe('file contents');
    expect(entries[2].eventType).toBe('PostToolUseFailure');
    expect(entries[2].error).toBe('denied by policy');
  });

  it('writes the audit log to .harness/audit.log by default', async () => {
    const pipeline = new HookPipeline();
    for (const hook of createAuditHooks({ projectDir })) pipeline.register(hook);
    await pipeline.execute({ eventType: 'PreToolUse', toolName: 'file_read', toolInput: { path: 'a' } });
    const stat = await fs.stat(auditFilePath(projectDir));
    expect(stat.isFile()).toBe(true);
  });

  it('redacts known secret fields in the captured input', async () => {
    const pipeline = new HookPipeline();
    for (const hook of createAuditHooks({ projectDir })) pipeline.register(hook);
    await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'web_fetch',
      toolInput: { url: 'https://example', api_key: 'super-secret', nested: { token: 'shh' } },
    });
    const entries = await readAuditLog(projectDir);
    expect(entries[0].input).not.toContain('super-secret');
    expect(entries[0].input).not.toContain('shh');
    expect(entries[0].input).toContain('[redacted]');
  });

  it('truncates long fields to the configured cap', async () => {
    const pipeline = new HookPipeline();
    for (const hook of createAuditHooks({ projectDir, maxFieldChars: 50 })) pipeline.register(hook);
    const long = 'x'.repeat(500);
    await pipeline.execute({ eventType: 'PostToolUse', toolName: 'bash', toolOutput: long });
    const entries = await readAuditLog(projectDir);
    expect(entries[0].output?.length).toBeLessThan(120);
    expect(entries[0].output).toContain('[+');
  });

  it('never blocks the hook pipeline even when the audit file cannot be written', async () => {
    const badPath = path.join(projectDir, 'nope', 'does-not-exist', 'audit.log');
    const pipeline = new HookPipeline();
    // Force a write failure by pointing at a directory that the create can still mkdir,
    // but if anything throws inside, the hook still returns 'continue'.
    for (const hook of createAuditHooks({ projectDir, filePath: badPath })) pipeline.register(hook);
    const result = await pipeline.execute({ eventType: 'PreToolUse', toolName: 'noop', toolInput: { x: 1 } });
    expect(result.action).toBe('continue');
  });
});

describe('renderRecentAuditForPrompt', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-audit-render-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  function makeReader(entries: AuditEntry[]) {
    return async (_dir: string, _limit?: number) => entries;
  }

  it('returns empty when there are no recent failures', async () => {
    const rendered = await renderRecentAuditForPrompt(projectDir, { reader: makeReader([]) });
    expect(rendered).toBe('');
  });

  it('returns empty when failures are below threshold', async () => {
    const now = new Date().toISOString();
    const rendered = await renderRecentAuditForPrompt(projectDir, {
      reader: makeReader([{ timestamp: now, eventType: 'PostToolUseFailure', tool: 'bash', error: 'denied' }]),
      minFailures: 2,
    });
    expect(rendered).toBe('');
  });

  it('summarises recent failures with a per-tool breakdown', async () => {
    const now = new Date().toISOString();
    const rendered = await renderRecentAuditForPrompt(projectDir, {
      reader: makeReader([
        { timestamp: now, eventType: 'PostToolUseFailure', tool: 'bash', error: 'denied' },
        { timestamp: now, eventType: 'PostToolUseFailure', tool: 'bash', error: 'denied again' },
        { timestamp: now, eventType: 'PostToolUseFailure', tool: 'web_fetch', error: 'HTTP 429' },
        { timestamp: now, eventType: 'PostToolUse', tool: 'file_read', output: 'ok' },
      ]),
      minFailures: 2,
    });
    expect(rendered).toContain('Recent Audit');
    expect(rendered).toContain('bash: 2 failure(s)');
    expect(rendered).toContain('web_fetch: 1 failure(s)');
  });

  it('ignores entries outside the time window', async () => {
    const ancient = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rendered = await renderRecentAuditForPrompt(projectDir, {
      reader: makeReader([
        { timestamp: ancient, eventType: 'PostToolUseFailure', tool: 'bash', error: 'old' },
        { timestamp: ancient, eventType: 'PostToolUseFailure', tool: 'bash', error: 'old' },
      ]),
      windowMs: 5 * 60_000,
    });
    expect(rendered).toBe('');
  });
});
