import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendSubagentRoutingMetric, createSubagentTool, listSubagentRoutingMetrics, resolveSubagentConfig, type SubagentConfig } from './subagent';
import { UnknownAgentError } from './agentId';

describe('subagent presets', () => {
  it('resolves preset config with routed model defaults', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      preset: 'explore',
      routingPolicy: { smallModel: 'tiny', defaultModel: 'base' },
    };

    const resolved = resolveSubagentConfig(config, 'inspect files');

    expect(resolved).toMatchObject({ name: 'explore', model: 'tiny', maxTurns: 6 });
    expect(resolved.routingDecision).toMatchObject({ tier: 'small', model: 'tiny' });
    expect(resolved.systemPrompt).toContain('read-only exploration helper');
  });

  it('preserves explicit model and prompt overrides', () => {
    const config: SubagentConfig = {
      name: 'custom',
      systemPrompt: 'custom prompt',
      model: 'explicit',
      preset: 'explore',
      routingPolicy: { smallModel: 'tiny' },
    };

    const resolved = resolveSubagentConfig(config, 'inspect files');

    expect(resolved).toMatchObject({ name: 'custom', systemPrompt: 'custom prompt', model: 'explicit' });
  });

  it('appends subagent routing metrics as JSONL', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-subagent-metrics-'));

    const filePath = await appendSubagentRoutingMetric(projectDir, {
      timestamp: '2026-04-29T00:00:00.000Z',
      name: 'explore',
      preset: 'explore',
      model: 'tiny',
      tier: 'small',
      escalated: false,
      reasons: ['bounded low-risk helper task'],
      success: true,
      durationMs: 5,
      outputChars: 12,
    });

    expect(await fs.readFile(filePath, 'utf-8')).toContain('bounded low-risk helper task');
    await expect(listSubagentRoutingMetrics(projectDir)).resolves.toEqual([expect.objectContaining({ model: 'tiny' })]);
  });

  it('resolves a built-in agent definition by id', () => {
    const config: SubagentConfig = { name: '', systemPrompt: '', agentId: 'researcher' };
    const resolved = resolveSubagentConfig(config, 'find docs');
    expect(resolved.systemPrompt).toContain('Researcher');
    expect(resolved.allowedTools).toContain('file_read');
    // Researcher built-in uses preset 'explore' so routing also applies.
    expect(resolved.preset).toBe('explore');
  });

  it('agent definition fields lose to explicit config overrides', () => {
    const config: SubagentConfig = {
      name: 'My Researcher',
      systemPrompt: 'Custom override prompt',
      agentId: 'researcher',
      allowedTools: ['file_read'],
    };
    const resolved = resolveSubagentConfig(config, 'find docs');
    expect(resolved.name).toBe('My Researcher');
    expect(resolved.systemPrompt).toBe('Custom override prompt');
    expect(resolved.allowedTools).toEqual(['file_read']);
  });

  it('custom agents passed via config shadow built-ins', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      agentId: 'researcher',
      customAgents: [{
        id: 'researcher', name: 'Override', description: 'd', systemPrompt: 'CUSTOM', enabled: true, filePath: '<test>',
      }],
    };
    const resolved = resolveSubagentConfig(config, 'find docs');
    expect(resolved.systemPrompt).toBe('CUSTOM');
  });

  it('throws UnknownAgentError when agentId resolves to nothing', () => {
    const config: SubagentConfig = { name: '', systemPrompt: '', agentId: 'not_a_real_agent' };
    expect(() => resolveSubagentConfig(config, 'anything')).toThrow(UnknownAgentError);
  });

  it('treats a disabled custom agent as missing (no silent fallthrough)', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      agentId: 'shadow',
      customAgents: [{
        id: 'shadow', name: 'Shadow', description: 'd', systemPrompt: 'sp', enabled: false, filePath: '<test>',
      }],
    };
    expect(() => resolveSubagentConfig(config, 'x')).toThrow(UnknownAgentError);
  });

  it('the UnknownAgentError lists known agents to help the caller', () => {
    const config: SubagentConfig = { name: '', systemPrompt: '', agentId: 'typo' };
    let caught: UnknownAgentError | undefined;
    try {
      resolveSubagentConfig(config, 'x');
    } catch (err) {
      caught = err as UnknownAgentError;
    }
    expect(caught).toBeDefined();
    expect(caught!.available).toContain('researcher');
    expect(caught!.available).toContain('developer');
  });

  it('prepends identityPrefix to a resolved built-in agent system prompt', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      agentId: 'researcher',
      identityPrefix: 'Your name is Oracle. Be imaginative and bold.',
    };
    const resolved = resolveSubagentConfig(config, 'find docs');
    expect(resolved.systemPrompt.startsWith('Your name is Oracle.')).toBe(true);
    // Role definition is still intact after the persona preamble.
    expect(resolved.systemPrompt).toContain('Researcher');
  });

  it('identityPrefix is a no-op when empty', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      agentId: 'researcher',
      identityPrefix: '',
    };
    const resolved = resolveSubagentConfig(config, 'find docs');
    expect(resolved.systemPrompt.startsWith('You are a Researcher')).toBe(true);
  });

  it('identityPrefix is not double-prepended on repeated resolves', () => {
    const config: SubagentConfig = {
      name: '',
      systemPrompt: '',
      agentId: 'researcher',
      identityPrefix: 'Your name is Oracle.',
    };
    const once = resolveSubagentConfig(config, 'x');
    const twice = resolveSubagentConfig(once, 'x');
    expect(twice.systemPrompt).toBe(once.systemPrompt);
  });
});

describe('createSubagentTool', () => {
  function fakeClient() { return { getModel: () => 'fake' } as unknown as Parameters<typeof createSubagentTool>[0]['getParentClient'] extends () => infer T ? T : never; }

  it('builds a callable tool that delegates via runSubagent', async () => {
    const calls: Array<{ config: SubagentConfig; prompt: string }> = [];
    const tool = createSubagentTool({
      getParentClient: () => fakeClient(),
      getAvailableTools: () => [],
      getCustomAgents: () => [],
      runner: async (config, prompt) => {
        calls.push({ config, prompt });
        return 'summary text';
      },
    });
    const result = await tool.execute({ prompt: 'find the bug', agent_id: 'researcher' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('summary text');
    expect(calls).toHaveLength(1);
    expect(calls[0].config.agentId).toBe('researcher');
    expect(calls[0].prompt).toBe('find the bug');
  });

  it('rejects calls without a prompt', async () => {
    const tool = createSubagentTool({
      getParentClient: () => fakeClient(),
      getAvailableTools: () => [],
      runner: async () => 'never',
    });
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('prompt');
  });

  it('passes legacy type through as the subagent name when agent_id is absent', async () => {
    const captured: { config?: SubagentConfig } = {};
    const tool = createSubagentTool({
      getParentClient: () => fakeClient(),
      getAvailableTools: () => [],
      runner: async (config) => { captured.config = config; return 'ok'; },
    });
    await tool.execute({ prompt: 'plan the work', type: 'plan' });
    expect(captured.config?.name).toBe('plan');
    expect(captured.config?.agentId).toBeUndefined();
  });

  it('returns an error result when the runner throws', async () => {
    const tool = createSubagentTool({
      getParentClient: () => fakeClient(),
      getAvailableTools: () => [],
      runner: async () => { throw new Error('boom'); },
    });
    const result = await tool.execute({ prompt: 'do something' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});