import { BUILTIN_AGENT_ROLES, type AgentDefinition } from './agentLoader';
import {
  AGENT_ID_PATTERN,
  assertValidAgentId,
  isValidAgentId,
  requireAgentDefinition,
  UnknownAgentError,
} from './agentId';

function makeAgent(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    description: '',
    systemPrompt: 'sp',
    enabled: true,
    filePath: '<test>',
    ...overrides,
  };
}

describe('agentId contract', () => {
  describe('AGENT_ID_PATTERN / isValidAgentId', () => {
    it.each([
      'researcher', 'qa', 'a', 'a1', 'a-b', 'a_b', 'A', 'agent-001', 'Mixed_Case-1', '1', '2006',
    ])('accepts %s', (id) => {
      expect(isValidAgentId(id)).toBe(true);
      expect(AGENT_ID_PATTERN.test(id)).toBe(true);
    });

    it.each([
      '', '-foo', '_foo', 'foo bar', 'foo.bar', 'foo/bar', 'foo:bar', 'a!', 'a#b',
    ])('rejects %s', (id) => {
      expect(isValidAgentId(id)).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidAgentId(undefined)).toBe(false);
      expect(isValidAgentId(null)).toBe(false);
      expect(isValidAgentId(42)).toBe(false);
      expect(isValidAgentId({})).toBe(false);
    });
  });

  describe('assertValidAgentId', () => {
    it('returns silently for a valid id', () => {
      expect(() => assertValidAgentId('researcher')).not.toThrow();
    });

    it('throws with a helpful message for an invalid id', () => {
      expect(() => assertValidAgentId('bad id')).toThrow(/alphanumeric.*Got: "bad id"/);
    });

    it('includes the context string when supplied', () => {
      expect(() => assertValidAgentId('bad id', 'subAgents[0].agent_id')).toThrow(
        /subAgents\[0\]\.agent_id/,
      );
    });

    it('throws when given non-string input', () => {
      expect(() => assertValidAgentId(undefined)).toThrow(/Got: <undefined>/);
      expect(() => assertValidAgentId(42)).toThrow(/Got: <number>/);
    });
  });

  describe('UnknownAgentError', () => {
    it('carries the agentId and the sorted available ids', () => {
      const err = new UnknownAgentError('typo', ['developer', 'qa', 'researcher']);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('UnknownAgentError');
      expect(err.agentId).toBe('typo');
      expect(err.available).toEqual(['developer', 'qa', 'researcher']);
      expect(err.message).toContain('typo');
      expect(err.message).toContain('developer, qa, researcher');
    });

    it('renders "(none)" when no agents are available', () => {
      const err = new UnknownAgentError('x', []);
      expect(err.message).toContain('(none)');
    });
  });

  describe('requireAgentDefinition', () => {
    it('returns a built-in role by id', () => {
      const def = requireAgentDefinition('researcher', []);
      expect(def.id).toBe('researcher');
    });

    it('returns a custom agent (and shadows the built-in when ids match)', () => {
      const custom = makeAgent('researcher', { systemPrompt: 'custom override' });
      const def = requireAgentDefinition('researcher', [custom]);
      expect(def.systemPrompt).toBe('custom override');
    });

    it('throws UnknownAgentError when the id resolves to nothing', () => {
      let caught: unknown;
      try {
        requireAgentDefinition('not-a-real-agent', []);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnknownAgentError);
      const err = caught as UnknownAgentError;
      expect(err.agentId).toBe('not-a-real-agent');
      // Built-ins should always be in the available list.
      for (const builtin of BUILTIN_AGENT_ROLES) {
        expect(err.available).toContain(builtin.id);
      }
      // And the list should be sorted with no duplicates.
      expect([...err.available].sort()).toEqual(err.available);
      expect(new Set(err.available).size).toBe(err.available.length);
    });

    it('treats disabled custom agents as missing', () => {
      const disabled = makeAgent('only-disabled', { enabled: false });
      expect(() => requireAgentDefinition('only-disabled', [disabled])).toThrow(UnknownAgentError);
    });

    it('lists enabled custom agents alongside built-ins when raising', () => {
      const enabled = makeAgent('teammate-1');
      const disabled = makeAgent('teammate-2', { enabled: false });
      let caught: UnknownAgentError | undefined;
      try {
        requireAgentDefinition('typo', [enabled, disabled]);
      } catch (err) {
        caught = err as UnknownAgentError;
      }
      expect(caught).toBeDefined();
      expect(caught!.available).toContain('teammate-1');
      expect(caught!.available).not.toContain('teammate-2');
    });
  });
});
