import {
  classifyVerificationTaskKind,
  getVerificationStrategy,
  strategyForRequest,
  assessVerificationAdequacy,
  type VerificationTaskKind,
} from './verificationKernel';
import type { GoalCheck } from './types';

function check(kind: GoalCheck['spec']['kind'], required: boolean): GoalCheck {
  // Minimal valid GoalCheck per kind; spec details don't matter for adequacy.
  const spec = ((): GoalCheck['spec'] => {
    switch (kind) {
      case 'command': return { kind: 'command', command: 'true' };
      case 'file_exists': return { kind: 'file_exists', path: 'x' };
      case 'http': return { kind: 'http', url: 'http://x' };
      case 'model_judge': return { kind: 'model_judge', rubric: 'r' };
      case 'test_suite': return { kind: 'test_suite', command: 'jest' };
    }
  })();
  return { id: `${kind}-${required}`, description: kind, required, spec };
}

describe('classifyVerificationTaskKind', () => {
  it('classifies code tasks', () => {
    expect(classifyVerificationTaskKind('implement a function to parse the config')).toBe('code');
    expect(classifyVerificationTaskKind('refactor the auth module')).toBe('code');
    expect(classifyVerificationTaskKind('fix the bug in the login flow')).toBe('code');
    expect(classifyVerificationTaskKind('add a test for the router')).toBe('code');
  });

  it('classifies edit tasks', () => {
    expect(classifyVerificationTaskKind('rename the variable foo to bar')).toBe('edit');
    expect(classifyVerificationTaskKind('fix typo in the readme')).toBe('edit');
    expect(classifyVerificationTaskKind('reword the error message')).toBe('edit');
  });

  it('classifies data tasks', () => {
    expect(classifyVerificationTaskKind('parse the csv and aggregate the records')).toBe('data');
    expect(classifyVerificationTaskKind('scrape the table into a dataset')).toBe('data');
    expect(classifyVerificationTaskKind('clean the data file')).toBe('data');
  });

  it('classifies factual tasks', () => {
    expect(classifyVerificationTaskKind('what is the capital of France')).toBe('factual');
    expect(classifyVerificationTaskKind('explain how TCP works')).toBe('factual');
    expect(classifyVerificationTaskKind('research the latest pricing')).toBe('factual');
  });

  it('returns unknown for empty or signal-free input', () => {
    expect(classifyVerificationTaskKind('')).toBe('unknown');
    expect(classifyVerificationTaskKind('   ')).toBe('unknown');
    expect(classifyVerificationTaskKind('xyzzy plugh')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyVerificationTaskKind('IMPLEMENT a function')).toBe('code');
  });

  it('breaks ties deterministically by priority (data > code > edit > factual)', () => {
    // Contains both a data signal ("parse") and a code signal ("function") — data wins the tie.
    expect(classifyVerificationTaskKind('parse the function output')).toBe('data');
  });

  it('lets the higher signal count win over tiebreak order', () => {
    // Two code signals ("implement", "refactor") vs one data signal ("parse") — code wins.
    expect(classifyVerificationTaskKind('implement and refactor the parse step')).toBe('code');
  });

  it('handles non-string input safely', () => {
    expect(classifyVerificationTaskKind(undefined as unknown as string)).toBe('unknown');
    expect(classifyVerificationTaskKind(null as unknown as string)).toBe('unknown');
  });
});

describe('getVerificationStrategy', () => {
  it('marks code/edit/data as execution-grounded', () => {
    for (const kind of ['code', 'edit', 'data'] as VerificationTaskKind[]) {
      expect(getVerificationStrategy(kind).executionGrounded).toBe(true);
    }
  });

  it('marks factual and unknown as NOT execution-grounded (honest fallback)', () => {
    expect(getVerificationStrategy('factual').executionGrounded).toBe(false);
    expect(getVerificationStrategy('unknown').executionGrounded).toBe(false);
  });

  it('uses deterministic proof checks for code tasks', () => {
    const strategy = getVerificationStrategy('code');
    expect(strategy.proofChecks).toContain('test_suite');
    expect(strategy.proofChecks).toContain('command');
    expect(strategy.proofChecks).not.toContain('model_judge');
  });

  it('falls back to model_judge only for non-grounded kinds', () => {
    expect(getVerificationStrategy('factual').proofChecks).toEqual(['model_judge']);
    expect(getVerificationStrategy('unknown').proofChecks).toEqual(['model_judge']);
  });

  it('returns a non-empty proof label for every kind', () => {
    for (const kind of ['code', 'edit', 'data', 'factual', 'unknown'] as VerificationTaskKind[]) {
      expect(getVerificationStrategy(kind).proofLabel.length).toBeGreaterThan(0);
    }
  });

  it('reports the task kind it was asked about', () => {
    expect(getVerificationStrategy('edit').taskKind).toBe('edit');
  });
});

describe('strategyForRequest', () => {
  it('classifies and returns the strategy in one call', () => {
    const strategy = strategyForRequest('implement a function');
    expect(strategy.taskKind).toBe('code');
    expect(strategy.executionGrounded).toBe(true);
  });

  it('returns the unknown strategy for unrecognized requests', () => {
    expect(strategyForRequest('xyzzy').taskKind).toBe('unknown');
  });
});

describe('assessVerificationAdequacy', () => {
  it('marks a code task WITHOUT a deterministic proof check as inadequate (looks done, not verified)', () => {
    const result = assessVerificationAdequacy('implement a function', [check('model_judge', true)]);
    expect(result.taskKind).toBe('code');
    expect(result.executionGrounded).toBe(true);
    expect(result.hasDeterministicProof).toBe(false);
    expect(result.adequate).toBe(false);
    expect(result.matchedProofChecks).toEqual([]);
  });

  it('marks a code task WITH a required test_suite check as adequate', () => {
    const result = assessVerificationAdequacy('implement a function', [check('test_suite', true)]);
    expect(result.hasDeterministicProof).toBe(true);
    expect(result.adequate).toBe(true);
    expect(result.matchedProofChecks).toEqual(['test_suite']);
  });

  it('ignores OPTIONAL proof checks — they do not gate completion', () => {
    const result = assessVerificationAdequacy('implement a function', [check('test_suite', false)]);
    expect(result.hasDeterministicProof).toBe(false);
    expect(result.adequate).toBe(false);
  });

  it('accepts a command check as deterministic proof for code tasks', () => {
    const result = assessVerificationAdequacy('refactor the build', [check('command', true)]);
    expect(result.adequate).toBe(true);
    expect(result.matchedProofChecks).toEqual(['command']);
  });

  it('deduplicates matched proof check kinds', () => {
    const result = assessVerificationAdequacy('implement a function', [
      check('command', true),
      check('command', true),
    ]);
    expect(result.matchedProofChecks).toEqual(['command']);
  });

  it('treats factual tasks as adequate-as-possible but NOT execution-grounded', () => {
    const result = assessVerificationAdequacy('what is the capital of France', []);
    expect(result.taskKind).toBe('factual');
    expect(result.executionGrounded).toBe(false);
    expect(result.hasDeterministicProof).toBe(false);
    expect(result.adequate).toBe(true);
  });

  it('treats unknown tasks as adequate-as-possible but NOT execution-grounded', () => {
    const result = assessVerificationAdequacy('xyzzy plugh', []);
    expect(result.taskKind).toBe('unknown');
    expect(result.executionGrounded).toBe(false);
    expect(result.adequate).toBe(true);
  });

  it('does not count a model_judge check as deterministic proof for code tasks', () => {
    const result = assessVerificationAdequacy('debug the algorithm', [check('model_judge', true)]);
    expect(result.hasDeterministicProof).toBe(false);
    expect(result.adequate).toBe(false);
  });

  it('always returns a non-empty reason', () => {
    for (const target of ['implement a function', 'what is x', 'parse the csv', 'xyzzy']) {
      expect(assessVerificationAdequacy(target, []).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('per-kind strategy overrides', () => {
  it('overrides the strategy for a single kind, leaving others on defaults', () => {
    const overrides = {
      factual: {
        taskKind: 'factual' as const,
        executionGrounded: true,
        proofChecks: ['http' as const],
        proofLabel: 'live HTTP check',
      },
    };
    expect(getVerificationStrategy('factual', overrides).executionGrounded).toBe(true);
    expect(getVerificationStrategy('factual', overrides).proofChecks).toEqual(['http']);
    // Untouched kinds still use the built-in defaults.
    expect(getVerificationStrategy('code', overrides).proofChecks).toContain('test_suite');
  });

  it('flows overrides through strategyForRequest', () => {
    const overrides = {
      code: {
        taskKind: 'code' as const,
        executionGrounded: true,
        proofChecks: ['http' as const],
        proofLabel: 'deploy smoke test',
      },
    };
    expect(strategyForRequest('implement a function', overrides).proofChecks).toEqual(['http']);
  });

  it('flows overrides through assessVerificationAdequacy', () => {
    // Default: a factual task can never be execution-grounded. An override that
    // makes factual require an http check turns an http-backed factual goal adequate.
    const overrides = {
      factual: {
        taskKind: 'factual' as const,
        executionGrounded: true,
        proofChecks: ['http' as const],
        proofLabel: 'live HTTP check',
      },
    };
    const target = 'what is the capital of France';
    // Default: factual is not execution-grounded (adequate by default, but unproven).
    expect(assessVerificationAdequacy(target, [check('http', true)]).executionGrounded).toBe(false);
    const overridden = assessVerificationAdequacy(target, [check('http', true)], overrides);
    expect(overridden.executionGrounded).toBe(true);
    expect(overridden.hasDeterministicProof).toBe(true);
    expect(overridden.adequate).toBe(true);
    expect(overridden.matchedProofChecks).toEqual(['http']);
  });
});
