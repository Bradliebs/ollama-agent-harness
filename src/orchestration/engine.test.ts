// Orchestration Engine — integration tests.
//
// These tests verify the full orchestration pipeline: company creation,
// goal decomposition, task dispatch, org chart routing, and escalation.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Types only — we'll import the actual modules dynamically after setting up
// the project directory.
import type { Company, Goal, Issue, OrgChart } from '../orchestration';

// ─── Test Helpers ───────────────────────────────────────────────────

async function createTestDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-test-'));
  await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
  return dir;
}

async function cleanupTestDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Company Tests ──────────────────────────────────────────────────

describe('Company store', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTestDir();
  });

  afterAll(async () => {
    await cleanupTestDir(projectDir);
  });

  it('creates a company', async () => {
    const { createCompany } = await import('../orchestration/company');
    const company = await createCompany(projectDir, {
      name: 'Test Corp',
      description: 'A test company',
      mission: 'Test all the things',
    });

    expect(company.id).toBeTruthy();
    expect(company.name).toBe('Test Corp');
    expect(company.status).toBe('active');
    expect(company.mission).toBe('Test all the things');
  });

  it('lists companies', async () => {
    const { listCompanies } = await import('../orchestration/company');
    const companies = await listCompanies(projectDir);
    expect(companies.length).toBeGreaterThanOrEqual(1);
    expect(companies.some((c) => c.name === 'Test Corp')).toBe(true);
  });

  it('gets a company by id', async () => {
    const { createCompany, getCompany } = await import('../orchestration/company');
    const created = await createCompany(projectDir, { name: 'Fetch Corp' });
    const fetched = await getCompany(projectDir, created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Fetch Corp');
  });

  it('updates a company', async () => {
    const { createCompany, updateCompany } = await import('../orchestration/company');
    const created = await createCompany(projectDir, { name: 'Update Corp' });
    const updated = await updateCompany(projectDir, created.id, {
      name: 'Updated Corp',
      status: 'paused',
    });
    expect(updated.name).toBe('Updated Corp');
    expect(updated.status).toBe('paused');
  });

  it('requires a company name', async () => {
    const { createCompany } = await import('../orchestration/company');
    await expect(createCompany(projectDir, { name: '' })).rejects.toThrow('required');
  });
});

// ─── Goal Tests ─────────────────────────────────────────────────────

describe('Goal store', () => {
  let projectDir: string;
  let companyId: string;

  beforeAll(async () => {
    projectDir = await createTestDir();
    const { createCompany } = await import('../orchestration/company');
    const company = await createCompany(projectDir, { name: 'Goal Test Corp' });
    companyId = company.id;
  });

  afterAll(async () => {
    await cleanupTestDir(projectDir);
  });

  it('creates a goal', async () => {
    const { createGoal } = await import('../orchestration/goal');
    const goal = await createGoal(projectDir, {
      companyId,
      title: 'Ship v2.0',
      description: 'Release version 2.0 of the product',
      successCriteria: 'All features shipped and tested',
    });

    expect(goal.id).toBeTruthy();
    expect(goal.title).toBe('Ship v2.0');
    expect(goal.status).toBe('active');
    expect(goal.progressPercent).toBe(0);
  });

  it('lists goals by company', async () => {
    const { listGoals } = await import('../orchestration/goal');
    const goals = await listGoals(projectDir, { companyId });
    expect(goals.length).toBeGreaterThanOrEqual(1);
  });

  it('creates an issue under a goal', async () => {
    const { createGoal, createIssue } = await import('../orchestration/goal');
    const goal = await createGoal(projectDir, {
      companyId,
      title: 'Issue Parent Goal',
    });
    const issue = await createIssue(projectDir, {
      goalId: goal.id,
      companyId,
      title: 'Backend API',
      priority: 'high',
    });

    expect(issue.goalId).toBe(goal.id);
    expect(issue.priority).toBe('high');
    expect(issue.status).toBe('open');
  });

  it('updates goal status', async () => {
    const { createGoal, updateGoal } = await import('../orchestration/goal');
    const goal = await createGoal(projectDir, {
      companyId,
      title: 'Updatable Goal',
    });
    const updated = await updateGoal(projectDir, goal.id, { status: 'paused' });
    expect(updated.status).toBe('paused');
  });
});

// ─── Org Chart Tests ────────────────────────────────────────────────

describe('Org chart store', () => {
  let projectDir: string;
  let companyId: string;

  beforeAll(async () => {
    projectDir = await createTestDir();
    const { createCompany } = await import('../orchestration/company');
    const company = await createCompany(projectDir, { name: 'Org Test Corp' });
    companyId = company.id;
  });

  afterAll(async () => {
    await cleanupTestDir(projectDir);
  });

  it('creates an org chart', async () => {
    const { createOrgChart } = await import('../orchestration/orgChart');
    const chart = await createOrgChart(projectDir, {
      companyId,
      name: 'Engineering Team',
      rootAgentId: 'ceo-agent',
      nodes: [
        { agentId: 'ceo-agent', role: 'ceo', reportIds: ['cto-agent'] },
        { agentId: 'cto-agent', role: 'cto', managerId: 'ceo-agent', reportIds: ['eng-1', 'eng-2'] },
        { agentId: 'eng-1', role: 'engineer', managerId: 'cto-agent', reportIds: [] },
        { agentId: 'eng-2', role: 'engineer', managerId: 'cto-agent', reportIds: [] },
      ],
    });

    expect(chart.id).toBeTruthy();
    expect(chart.name).toBe('Engineering Team');
    expect(chart.nodes.length).toBe(4);
    expect(chart.maxDepth).toBeGreaterThanOrEqual(2);
  });

  it('lists org charts by company', async () => {
    const { listOrgCharts } = await import('../orchestration/orgChart');
    const charts = await listOrgCharts(projectDir, { companyId });
    expect(charts.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Engine Integration Tests ───────────────────────────────────────

describe('OrchestrationEngine', () => {
  let projectDir: string;
  let engine: import('../orchestration/engine').OrchestrationEngine;

  beforeEach(async () => {
    projectDir = await createTestDir();
    const { OrchestrationEngine } = await import('../orchestration/engine');
    engine = new OrchestrationEngine({ projectDir });
  });

  afterEach(async () => {
    await cleanupTestDir(projectDir);
  });

  it('creates a company through the engine', async () => {
    const company = await engine.createCompany({
      name: 'Engine Test Corp',
      mission: 'Test the engine',
    });
    expect(company.id).toBeTruthy();
    expect(company.name).toBe('Engine Test Corp');
  });

  it('creates a goal through the engine', async () => {
    const company = await engine.createCompany({ name: 'Goal Engine Corp' });
    const goal = await engine.createGoal({
      companyId: company.id,
      title: 'Build feature X',
    });
    expect(goal.id).toBeTruthy();
    expect(goal.title).toBe('Build feature X');
  });

  it('decomposes a goal into issues and tasks', async () => {
    const company = await engine.createCompany({ name: 'Decomp Corp' });
    const goal = await engine.createGoal({
      companyId: company.id,
      title: 'Ship product',
    });

    const result = await engine.decomposeGoal(goal.id, {
      issues: [
        {
          title: 'Backend',
          priority: 'high',
          tasks: [
            { title: 'Design API' },
            { title: 'Implement endpoints' },
          ],
        },
        {
          title: 'Frontend',
          priority: 'medium',
          tasks: [
            { title: 'Build UI' },
            { title: 'Write tests' },
          ],
        },
      ],
    });

    expect(result.issues.length).toBe(2);
    expect(result.tasks.length).toBe(4);
    expect(result.warnings.length).toBe(0);

    // Check that the second issue's tasks depend on the first issue's tasks.
    const backendTaskIds = result.tasks
      .filter((t) => t.title === 'Design API' || t.title === 'Implement endpoints')
      .map((t) => t.id);
    const frontendTasks = result.tasks.filter(
      (t) => t.title === 'Build UI' || t.title === 'Write tests',
    );
    for (const ft of frontendTasks) {
      // Frontend tasks should depend on backend tasks.
      expect(ft.dependsOn.length).toBeGreaterThan(0);
    }
  });

  it('creates an org chart through the engine', async () => {
    const company = await engine.createCompany({ name: 'Org Engine Corp' });
    const chart = await engine.createOrgChart({
      companyId: company.id,
      name: 'Team Alpha',
      rootAgentId: 'lead-agent',
      nodes: [
        { agentId: 'lead-agent', role: 'ceo', reportIds: ['worker-1'] },
        { agentId: 'worker-1', role: 'engineer', managerId: 'lead-agent', reportIds: [] },
      ],
    });
    expect(chart.nodes.length).toBe(2);
  });

  it('detects stale tasks via escalation', async () => {
    const { createTask } = await import('../services/taskStore');
    // Create a task that's already in progress with a stale check-in.
    const task = await createTask(projectDir, {
      title: 'Stale task',
      assigneeId: 'agent-1',
    });

    // Record a check-in from the distant past by writing the timestamp directly.
    const { recordCheckIn } = await import('../services/taskStore');
    await recordCheckIn(
      projectDir,
      task.id,
      {
        message: 'Starting work',
        status: 'in_progress',
      },
      new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    );

    const { detectStaleTasks } = await import('../services/taskStore');
    const stale = await detectStaleTasks(projectDir, new Date(), 30 * 60 * 1000);
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale.some((t) => t.taskId === task.id)).toBe(true);
  });

  it('runs goal decomposition with no-deps marker', async () => {
    const company = await engine.createCompany({ name: 'NoDeps Corp' });
    const goal = await engine.createGoal({
      companyId: company.id,
      title: 'Independent tasks',
    });

    const result = await engine.decomposeGoal(goal.id, {
      issues: [
        {
          title: 'Independent work',
          tasks: [
            { title: 'Task A', description: 'No deps needed [no-deps]' },
            { title: 'Task B', description: 'Also independent [no-deps]' },
          ],
        },
      ],
    });

    // Tasks with [no-deps] should have empty dependsOn.
    const noDepsTasks = result.tasks.filter(
      (t) => t.description?.includes('[no-deps]'),
    );
    for (const t of noDepsTasks) {
      expect(t.dependsOn.length).toBe(0);
    }
  });
});

// ─── Heartbeat Action Tests ─────────────────────────────────────────

describe('Orchestration heartbeat actions', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTestDir();
  });

  afterAll(async () => {
    await cleanupTestDir(projectDir);
  });

  it('goal progress action runs without error', async () => {
    const { goalProgressAction } = await import('../orchestration/heartbeat');
    const action = goalProgressAction(projectDir);
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
  });

  it('stale task detection action runs without error', async () => {
    const { staleTaskDetectionAction } = await import('../orchestration/heartbeat');
    const action = staleTaskDetectionAction(projectDir, 30);
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
  });

  it('budget enforcement action runs without error', async () => {
    const { budgetEnforcementAction } = await import('../orchestration/heartbeat');
    const action = budgetEnforcementAction(projectDir);
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
  });

  it('company health check action runs without error', async () => {
    const { companyHealthCheckAction } = await import('../orchestration/heartbeat');
    const action = companyHealthCheckAction(projectDir);
    const result = await action.run(projectDir);
    expect(result.ok).toBe(true);
  });
});