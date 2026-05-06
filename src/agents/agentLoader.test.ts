import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  BUILTIN_AGENT_ROLES,
  loadAgentDefinitions,
  parseAgentFile,
  resolveAgentDefinition,
  writeCustomAgent,
} from './agentLoader';

describe('agentLoader', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-agents-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('exposes 6 built-in roles', () => {
    expect(BUILTIN_AGENT_ROLES.map((agent) => agent.id)).toEqual([
      'researcher', 'developer', 'qa', 'writer', 'architect', 'security',
    ]);
    for (const agent of BUILTIN_AGENT_ROLES) {
      expect(agent.systemPrompt.length).toBeGreaterThan(0);
      expect(agent.enabled).toBe(true);
    }
  });

  it('parses an agent markdown file', () => {
    const content = '---\nid: planner\nname: Planner\ndescription: Plans things\nrole: architect\npreset: plan\nallowed_tools:\n  - file_read\n  - grep\n---\n\nYou are a Planner.';
    const definition = parseAgentFile(content, '/tmp/planner.md');
    expect(definition).not.toBeNull();
    expect(definition!.id).toBe('planner');
    expect(definition!.preset).toBe('plan');
    expect(definition!.allowedTools).toEqual(['file_read', 'grep']);
    expect(definition!.systemPrompt).toBe('You are a Planner.');
  });

  it('returns null when frontmatter is missing', () => {
    expect(parseAgentFile('No frontmatter here.', '/tmp/x.md')).toBeNull();
  });

  it('loads agent definitions from .harness/agents', async () => {
    const dir = path.join(projectDir, '.harness', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'helper.md'), '---\nid: helper\nname: Helper\ndescription: A helper\n---\nDo helpful things.', 'utf-8');
    const agents = await loadAgentDefinitions(projectDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('helper');
  });

  it('writeCustomAgent persists a parseable agent file', async () => {
    const filePath = await writeCustomAgent(projectDir, {
      id: 'critic',
      name: 'Critic',
      description: 'Critical reviewer',
      role: 'qa',
      systemPrompt: 'You are a Critic.',
      allowedTools: ['file_read'],
    });
    const content = await fs.readFile(filePath, 'utf-8');
    const definition = parseAgentFile(content, filePath);
    expect(definition?.id).toBe('critic');
    expect(definition?.allowedTools).toEqual(['file_read']);
  });

  it('rejects invalid agent ids', async () => {
    await expect(writeCustomAgent(projectDir, {
      id: 'bad id',
      name: 'Bad',
      description: '',
      systemPrompt: 'x',
    })).rejects.toThrow();
  });

  it('resolves to built-in role when no custom override exists', () => {
    const resolved = resolveAgentDefinition('researcher', []);
    expect(resolved?.id).toBe('researcher');
    expect(resolved?.role).toBe('researcher');
  });

  it('custom agent shadows built-in when ids match', async () => {
    const dir = path.join(projectDir, '.harness', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'researcher.md'), '---\nid: researcher\nname: Custom\ndescription: override\n---\nCustom system prompt.', 'utf-8');
    const customs = await loadAgentDefinitions(projectDir);
    const resolved = resolveAgentDefinition('researcher', customs);
    expect(resolved?.systemPrompt).toBe('Custom system prompt.');
  });
});
