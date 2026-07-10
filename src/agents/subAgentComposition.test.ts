import {
  createSubAgentToolsFromDefinition,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  renderSubAgentPrompt,
  runSubagent,
  type SubagentConfig,
} from './subagent';
import { parseAgentFile, type AgentDefinition } from './agentLoader';
import type { IChatClient } from '../core/chatClient';
import type { Tool } from '../types';

// Stub chat client — none of these tests actually exercise the model loop;
// the runner is overridden with a spy so we only observe what gets dispatched.
function makeStubClient(): IChatClient {
  return {
    getModel: () => 'stub-model',
    setModel: () => {},
    chat: async () => ({ message: { role: 'assistant', content: '' } } as never),
    chatStream: async function* () { yield { message: { role: 'assistant', content: '' } } as never; },
  } as unknown as IChatClient;
}

describe('sub-agent declarative composition', () => {
  describe('parseAgentFile sub_agents frontmatter', () => {
    it('parses a sub_agents block with values and description', () => {
      const md = [
        '---',
        'id: orchestrator',
        'name: Orchestrator',
        'description: Coordinates sub-tasks',
        'sub_agents:',
        '  - name: research',
        '    agent_id: researcher',
        '    description: Pulls background context',
        '    values:',
        '      topic: quantum computing',
        '      depth: detailed',
        '  - name: summarize',
        '    agent_id: writer',
        '---',
        '',
        'You orchestrate.',
      ].join('\n');
      const def = parseAgentFile(md, '/tmp/orchestrator.md');
      expect(def).not.toBeNull();
      expect(def!.subAgents).toEqual([
        {
          name: 'research',
          agentId: 'researcher',
          description: 'Pulls background context',
          values: { topic: 'quantum computing', depth: 'detailed' },
        },
        { name: 'summarize', agentId: 'writer' },
      ]);
    });

    it('omits subAgents when frontmatter has no sub_agents key', () => {
      const md = '---\nid: solo\nname: Solo\ndescription: standalone\n---\nbody';
      const def = parseAgentFile(md, '/tmp/solo.md');
      expect(def!.subAgents).toBeUndefined();
    });

    it('drops sub_agents entries missing name or agent_id', () => {
      const md = [
        '---',
        'id: bad',
        'name: Bad',
        'description: ignores invalid entries',
        'sub_agents:',
        '  - name: missing_id',
        '  - agent_id: missing_name',
        '  - name: good',
        '    agent_id: writer',
        '---',
        '',
        'body',
      ].join('\n');
      const def = parseAgentFile(md, '/tmp/bad.md');
      expect(def!.subAgents).toEqual([{ name: 'good', agentId: 'writer' }]);
    });

    it('accepts agentId in addition to agent_id', () => {
      const md = [
        '---',
        'id: alt',
        'name: Alt',
        'description: camelCase form',
        'sub_agents:',
        '  - name: w',
        '    agentId: writer',
        '---',
        '',
        'body',
      ].join('\n');
      const def = parseAgentFile(md, '/tmp/alt.md');
      expect(def!.subAgents).toEqual([{ name: 'w', agentId: 'writer' }]);
    });

    it('coerces non-string values to strings', () => {
      const md = [
        '---',
        'id: coerce',
        'name: Coerce',
        'description: numbers and bools become strings',
        'sub_agents:',
        '  - name: t',
        '    agent_id: writer',
        '    values:',
        '      n: 42',
        '      flag: true',
        '---',
        '',
        'body',
      ].join('\n');
      const def = parseAgentFile(md, '/tmp/coerce.md');
      expect(def!.subAgents).toEqual([
        { name: 't', agentId: 'writer', values: { n: '42', flag: 'true' } },
      ]);
    });
  });

  describe('renderSubAgentPrompt', () => {
    it('returns the prompt unchanged when no values are bound', () => {
      expect(renderSubAgentPrompt('plain prompt', undefined)).toBe('plain prompt');
      expect(renderSubAgentPrompt('plain prompt', {})).toBe('plain prompt');
    });

    it('substitutes {{key}} placeholders and prepends a context block', () => {
      const result = renderSubAgentPrompt('Research {{topic}} at depth {{depth}}.', { topic: 'AI safety', depth: 'shallow' });
      expect(result).toContain('Research AI safety at depth shallow.');
      expect(result).toContain('Context (pre-bound by parent):');
      expect(result).toContain('- topic: AI safety');
      expect(result).toContain('- depth: shallow');
    });

    it('leaves placeholders untouched when the key is not bound', () => {
      const result = renderSubAgentPrompt('Look at {{topic}} and {{missing}}.', { topic: 'x' });
      expect(result).toContain('Look at x and {{missing}}.');
    });
  });

  describe('createSubAgentToolsFromDefinition', () => {
    const parent: AgentDefinition = {
      id: 'parent',
      name: 'Parent',
      description: 'has children',
      systemPrompt: 'orchestrate',
      enabled: true,
      filePath: '<test>',
      subAgents: [
        { name: 'research', agentId: 'researcher', values: { topic: 'X' }, description: 'Investigates' },
        { name: 'write', agentId: 'writer' },
      ],
    };

    it('returns one tool per declared sub-agent with subagent_ prefix', () => {
      const tools = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: [],
      });
      expect(tools.map((t) => t.name)).toEqual(['subagent_research', 'subagent_write']);
      expect(tools[0].description).toContain('Investigates');
      expect(tools[0].description).toContain('agent_id: researcher');
      expect(tools[0].description).toContain('Pre-bound values: topic');
    });

    it('returns an empty list when the definition has no subAgents', () => {
      const def: AgentDefinition = { ...parent, subAgents: undefined };
      const tools = createSubAgentToolsFromDefinition(def, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: [],
      });
      expect(tools).toEqual([]);
    });

    it('calling a tool dispatches via the runner with bound agentId and rendered prompt', async () => {
      const runnerSpy = jest.fn(async (config: SubagentConfig, prompt: string) => {
        expect(config.agentId).toBe('researcher');
        expect(config.parentChain).toEqual(['parent', 'researcher']);
        expect(prompt).toContain('Context (pre-bound by parent):');
        expect(prompt).toContain('- topic: X');
        expect(prompt).toContain('Look up X.');
        return 'research summary';
      });
      const tools = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: ['parent'],
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'Look up {{topic}}.' });
      expect(result.success).toBe(true);
      expect(result.output).toBe('research summary');
      expect(runnerSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects empty prompt with a structured error', async () => {
      const tools = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: [],
      });
      const result = await tools[0].execute({ prompt: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('prompt is required');
    });

    it('detects a direct cycle (parent depends on itself)', async () => {
      const selfRef: AgentDefinition = {
        ...parent,
        id: 'loop',
        subAgents: [{ name: 'recurse', agentId: 'loop' }],
      };
      const runnerSpy = jest.fn();
      const tools = createSubAgentToolsFromDefinition(selfRef, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: ['loop'],
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'go' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cycle detected/);
      expect(result.error).toContain('loop -> loop');
      expect(runnerSpy).not.toHaveBeenCalled();
    });

    it('detects an indirect cycle (A -> B -> A)', async () => {
      const a: AgentDefinition = {
        ...parent,
        id: 'a',
        subAgents: [{ name: 'go_b', agentId: 'b' }],
      };
      const runnerSpy = jest.fn();
      const tools = createSubAgentToolsFromDefinition(a, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: ['a', 'b'],
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'go' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cycle detected/);
      expect(runnerSpy).not.toHaveBeenCalled();
    });

    it('enforces the depth limit', async () => {
      const def: AgentDefinition = {
        ...parent,
        id: 'deep',
        subAgents: [{ name: 'go', agentId: 'next' }],
      };
      const runnerSpy = jest.fn();
      const tools = createSubAgentToolsFromDefinition(def, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: ['a', 'b', 'c'],
        maxDepth: 3,
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'go' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/depth limit exceeded/);
      expect(result.error).toContain('4 > 3');
      expect(runnerSpy).not.toHaveBeenCalled();
    });

    it('default depth limit matches DEFAULT_SUBAGENT_MAX_DEPTH', () => {
      expect(DEFAULT_SUBAGENT_MAX_DEPTH).toBe(5);
    });

    it('surfaces runner errors as structured tool failures', async () => {
      const runnerSpy = jest.fn(async () => { throw new Error('boom'); });
      const tools = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        parentChain: [],
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'go' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      expect(result.output).toContain('Sub-agent "research" failed: boom');
    });

    it('propagates parentChain through getCustomAgents and the runner', async () => {
      const customAgents: AgentDefinition[] = [
        { id: 'researcher', name: 'R', description: '', systemPrompt: 'r', enabled: true, filePath: '<test>' },
      ];
      const runnerSpy = jest.fn(async (config: SubagentConfig) => {
        expect(config.customAgents).toEqual(customAgents);
        expect(config.parentChain).toEqual(['parent', 'researcher']);
        expect(config.maxDepth).toBe(DEFAULT_SUBAGENT_MAX_DEPTH);
        return 'ok';
      });
      const tools = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [],
        getCustomAgents: () => customAgents,
        parentChain: ['parent'],
        runner: runnerSpy as unknown as typeof runSubagent,
      });
      const result = await tools[0].execute({ prompt: 'go' });
      expect(result.success).toBe(true);
      expect(runnerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tool shape', () => {
    it('produced tool has the expected schema fields', () => {
      const parent: AgentDefinition = {
        id: 'p',
        name: 'P',
        description: '',
        systemPrompt: '',
        enabled: true,
        filePath: '<test>',
        subAgents: [{ name: 'x', agentId: 'writer' }],
      };
      const [tool] = createSubAgentToolsFromDefinition(parent, {
        getParentClient: makeStubClient,
        getAvailableTools: () => [] as Tool[],
        parentChain: [],
      });
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required).toEqual(['prompt']);
      expect(tool.isReadOnly).toBe(false);
    });
  });

  describe('runSubagent wiring', () => {
    // Verifies that when runSubagent is invoked with an agentId whose
    // definition declares subAgents, the inner queryLoop receives those
    // tools alongside the normal subagent tool filter. We intercept
    // queryLoop via jest.mock so no real model traffic happens.
    let capturedTools: Tool[] | undefined;

    beforeEach(() => {
      capturedTools = undefined;
      jest.resetModules();
      jest.doMock('../core/queryLoop', () => ({
        queryLoop: async function* (_loopConfig: unknown, deps: { tools: Tool[] }) {
          capturedTools = deps.tools;
          yield { type: 'text', content: 'done' };
        },
      }));
    });

    afterEach(() => {
      jest.dontMock('../core/queryLoop');
    });

    it('appends declared subagent tools to the inner tool set', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runSubagent: scopedRunSubagent } = require('./subagent');
      const customAgents: AgentDefinition[] = [
        {
          id: 'composer',
          name: 'Composer',
          description: 'orchestrates',
          systemPrompt: 'orchestrate',
          enabled: true,
          filePath: '<test>',
          subAgents: [
            { name: 'research', agentId: 'researcher' },
            { name: 'write', agentId: 'writer' },
          ],
        },
      ];
      const config: SubagentConfig = {
        name: 'composer',
        systemPrompt: '',
        agentId: 'composer',
        customAgents,
      };
      const parentClient = makeStubClient();
      await scopedRunSubagent(config, 'go', parentClient, [] as Tool[]);
      const toolNames = (capturedTools ?? []).map((t) => t.name);
      expect(toolNames).toContain('subagent_research');
      expect(toolNames).toContain('subagent_write');
    });

    it('does not add subagent tools when the definition declares none', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runSubagent: scopedRunSubagent } = require('./subagent');
      const config: SubagentConfig = {
        name: 'researcher',
        systemPrompt: '',
        agentId: 'researcher', // built-in; has no subAgents
      };
      await scopedRunSubagent(config, 'go', makeStubClient(), [] as Tool[]);
      const toolNames = (capturedTools ?? []).map((t) => t.name);
      expect(toolNames.filter((n) => n.startsWith('subagent_'))).toEqual([]);
    });
  });
});
