import { BUILTIN_AGENT_ROLES, type AgentDefinition } from '../agents/agentLoader';
import { classifyIntent } from './concierge';

const builtins = BUILTIN_AGENT_ROLES;

describe('classifyIntent', () => {
  it('returns null for empty messages', () => {
    expect(classifyIntent('', builtins).delegateTo).toBeNull();
    expect(classifyIntent('   ', builtins).delegateTo).toBeNull();
  });

  it('answers short messages directly', () => {
    expect(classifyIntent('hi', builtins).delegateTo).toBeNull();
  });

  it('respects forceDirect even for matching messages', () => {
    const result = classifyIntent('please research the new tax rules', builtins, { forceDirect: true });
    expect(result.delegateTo).toBeNull();
    expect(result.reason).toContain('forced');
  });

  it('honours direct markers like "just answer"', () => {
    const result = classifyIntent('just answer this — what does foo do?', builtins);
    expect(result.delegateTo).toBeNull();
    expect(result.matchedKeyword).toBe('just answer');
  });

  it('routes research-style messages to the researcher', () => {
    const result = classifyIntent('please research how OAuth refresh tokens work', builtins);
    expect(result.delegateTo).toBe('researcher');
  });

  it('routes implementation requests to the developer', () => {
    const result = classifyIntent('implement the new sort function in lib/utils.ts', builtins);
    expect(result.delegateTo).toBe('developer');
  });

  it('routes test-flavoured requests to qa', () => {
    const result = classifyIntent('please reproduce the failing test for the cart service', builtins);
    expect(result.delegateTo).toBe('qa');
  });

  it('routes very long inputs to the architect', () => {
    const long = 'X'.repeat(20_000);
    const result = classifyIntent(long, builtins);
    expect(result.delegateTo).toBe('architect');
  });

  it('matches custom agent ids before built-ins of the same id', () => {
    const customs: AgentDefinition[] = [{
      id: 'researcher', name: 'CustomResearcher', description: 'd', enabled: true, filePath: '/tmp/x.md', systemPrompt: 'x',
    }];
    const result = classifyIntent('please research the new tax rules', [...customs, ...builtins]);
    expect(result.delegateTo).toBe('researcher');
  });

  it('matches custom-agent name tokens when no default keywords exist', () => {
    const customs: AgentDefinition[] = [{
      id: 'finance-analyst', name: 'Finance Analyst', description: 'Reviews ledgers and budgets.', enabled: true, filePath: '/tmp/x.md', systemPrompt: 'x',
    }];
    const result = classifyIntent('we need someone to look at the ledger entries', [...customs, ...builtins]);
    expect(result.delegateTo).toBe('finance-analyst');
  });

  it('falls back to direct when no signal matches', () => {
    const result = classifyIntent('hello there friend, how are you doing today?', builtins);
    expect(result.delegateTo).toBeNull();
  });

  it('honours keyword overrides per agent id', () => {
    const result = classifyIntent('this needs blueprint thinking', builtins, {
      keywordOverrides: { architect: ['blueprint'] },
    });
    expect(result.delegateTo).toBe('architect');
  });
});
