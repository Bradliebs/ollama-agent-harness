import * as path from 'path';

const personaBundle = require(path.join(process.cwd(), 'ui', 'personaBundle.js')) as {
  extractPinnedSkillNames: (skills: unknown) => string[];
  extractMcpServerNames: (servers: unknown) => string[];
  computeStagingPlan: (
    bundle: { skills?: string[]; mcp?: string[] },
    current: { pinnedSkills?: string[]; mcpServers?: string[] },
  ) => { skillsToPin: string[]; mcpToStage: string[]; satisfied: boolean };
  summarizeStagingPlan: (plan: {
    skillsToPin: string[];
    mcpToStage: string[];
    satisfied: boolean;
  }) => string;
};

describe('ui persona bundle', () => {
  describe('extractPinnedSkillNames', () => {
    it('returns sorted distinct names of pinned skills only', () => {
      const names = personaBundle.extractPinnedSkillNames([
        { name: 'code-review', pinned: true },
        { name: 'research', pinned: false },
        { name: 'planner', pinned: true },
        { name: 'code-review', pinned: true },
      ]);
      expect(names).toEqual(['code-review', 'planner']);
    });

    it('tolerates non-array and malformed entries', () => {
      expect(personaBundle.extractPinnedSkillNames(undefined)).toEqual([]);
      expect(personaBundle.extractPinnedSkillNames([null, { pinned: true }, { name: '', pinned: true }])).toEqual([]);
    });
  });

  describe('extractMcpServerNames', () => {
    it('prefers id, then catalogName, then name; sorted + distinct', () => {
      const names = personaBundle.extractMcpServerNames([
        { id: 'github' },
        { catalogName: 'filesystem' },
        { name: 'memory' },
        { id: 'github' },
      ]);
      expect(names).toEqual(['filesystem', 'github', 'memory']);
    });

    it('returns an empty array for non-array or empty identifiers', () => {
      expect(personaBundle.extractMcpServerNames(null)).toEqual([]);
      expect(personaBundle.extractMcpServerNames([{}, { id: '' }])).toEqual([]);
    });
  });

  describe('computeStagingPlan', () => {
    it('lists only bundle items missing from the current environment', () => {
      const plan = personaBundle.computeStagingPlan(
        { skills: ['code-review', 'planner'], mcp: ['github', 'filesystem'] },
        { pinnedSkills: ['code-review'], mcpServers: ['filesystem'] },
      );
      expect(plan.skillsToPin).toEqual(['planner']);
      expect(plan.mcpToStage).toEqual(['github']);
      expect(plan.satisfied).toBe(false);
    });

    it('is satisfied when the environment already covers the bundle', () => {
      const plan = personaBundle.computeStagingPlan(
        { skills: ['code-review'], mcp: [] },
        { pinnedSkills: ['code-review', 'extra'], mcpServers: [] },
      );
      expect(plan.skillsToPin).toEqual([]);
      expect(plan.mcpToStage).toEqual([]);
      expect(plan.satisfied).toBe(true);
    });

    it('never proposes removals and handles legacy profiles without skills/mcp', () => {
      const plan = personaBundle.computeStagingPlan({}, { pinnedSkills: ['a'], mcpServers: ['b'] });
      expect(plan.satisfied).toBe(true);
    });
  });

  describe('summarizeStagingPlan', () => {
    it('returns an empty string when satisfied', () => {
      expect(personaBundle.summarizeStagingPlan({ skillsToPin: [], mcpToStage: [], satisfied: true })).toBe('');
    });

    it('describes both skills and MCP servers to stage', () => {
      const text = personaBundle.summarizeStagingPlan({
        skillsToPin: ['planner'],
        mcpToStage: ['github'],
        satisfied: false,
      });
      expect(text).toContain('pin 1 skill(s): planner');
      expect(text).toContain('start 1 MCP server(s): github');
    });
  });
});
