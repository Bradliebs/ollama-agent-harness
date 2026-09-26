import { compileModelRequestPlan, parseConstrainedToolCall } from './adapter';
import type { CapabilityProfile } from './capabilityProfile';
import type { Tool } from '../types/tool';

const tools: Tool[] = [
  { name: 'low', description: 'low', parameters: {}, isReadOnly: true, execute: async () => ({ success: true, output: '' }) },
  { name: 'required', description: 'required', parameters: {}, isReadOnly: true, required: true, execute: async () => ({ success: true, output: '' }) },
  { name: 'high', description: 'high', parameters: {}, isReadOnly: true, execute: async () => ({ success: true, output: '' }) },
];

function profile(toolMode: CapabilityProfile['recommended']['toolMode']): CapabilityProfile {
  return {
    model: 'm',
    profileVersion: 1,
    probedAt: new Date().toISOString(),
    scores: {
      toolCalling: 0,
      jsonInTextRate: 0,
      structuredPlain: 0,
      structuredConstrained: 1,
      instructionFollowing: 1,
      planCoherence: 1,
    },
    usableContextTokens: 1000,
    detectedContextTokens: 2000,
    avgLatencyMs: 1,
    tokensSpent: 1,
    recommended: {
      toolMode,
      maxToolsPerStep: 2,
      promptTier: 'compact',
      scaffoldLevel: 'light',
      contextBudgetTokens: 850,
    },
  };
}

describe('model adapter', () => {
  it('passes through unchanged without a profile', () => {
    const plan = compileModelRequestPlan({ tools, systemPrompt: 'base' });
    expect(plan.tools).toBe(tools);
    expect(plan.systemPrompt).toBe('base');
    expect(plan.format).toBeUndefined();
  });

  it('limits tools by relevance while keeping required tools', () => {
    const plan = compileModelRequestPlan({
      tools,
      systemPrompt: 'base',
      profile: profile('native'),
      relevanceScores: new Map([['high', 10], ['low', 1]]),
    });
    expect(plan.tools.map((tool) => tool.name)).toEqual(['required', 'high']);
  });

  it('adds constrained-json instructions and schema', () => {
    const plan = compileModelRequestPlan({ tools, systemPrompt: 'base', profile: profile('constrained-json') });
    expect(plan.systemPrompt).toContain('Tool-call compatibility mode');
    expect(plan.format).toEqual(expect.objectContaining({ type: 'object' }));
    expect(plan.toolMode).toBe('constrained-json');
  });

  it('parses constrained tool calls', () => {
    expect(parseConstrainedToolCall('{"tool_call":{"name":"add","arguments":{"a":1}}}')).toEqual([
      { function: { name: 'add', arguments: { a: 1 } } },
    ]);
  });
});
