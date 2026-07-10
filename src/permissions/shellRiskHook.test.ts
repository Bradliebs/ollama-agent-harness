import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HookPipeline } from '../extensibility/hookPipeline';
import { createShellRiskHooks, resolveShellRules } from './shellRiskHook';
import { DEFAULT_SHELL_RULES } from './defaultShellRules';

function mkTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shell-risk-test-'));
}

describe('createShellRiskHooks — gating behaviour', () => {
  it('blocks dangerous shell commands with the matched rule in the reason', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);

    const r = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
    });

    expect(r.action).toBe('block');
    expect(r.reason).toContain('rm-rf-root');
    expect(r.reason).toContain('rm -rf /');
  });

  it('continues for safe commands', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);
    const r = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'ls -la' },
    });
    expect(r.action).toBe('continue');
  });

  it('continues for write commands (existing permission engine prompts)', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);
    const r = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm one-file.txt' },
    });
    expect(r.action).toBe('continue');
  });

  it('ignores non-shell tools', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);
    const r = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'file_read',
      toolInput: { path: '/etc/passwd' },
    });
    expect(r.action).toBe('continue');
  });

  it('ignores PostToolUse', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);
    const r = await pipeline.execute({
      eventType: 'PostToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
      toolOutput: 'done',
    });
    expect(r.action).toBe('continue');
  });

  it('ignores calls with no command field', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks()) pipeline.register(h);
    const r = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { not_a_command: 'something' },
    });
    expect(r.action).toBe('continue');
  });

  it('honours a custom shellToolNames list', async () => {
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks({ shellToolNames: ['my_shell'] })) pipeline.register(h);

    const blocked = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'my_shell',
      toolInput: { command: 'rm -rf /' },
    });
    expect(blocked.action).toBe('block');

    const ignored = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
    });
    expect(ignored.action).toBe('continue');
  });
});

describe('resolveShellRules — .harness/shell-rules.json override', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkTmpProject();
  });
  afterEach(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns defaults when no override file exists', () => {
    const r = resolveShellRules({ projectDir });
    expect(r).toBe(DEFAULT_SHELL_RULES);
  });

  it('returns defaults when no projectDir is supplied', () => {
    expect(resolveShellRules()).toBe(DEFAULT_SHELL_RULES);
  });

  it('merges user rules with defaults so user rules win on conflict', async () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.harness', 'shell-rules.json'),
      JSON.stringify({
        rules: [{ id: 'org-ban-curl', pattern: '^\\s*curl\\b', tier: 'dangerous', reason: 'no outbound network' }],
      }),
      'utf-8',
    );
    const errors: string[] = [];
    const pipeline = new HookPipeline();
    for (const h of createShellRiskHooks({ projectDir, logError: (m) => errors.push(m) })) {
      pipeline.register(h);
    }
    const blocked = await pipeline.execute({
      eventType: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'curl https://example.com' },
    });
    expect(blocked.action).toBe('block');
    expect(blocked.reason).toContain('org-ban-curl');
    expect(errors).toEqual([]);
  });

  it('logs loudly and falls back to defaults when JSON is malformed', () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.harness', 'shell-rules.json'), '{ this is not json', 'utf-8');
    const errors: string[] = [];
    const r = resolveShellRules({ projectDir, logError: (m) => errors.push(m) });
    expect(r).toBe(DEFAULT_SHELL_RULES);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('not valid JSON');
  });

  it('logs loudly and falls back when the top-level "rules" is missing', () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.harness', 'shell-rules.json'), JSON.stringify({ foo: 1 }), 'utf-8');
    const errors: string[] = [];
    const r = resolveShellRules({ projectDir, logError: (m) => errors.push(m) });
    expect(r).toBe(DEFAULT_SHELL_RULES);
    expect(errors[0]).toContain('top-level "rules"');
  });

  it('skips malformed individual rules but keeps the rest', () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.harness', 'shell-rules.json'),
      JSON.stringify({
        rules: [
          { id: 'good', pattern: '^foo', tier: 'safe', reason: 'ok' },
          { id: 'bad-tier', pattern: 'x', tier: 'nope', reason: 'r' },
          { pattern: 'y', tier: 'safe', reason: 'r' }, // missing id
          { id: 'bad-regex', pattern: '[unclosed', tier: 'safe', reason: 'r' },
        ],
      }),
      'utf-8',
    );
    const errors: string[] = [];
    const merged = resolveShellRules({ projectDir, logError: (m) => errors.push(m) });
    // Should contain at least one user rule (the good one) plus defaults.
    expect(merged.length).toBeGreaterThan(DEFAULT_SHELL_RULES.length);
    expect(merged[0]?.id).toBe('good');
    expect(errors.length).toBe(3); // bad-tier, missing-id, bad-regex
  });

  it('ignores rule arrays that are not arrays at all', () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.harness', 'shell-rules.json'),
      JSON.stringify({ rules: 'not-an-array' }),
      'utf-8',
    );
    const errors: string[] = [];
    const r = resolveShellRules({ projectDir, logError: (m) => errors.push(m) });
    expect(r).toBe(DEFAULT_SHELL_RULES);
    expect(errors[0]).toContain('top-level "rules"');
  });
});
