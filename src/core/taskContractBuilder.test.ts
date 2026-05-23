import { buildTaskContract, extractConstraints, extractGoal } from './taskContractBuilder';
import { renderTaskContractBlock } from '../types/taskContract';

// ─── Goal extraction ─────────────────────────────────────────────────

describe('extractGoal', () => {
  it('strips "Can you" filler', () => {
    expect(extractGoal('Can you fix the dashboard risk calculation')).toBe('fix the dashboard risk calculation');
  });

  it('strips "I need you to" filler', () => {
    expect(extractGoal("I need you to refactor the auth module")).toBe('refactor the auth module');
  });

  it('stops at constraint pivot ("and make sure")', () => {
    const goal = extractGoal("Can you fix the dashboard risk thing and make sure it doesn't mess with the hedge positions?");
    expect(goal).toContain('fix the dashboard risk thing');
    expect(goal).not.toContain('hedge');
  });

  it('stops at sentence boundary', () => {
    const goal = extractGoal('Fix the login bug. Also check the logout flow.');
    expect(goal).toBe('Fix the login bug');
  });

  it('returns original message when no filler found', () => {
    expect(extractGoal('Update README')).toBe('Update README');
  });
});

// ─── Constraint extraction ───────────────────────────────────────────

describe('extractConstraints', () => {
  it('extracts "make sure it doesn\'t" constraints', () => {
    const constraints = extractConstraints("Fix the risk and make sure it doesn't mess with the hedge positions");
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatch(/hedge positions/i);
    expect(constraints[0]).toMatch(/^Do not/i);
  });

  it('extracts "without touching" constraint', () => {
    const constraints = extractConstraints("Refactor risk.ts without touching the portfolio module");
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatch(/portfolio module/i);
  });

  it('extracts "don\'t modify" constraint', () => {
    const constraints = extractConstraints("Update the config but don't modify the production settings");
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatch(/production settings/i);
  });

  it('extracts "preserve" constraint', () => {
    const constraints = extractConstraints("Refactor the logger, preserve the existing API surface");
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatch(/API surface/i);
  });

  it('extracts "keep X unchanged" constraint', () => {
    const constraints = extractConstraints("Fix the bug and keep the test suite intact");
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatch(/test suite/i);
  });

  it('returns empty array when no constraints in message', () => {
    const constraints = extractConstraints('Fix the dashboard risk calculation');
    expect(constraints).toHaveLength(0);
  });

  it('extracts multiple constraints from one message', () => {
    const constraints = extractConstraints(
      "Refactor the auth module without touching the user model and don't change the API contract"
    );
    expect(constraints.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates identical constraints', () => {
    const constraints = extractConstraints(
      "Don't modify the config. Do not modify the config."
    );
    // Should deduplicate (case-insensitive)
    const lower = constraints.map((c) => c.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});

// ─── buildTaskContract ───────────────────────────────────────────────

describe('buildTaskContract', () => {
  it('classifies a coding task as code_edit mode', () => {
    const contract = buildTaskContract('Implement a new login endpoint in src/auth.ts');
    expect(contract.mode).toBe('code_edit');
  });

  it('classifies a research task as research mode', () => {
    const contract = buildTaskContract('Research the best way to implement rate limiting');
    expect(contract.mode).toBe('research');
  });

  it('sets approval_required for high-risk tasks', () => {
    const contract = buildTaskContract('Deploy to production and delete the staging database');
    expect(contract.high_risk).toBe(true);
    expect(contract.approval_required).toBe(true);
  });

  it('includes default blocked paths', () => {
    const contract = buildTaskContract('Update the dashboard');
    expect(contract.blocked_paths).toContain('.env');
    expect(contract.blocked_paths).toContain('secrets/');
    expect(contract.blocked_paths).toContain('node_modules/');
  });

  it('merges extra_blocked_paths with defaults', () => {
    const contract = buildTaskContract('Update the dashboard', {
      extra_blocked_paths: ['config/prod.json'],
    });
    expect(contract.blocked_paths).toContain('.env');
    expect(contract.blocked_paths).toContain('config/prod.json');
  });

  it('uses caller-supplied validation when provided', () => {
    const contract = buildTaskContract('Fix the bug', {
      validation: ['npm run build', 'npm run test:e2e'],
    });
    expect(contract.validation).toEqual(['npm run build', 'npm run test:e2e']);
  });

  it('infers typecheck + test for code_edit mode', () => {
    const contract = buildTaskContract('Implement the new risk calculation');
    expect(contract.validation).toContain('npm run typecheck');
    expect(contract.validation).toContain('npm test');
  });

  it('has no validation for research mode', () => {
    const contract = buildTaskContract('Research how event sourcing works');
    expect(contract.validation).toHaveLength(0);
  });

  it('respects max_turns override', () => {
    const contract = buildTaskContract('Fix the bug', { max_turns: 5 });
    expect(contract.max_turns).toBe(5);
  });

  it('extracts constraints and puts them in the contract', () => {
    const contract = buildTaskContract(
      "Fix the dashboard risk thing and make sure it doesn't mess with the hedge positions"
    );
    expect(contract.constraints).toHaveLength(1);
    expect(contract.constraints[0]).toMatch(/hedge/i);
    expect(contract.goal).toContain('dashboard risk');
    expect(contract.goal).not.toContain('hedge');
  });

  it('sets source to "derived"', () => {
    expect(buildTaskContract('Update README').source).toBe('derived');
  });

  it('has a task_id', () => {
    const contract = buildTaskContract('Update README');
    expect(typeof contract.task_id).toBe('string');
    expect(contract.task_id.length).toBeGreaterThan(0);
  });

  it('includes success_criteria', () => {
    const contract = buildTaskContract('Implement login');
    expect(contract.success_criteria.length).toBeGreaterThan(0);
    expect(contract.success_criteria.some((s) => s.includes('Goal is achieved'))).toBe(true);
  });

  it('includes failure_triggers for code tasks', () => {
    const contract = buildTaskContract('Fix the bug in src/risk.ts');
    expect(contract.failure_triggers).toContain('Validation command fails');
  });
});

// ─── renderTaskContractBlock ─────────────────────────────────────────

describe('renderTaskContractBlock', () => {
  it('renders goal and mode', () => {
    const contract = buildTaskContract('Fix the risk calculation in src/risk.ts');
    const block = renderTaskContractBlock(contract);
    expect(block).toContain('## Task Contract');
    expect(block).toContain('**Goal:**');
    expect(block).toContain('**Mode:**');
  });

  it('renders constraints when present', () => {
    const contract = buildTaskContract(
      "Fix the dashboard and make sure it doesn't touch the hedge positions"
    );
    const block = renderTaskContractBlock(contract);
    expect(block).toContain('**Constraints:**');
    expect(block).toContain('hedge');
  });

  it('renders blocked paths', () => {
    const contract = buildTaskContract('Update the config');
    const block = renderTaskContractBlock(contract);
    expect(block).toContain('**Blocked paths:**');
    expect(block).toContain('.env');
  });

  it('renders validation commands when present', () => {
    const contract = buildTaskContract('Implement login endpoint');
    const block = renderTaskContractBlock(contract);
    expect(block).toContain('**Validation:**');
    expect(block).toContain('npm run typecheck');
  });

  it('flags high-risk contract in mode line', () => {
    const contract = buildTaskContract('delete production data drop table users');
    const block = renderTaskContractBlock(contract);
    expect(block).toContain('HIGH RISK');
  });

  it('shows approval_required status', () => {
    const normal  = renderTaskContractBlock(buildTaskContract('Refactor src/utils.ts'));
    const risky   = renderTaskContractBlock(buildTaskContract('delete production data drop table'));
    expect(normal).toContain('Approval required:** No');
    expect(risky).toContain('Approval required:** Yes');
  });
});
