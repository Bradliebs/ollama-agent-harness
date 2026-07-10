import { makeGoal, type Goal, type GoalConstraint } from './types';
import {
  extractBudget,
  extractForbiddenPaths,
  extractForbiddenTools,
  filterTools,
  describeConstraints,
  goalToTaskContractFragment,
} from './loopConfig';

function constraint(id: string, spec: GoalConstraint['spec'], description = id): GoalConstraint {
  return { id, description, spec };
}

function goalWith(constraints: GoalConstraint[], target = 'do the thing'): Goal {
  return { ...makeGoal({ target, constraints }, 'g-1', new Date(1000)) };
}

describe('extractBudget', () => {
  it('returns an empty view when no budget constraints exist', () => {
    expect(extractBudget(goalWith([]))).toEqual({});
  });

  it('pulls maxIterations / maxDurationMs / cost caps from constraints', () => {
    const g = goalWith([
      constraint('b', { kind: 'budget', maxIterations: 7 }),
      constraint('t', { kind: 'time', maxDurationMs: 10_000 }),
      constraint('c', { kind: 'cost', maxTokens: 1234, maxUsd: 5 }),
    ]);
    expect(extractBudget(g)).toEqual({
      maxIterations: 7,
      maxDurationMs: 10_000,
      maxTokens: 1234,
      maxUsd: 5,
    });
  });
});

describe('extractForbiddenPaths', () => {
  it('deduplicates globs across multiple path_forbid constraints', () => {
    const g = goalWith([
      constraint('p1', { kind: 'path_forbid', globs: ['src/**', 'docs/**'] }),
      constraint('p2', { kind: 'path_forbid', globs: ['docs/**', 'test/**'] }),
    ]);
    expect(extractForbiddenPaths(g).sort()).toEqual(['docs/**', 'src/**', 'test/**']);
  });

  it('returns [] when no path_forbid constraints exist', () => {
    expect(extractForbiddenPaths(goalWith([]))).toEqual([]);
  });
});

describe('extractForbiddenTools', () => {
  it('returns a Set of tool names', () => {
    const g = goalWith([
      constraint('t1', { kind: 'tool_forbid', tools: ['shell', 'file_write'] }),
      constraint('t2', { kind: 'tool_forbid', tools: ['shell', 'fetch'] }),
    ]);
    expect([...extractForbiddenTools(g)].sort()).toEqual(['fetch', 'file_write', 'shell']);
  });
});

describe('filterTools', () => {
  const tools = [
    { name: 'shell' },
    { name: 'file_read' },
    { name: 'file_write' },
    { name: 'fetch' },
  ];

  it('returns the same array reference when no forbids exist', () => {
    const out = filterTools(tools, goalWith([]));
    expect(out).toBe(tools);
  });

  it('preserves order and removes forbidden tools', () => {
    const g = goalWith([constraint('t', { kind: 'tool_forbid', tools: ['shell', 'fetch'] })]);
    expect(filterTools(tools, g)).toEqual([{ name: 'file_read' }, { name: 'file_write' }]);
  });
});

describe('describeConstraints', () => {
  it('emits a human-readable line per constraint kind', () => {
    const g = goalWith([
      constraint('p', { kind: 'path_forbid', globs: ['src/secrets/**'] }),
      constraint('t', { kind: 'tool_forbid', tools: ['shell'] }),
      constraint('b', { kind: 'budget', maxIterations: 5 }),
      constraint('tm', { kind: 'time', maxDurationMs: 60_000 }),
      constraint('c', { kind: 'cost', maxUsd: 2 }),
      constraint('x', { kind: 'custom', description: 'do not call yahoo' }),
    ]);
    const lines = describeConstraints(g);
    expect(lines).toEqual([
      'Do not modify: src/secrets/**',
      'Do not call tools: shell',
      'Iteration budget: 5',
      'Time budget: 60s',
      'Cost cap: $2.00',
      'do not call yahoo',
    ]);
  });
});

describe('goalToTaskContractFragment', () => {
  it('maps goal target / constraints / verifications into contract fields', () => {
    const g = goalWith([
      constraint('p', { kind: 'path_forbid', globs: ['src/secrets/**'] }),
      constraint('b', { kind: 'budget', maxIterations: 12 }),
    ]);
    g.verification = [
      { id: 'v1', description: 'tests pass', required: true,  spec: { kind: 'command', command: 'npm', args: ['test'] } },
      { id: 'v2', description: 'docs exist',  required: false, spec: { kind: 'file_exists', path: 'README.md' } },
    ];
    const f = goalToTaskContractFragment(g);
    expect(f.goal).toBe('do the thing');
    expect(f.blocked_paths).toEqual(['src/secrets/**']);
    expect(f.constraints).toContain('Do not modify: src/secrets/**');
    expect(f.validation).toEqual(['tests pass', 'docs exist']);
    expect(f.success_criteria).toEqual(['tests pass']); // only required
    expect(f.max_turns).toBe(12);
  });

  it('omits max_turns when no budget constraint is set', () => {
    const f = goalToTaskContractFragment(goalWith([]));
    expect(f.max_turns).toBeUndefined();
  });
});
