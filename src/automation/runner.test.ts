import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { matchShellCommandPreset, listShellCommandAllowlistPresets, buildAutomationPrompt, SHELL_COMMAND_ALLOWLIST_PRESETS, prepareAutomationRun } from './runner';
import type { AutomationJob } from './jobs';
import { readCapabilityAuditEvents } from '../permissions/capabilityAudit';

describe('matchShellCommandPreset', () => {
  it('matches git read-only commands', () => {
    expect(matchShellCommandPreset('git status')).toMatchObject({ id: 'git-read-status' });
    expect(matchShellCommandPreset('git status --short')).toMatchObject({ id: 'git-read-status' });
    expect(matchShellCommandPreset('git diff --stat')).toMatchObject({ id: 'git-read-status' });
    expect(matchShellCommandPreset('git diff --name-only')).toMatchObject({ id: 'git-read-status' });
    expect(matchShellCommandPreset('git log --oneline -5')).toMatchObject({ id: 'git-read-status' });
  });

  it('matches file discovery commands', () => {
    expect(matchShellCommandPreset('rg --files')).toMatchObject({ id: 'file-discovery' });
    expect(matchShellCommandPreset('dir')).toMatchObject({ id: 'file-discovery' });
    expect(matchShellCommandPreset('Get-ChildItem')).toMatchObject({ id: 'file-discovery' });
  });

  it('matches tool version checks', () => {
    expect(matchShellCommandPreset('node --version')).toMatchObject({ id: 'tool-version' });
    expect(matchShellCommandPreset('npm --version')).toMatchObject({ id: 'tool-version' });
    expect(matchShellCommandPreset('git --version')).toMatchObject({ id: 'tool-version' });
    expect(matchShellCommandPreset('node -v')).toMatchObject({ id: 'tool-version' });
  });

  it('matches project validation scripts', () => {
    expect(matchShellCommandPreset('npm run typecheck')).toMatchObject({ id: 'project-validation' });
    expect(matchShellCommandPreset('npm run build')).toMatchObject({ id: 'project-validation' });
    expect(matchShellCommandPreset('npm run smoke:ui')).toMatchObject({ id: 'project-validation' });
  });

  it('matches read-only dependency audits', () => {
    expect(matchShellCommandPreset('npm audit')).toMatchObject({ id: 'dependency-audit' });
    expect(matchShellCommandPreset('npm audit --audit-level=moderate')).toMatchObject({ id: 'dependency-audit' });
    expect(matchShellCommandPreset('npm audit --audit-level=high --json')).toMatchObject({ id: 'dependency-audit' });
  });

  it('rejects commands not in any preset', () => {
    expect(matchShellCommandPreset('rm -rf /')).toBeNull();
    expect(matchShellCommandPreset('node -e "process.exit(1)"')).toBeNull();
    expect(matchShellCommandPreset('curl https://evil.com')).toBeNull();
    expect(matchShellCommandPreset('powershell -c "Get-Process"')).toBeNull();
    expect(matchShellCommandPreset('npm install malicious-pkg')).toBeNull();
    expect(matchShellCommandPreset('npm run test')).toBeNull();
    expect(matchShellCommandPreset('npm audit fix')).toBeNull();
  });

  it('rejects command chaining and injection attempts', () => {
    expect(matchShellCommandPreset('node --version && rm -rf /')).toBeNull();
    expect(matchShellCommandPreset('node --version; rm -rf /')).toBeNull();
    expect(matchShellCommandPreset('node --version | cat /etc/passwd')).toBeNull();
    expect(matchShellCommandPreset('git status && curl evil.com')).toBeNull();
    expect(matchShellCommandPreset('dir & del *')).toBeNull();
    expect(matchShellCommandPreset('git status`whoami`')).toBeNull();
  });

  it('rejects mutating git commands', () => {
    expect(matchShellCommandPreset('git push')).toBeNull();
    expect(matchShellCommandPreset('git commit -m "x"')).toBeNull();
    expect(matchShellCommandPreset('git reset --hard')).toBeNull();
    expect(matchShellCommandPreset('git checkout main')).toBeNull();
    expect(matchShellCommandPreset('git branch -d feature')).toBeNull();
  });

  it('rejects path traversal in file discovery', () => {
    expect(matchShellCommandPreset('dir ../../secret')).toBeNull();
    expect(matchShellCommandPreset('dir ..\\..\\secret')).toBeNull();
    expect(matchShellCommandPreset('rg --files ../../')).toBeNull();
  });

  it('normalizes whitespace before matching', () => {
    expect(matchShellCommandPreset('  node   --version  ')).toMatchObject({ id: 'tool-version' });
    expect(matchShellCommandPreset('git  status  --short')).toMatchObject({ id: 'git-read-status' });
  });
});

describe('listShellCommandAllowlistPresets', () => {
  it('returns presets without exposing regex patterns', () => {
    const presets = listShellCommandAllowlistPresets();

    expect(presets.length).toBe(SHELL_COMMAND_ALLOWLIST_PRESETS.length);
    for (const preset of presets) {
      expect(preset).toHaveProperty('id');
      expect(preset).toHaveProperty('label');
      expect(preset).toHaveProperty('examples');
      expect(preset).not.toHaveProperty('pattern');
    }
  });

  it('returns copies of examples arrays', () => {
    const presets = listShellCommandAllowlistPresets();
    const original = SHELL_COMMAND_ALLOWLIST_PRESETS[0].examples;
    presets[0].examples.push('injected');

    expect(original).not.toContain('injected');
  });
});

describe('buildAutomationPrompt', () => {
  const stubJob: AutomationJob = {
    id: 'test-job',
    name: 'Test',
    prompt: 'Base prompt',
    schedule: { kind: 'once', runAt: '2026-05-01T00:00:00.000Z', display: '30m' },
    enabled: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  it('returns bare prompt when script output is empty', async () => {
    await expect(buildAutomationPrompt(stubJob, '')).resolves.toBe('Base prompt');
    await expect(buildAutomationPrompt(stubJob, '   ')).resolves.toBe('Base prompt');
    await expect(buildAutomationPrompt(stubJob)).resolves.toBe('Base prompt');
  });

  it('appends script context when script output is present', async () => {
    const result = await buildAutomationPrompt(stubJob, 'CHANGE DETECTED');

    expect(result).toContain('Base prompt');
    expect(result).toContain('Script context:');
    expect(result).toContain('CHANGE DETECTED');
  });
});

describe('prepareAutomationRun dependency scan policy', () => {
  it('blocks the Dependency Vulnerability Scan starter without grants and records audit evidence', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-dependency-scan-'));
    const job: AutomationJob = {
      id: 'dependency-vulnerability-scan',
      name: 'Dependency Vulnerability Scan',
      prompt: 'Run dependency scan and summarize vulnerabilities, remediation urgency, and lockfile changes needed.',
      schedule: { kind: 'interval', minutes: 10_080, display: 'weekly' },
      enabled: true,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      scriptCommand: 'npm audit --audit-level=moderate',
    };

    const result = await prepareAutomationRun(projectDir, job, new Date('2026-05-06T00:00:00.000Z'));
    const events = await readCapabilityAuditEvents(projectDir);

    expect(result.scriptOutput).toContain('Script blocked by arbitrary-shell');
    expect(result.prompt).toContain('Script context:');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'automation_script.denied', jobId: job.id, command: 'npm audit --audit-level=moderate' }),
    ]));
  });
});
