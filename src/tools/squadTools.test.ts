import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SquadInspectTool } from './squadTools';
import { createSquad } from '../services/squad';
import { getProjectRoot, setProjectRoot } from './pathResolution';

describe('SquadInspectTool', () => {
  let projectDir: string;
  let originalCwd: string;
  let originalProjectRoot: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-squadtool-'));
    originalCwd = process.cwd();
    originalProjectRoot = getProjectRoot();
    process.chdir(projectDir);
    setProjectRoot(projectDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    setProjectRoot(originalProjectRoot);
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('list returns "No squads defined" when none exist', async () => {
    const result = await SquadInspectTool.execute({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No squads');
  });

  it('list returns one line per squad', async () => {
    await createSquad(projectDir, { id: 'alpha', name: 'Alpha', leadAgentId: 'researcher' });
    await createSquad(projectDir, { id: 'beta', name: 'Beta', leadAgentId: 'developer' });
    const result = await SquadInspectTool.execute({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/alpha: Alpha/);
    expect(result.output).toMatch(/beta: Beta/);
  });

  it('get returns the full squad definition', async () => {
    await createSquad(projectDir, { id: 'alpha', name: 'Alpha', leadAgentId: 'researcher' });
    const result = await SquadInspectTool.execute({ action: 'get', squad_id: 'alpha' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.id).toBe('alpha');
    expect(parsed.leadAgentId).toBe('researcher');
  });

  it('get fails with a clear error when the squad is missing', async () => {
    const result = await SquadInspectTool.execute({ action: 'get', squad_id: 'missing' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });

  it('route returns the lead agent when no rules match', async () => {
    await createSquad(projectDir, { id: 'alpha', name: 'Alpha', leadAgentId: 'researcher' });
    const result = await SquadInspectTool.execute({ action: 'route', squad_id: 'alpha', message: 'hello world' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.agentId).toBe('researcher');
    expect(parsed.isFallback).toBe(true);
  });

  it('route honours routing rules', async () => {
    await createSquad(projectDir, {
      id: 'alpha',
      name: 'Alpha',
      leadAgentId: 'researcher',
      roster: [{ agentId: 'developer', role: 'dev', capabilities: ['coding'] }],
      routingRules: [{ pattern: 'bug|fix', agentId: 'developer', priority: 10 }],
    });
    const result = await SquadInspectTool.execute({ action: 'route', squad_id: 'alpha', message: 'fix the bug' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.agentId).toBe('developer');
    expect(parsed.isFallback).toBe(false);
  });

  it('handoff approves a roster-to-roster transfer below the depth limit', async () => {
    await createSquad(projectDir, {
      id: 'alpha',
      name: 'Alpha',
      leadAgentId: 'researcher',
      roster: [{ agentId: 'developer', role: 'dev', capabilities: ['coding'] }],
    });
    const result = await SquadInspectTool.execute({ action: 'handoff', squad_id: 'alpha', from_agent_id: 'researcher', to_agent_id: 'developer', current_depth: 0 });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.allowed).toBe(true);
  });

  it('handoff rejects an unknown to-agent', async () => {
    await createSquad(projectDir, { id: 'alpha', name: 'Alpha', leadAgentId: 'researcher' });
    const result = await SquadInspectTool.execute({ action: 'handoff', squad_id: 'alpha', from_agent_id: 'researcher', to_agent_id: 'ghost', current_depth: 0 });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.allowed).toBe(false);
    expect(parsed.reason).toContain('not on the squad roster');
  });

  it('rejects an unknown action', async () => {
    const result = await SquadInspectTool.execute({ action: 'nope' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown action');
  });
});
