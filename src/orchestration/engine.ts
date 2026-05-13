// Orchestration Engine — the central coordinator that ties companies, goals,
// org charts, adapters, and tasks into a single coherent system.
//
// The engine is the main entry point for the orchestration layer. It provides:
//   1. Goal decomposition — break a high-level goal into issues and tasks
//   2. Task dispatch — assign tasks to agents via the org chart
//   3. Adapter execution — run a task through the appropriate adapter
//   4. Progress tracking — roll up progress from tasks to goals
//   5. Escalation — detect stuck tasks and escalate up the org chart
//   6. Budget enforcement — stop runs that exceed their budget
//
// Usage:
//   const engine = new OrchestrationEngine(projectDir);
//   const company = await engine.createCompany({ name: 'Acme' });
//   const goal = await engine.createGoal(company.id, { title: 'Ship v2' });
//   const result = await engine.runGoal(goal.id);

import type { Adapter, RunContext, RunResult, RunBudget } from './adapter';
import { getAdapter, registerAdapter, type AdapterConfig } from './adapter';
import { OllamaLocalAdapter, ProcessAdapter } from './adapters';
import {
  type Company,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from './company';
import {
  type Goal,
  type Issue,
  type CreateGoalInput,
  type CreateIssueInput,
  type UpdateGoalInput,
  type UpdateIssueInput,
  createGoal,
  createIssue,
  getGoal,
  getIssue,
  listGoals,
  listIssues,
  updateGoal,
  updateIssue,
  computeGoalProgress,
} from './goal';
import {
  type OrgChart,
  type OrgNode,
  type CreateOrgChartInput,
  createOrgChart,
  getOrgChart,
  listOrgCharts,
  updateOrgChart,
} from './orgChart';
import {
  type Task,
  type CreateTaskInput,
  createTask,
  getTask,
  listTasks,
  updateTask,
  recordCheckIn,
  detectStaleTasks,
} from '../services/taskStore';
import { emitEvent } from '../persistence/eventStore';
import { logger } from '../core/logger';

// ─── Types ──────────────────────────────────────────────────────────

export interface OrchestrationEngineDeps {
  /** Returns the Ollama chat client if available. */
  getChatClient?: () => unknown;
  /** Returns the available tools. */
  getTools?: () => unknown[];
  /** Project directory (defaults to process.cwd()). */
  projectDir: string;
}

export type GoalDecompositionLevel = 'goal' | 'issue' | 'task';

export interface DecompositionResult {
  goal: Goal;
  issues: Issue[];
  tasks: Task[];
  /** Warnings generated during decomposition (e.g., cyclic deps). */
  warnings: string[];
}

export interface RunGoalOptions {
  /** Maximum concurrent task executions. Default: 3. */
  concurrency?: number;
  /** Abort signal to cancel the entire goal run. */
  abortSignal?: AbortSignal;
  /** Whether to run in dry-run mode (no actual execution). */
  dryRun?: boolean;
}

export interface RunGoalResult {
  goalId: string;
  companyId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  totalDurationMs: number;
  taskResults: Array<{
    taskId: string;
    success: boolean;
    output?: string;
    error?: string;
    durationMs: number;
  }>;
}

export interface TaskDispatchResult {
  taskId: string;
  agentId: string;
  adapterId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  tokensUsed?: { prompt: number; completion: number; total: number };
  costUsd?: number;
}

export interface EscalationResult {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  reason: string;
  timestamp: string;
}

// ─── Engine ──────────────────────────────────────────────────────────

export class OrchestrationEngine {
  private projectDir: string;
  private adapters: Map<string, Adapter> = new Map();
  private initialized = false;

  constructor(deps: OrchestrationEngineDeps) {
    this.projectDir = deps.projectDir;

    // Register built-in adapters if dependencies are provided.
    if (deps.getChatClient && deps.getTools) {
      const clientFn = deps.getChatClient as () => import('../core/chatClient').IChatClient | null;
      const toolsFn = deps.getTools as () => import('../types').Tool[];
      this.registerAdapter(
        { id: 'ollama-local', type: 'ollama-local', name: 'Ollama Local', settings: {}, enabled: true },
        new OllamaLocalAdapter({
          getClient: clientFn,
          getTools: toolsFn,
          projectDir: this.projectDir,
        }),
      );
    }

    this.registerAdapter(
      { id: 'process', type: 'process', name: 'Shell Process', settings: {}, enabled: true },
      new ProcessAdapter({ projectDir: this.projectDir }),
    );
  }

  // ─── Adapter Management ───────────────────────────────────────────

  registerAdapter(config: AdapterConfig, adapter: Adapter): void {
    registerAdapter(config, adapter);
    this.adapters.set(config.id, adapter);
  }

  getAdapter(adapterId: string): Adapter | undefined {
    return this.adapters.get(adapterId) ?? getAdapter(adapterId);
  }

  // ─── Company ─────────────────────────────────────────────────────

  async createCompany(input: CreateCompanyInput): Promise<Company> {
    return createCompany(this.projectDir, input);
  }

  async getCompany(id: string): Promise<Company | undefined> {
    return getCompany(this.projectDir, id);
  }

  async listCompanies(): Promise<Company[]> {
    return listCompanies(this.projectDir);
  }

  async updateCompany(id: string, input: UpdateCompanyInput): Promise<Company> {
    return updateCompany(this.projectDir, id, input);
  }

  // ─── Goals ────────────────────────────────────────────────────────

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    return createGoal(this.projectDir, input);
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    return getGoal(this.projectDir, id);
  }

  async listGoals(companyId?: string): Promise<Goal[]> {
    return listGoals(this.projectDir, companyId ? { companyId } : undefined);
  }

  async updateGoal(id: string, input: UpdateGoalInput): Promise<Goal> {
    return updateGoal(this.projectDir, id, input);
  }

  // ─── Issues ───────────────────────────────────────────────────────

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    return createIssue(this.projectDir, input);
  }

  async getIssue(id: string): Promise<Issue | undefined> {
    return getIssue(this.projectDir, id);
  }

  async listIssues(goalId: string): Promise<Issue[]> {
    return listIssues(this.projectDir, { goalId });
  }

  async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
    return updateIssue(this.projectDir, id, input);
  }

  // ─── Org Charts ──────────────────────────────────────────────────

  async createOrgChart(input: CreateOrgChartInput): Promise<OrgChart> {
    return createOrgChart(this.projectDir, input);
  }

  async getOrgChart(id: string): Promise<OrgChart | undefined> {
    return getOrgChart(this.projectDir, id);
  }

  async listOrgCharts(companyId?: string): Promise<OrgChart[]> {
    return listOrgCharts(this.projectDir, companyId ? { companyId } : undefined);
  }

  async updateOrgChart(id: string, input: import('./orgChart').UpdateOrgChartInput): Promise<OrgChart> {
    return updateOrgChart(this.projectDir, id, input);
  }

  // ─── Tasks ────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    return createTask(this.projectDir, input);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return getTask(this.projectDir, id);
  }

  async listTasks(filter?: { status?: string; assigneeId?: string }): Promise<Task[]> {
    return listTasks(this.projectDir, filter as Parameters<typeof listTasks>[1]);
  }

  async updateTask(id: string, input: Parameters<typeof updateTask>[2]): Promise<Task> {
    return updateTask(this.projectDir, id, input);
  }

  // ─── Goal Decomposition ───────────────────────────────────────────

  /**
   * Decompose a high-level goal into issues and tasks.
   *
   * This is the core planning function. It takes a goal's title and
   * description and breaks it down into structured work items that can
   * be assigned to agents via the org chart.
   *
   * The decomposition respects dependency ordering: tasks in later issues
   * depend on tasks in earlier issues, forming a DAG.
   */
  async decomposeGoal(goalId: string, decomposition: {
    issues: Array<{
      title: string;
      description?: string;
      priority?: import('./goal').IssuePriority;
      tasks: Array<{
        title: string;
        description?: string;
        tags?: string[];
      }>;
    }>;
  }): Promise<DecompositionResult> {
    const goal = await getGoal(this.projectDir, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    const issues: Issue[] = [];
    const tasks: Task[] = [];
    const warnings: string[] = [];
    const previousIssueTaskIds: string[] = [];

    for (const issueSpec of decomposition.issues) {
      // Create the issue.
      const issue = await createIssue(this.projectDir, {
        goalId: goal.id,
        companyId: goal.companyId,
        title: issueSpec.title,
        description: issueSpec.description,
        priority: issueSpec.priority,
      });
      issues.push(issue);

      const issueTaskIds: string[] = [];

      for (const taskSpec of issueSpec.tasks) {
        // Create the task, linking it to the issue and adding dependencies
        // on tasks from previous issues.
        const dependsOn = taskSpec.description?.includes('[no-deps]')
          ? []
          : [...previousIssueTaskIds];

        const task = await createTask(this.projectDir, {
          title: taskSpec.title,
          description: taskSpec.description,
          tags: [...(taskSpec.tags ?? []), 'orchestration', `goal:${goal.id}`, `issue:${issue.id}`],
          metadata: {
            goalId: goal.id,
            issueId: issue.id,
            companyId: goal.companyId,
          },
          dependsOn,
        });
        tasks.push(task);
        issueTaskIds.push(task.id);
      }

      // Link tasks back to the issue.
      await updateIssue(this.projectDir, issue.id, {
        linkedTaskIds: issueTaskIds,
      });

      // Chain: next issue's tasks depend on this issue's tasks.
      previousIssueTaskIds.length = 0;
      previousIssueTaskIds.push(...issueTaskIds);
    }

    // Recompute goal progress.
    await computeGoalProgress(this.projectDir, goal.id);

    await emitEvent(this.projectDir, 'orchestration', 'goal.decomposed', {
      goalId: goal.id,
      issueCount: issues.length,
      taskCount: tasks.length,
    }, 'system', goal.id).catch(() => {});

    return { goal, issues, tasks, warnings };
  }

  // ─── Task Dispatch ────────────────────────────────────────────────

  /**
   * Dispatch a task to an agent via the org chart.
   *
   * Finds the best available agent for the task based on:
   *   1. The org chart hierarchy
   *   2. The task's tags (matching agent capabilities)
   *   3. Current workload (prefer agents with fewer active tasks)
   *
   * Returns the dispatch result with the agent and adapter used.
   */
  async dispatchTask(taskId: string, orgChartId?: string): Promise<TaskDispatchResult> {
    const task = await getTask(this.projectDir, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Find the best agent for this task.
    const { agentId, adapterId } = await this.findBestAgent(task, orgChartId);

    // Assign the task.
    await updateTask(this.projectDir, taskId, {
      assigneeId: agentId,
      status: 'assigned',
    });

    // Build the run context.
    const companyId = (task.metadata?.companyId as string) ?? 'default';
    const adapter = this.getAdapter(adapterId);
    if (!adapter) {
      return {
        taskId,
        agentId,
        adapterId,
        success: false,
        output: '',
        error: `Adapter not found: ${adapterId}`,
        durationMs: 0,
      };
    }

    const context: RunContext = {
      projectDir: this.projectDir,
      companyId,
      agentId,
      prompt: task.description ?? task.title,
      budget: {
        maxTurns: 15,
        maxTimeMs: 180_000,
        maxCostUsd: 1.0,
      },
    };

    const startTime = Date.now();
    try {
      const result = await adapter.execute(context);
      const durationMs = Date.now() - startTime;

      // Update task based on result.
      const newStatus: import('../services/taskStore').TaskStatus = result.success ? 'done' : 'failed';
      await updateTask(this.projectDir, taskId, {
        status: newStatus,
      });
      await recordCheckIn(this.projectDir, taskId, {
        progressPercent: result.success ? 100 : 0,
        message: result.success ? 'Task completed successfully' : `Task failed: ${result.error}`,
        status: newStatus,
      });

      await emitEvent(this.projectDir, 'orchestration', 'task.dispatched', {
        taskId,
        agentId,
        adapterId,
        success: result.success,
        durationMs,
      }, 'system', taskId).catch(() => {});

      return {
        taskId,
        agentId,
        adapterId,
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs,
        tokensUsed: result.tokens,
        costUsd: result.costUsd,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      await updateTask(this.projectDir, taskId, { status: 'failed' });
      return {
        taskId,
        agentId,
        adapterId,
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }

  // ─── Goal Execution ───────────────────────────────────────────────

  /**
   * Execute all tasks for a goal, respecting dependency order.
   *
   * This is the top-level "run the company" method. It:
   *   1. Finds all tasks linked to the goal (via issues)
   *   2. Resolves dependency order (topological sort)
   *   3. Dispatches tasks in waves respecting concurrency limits
   *   4. Tracks progress and handles failures
   *   5. Rolls progress up to the goal level
   */
  async runGoal(goalId: string, options: RunGoalOptions = {}): Promise<RunGoalResult> {
    const { concurrency = 3, abortSignal, dryRun = false } = options;
    const goal = await getGoal(this.projectDir, goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    // Mark goal as active.
    await updateGoal(this.projectDir, goalId, { status: 'active' });

    // Collect all tasks linked to the goal via issues.
    const issues = await listIssues(this.projectDir, { goalId });
    const allTaskIds: string[] = [];
    for (const issue of issues) {
      allTaskIds.push(...issue.linkedTaskIds);
    }

    // Resolve dependency order via topological sort.
    const { ordered, skipped } = await this.topologicalSortTasks(allTaskIds);
    const allTasks = await listTasks(this.projectDir);
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    if (dryRun) {
      return {
        goalId,
        companyId: goal.companyId,
        totalTasks: allTaskIds.length,
        completedTasks: 0,
        failedTasks: 0,
        skippedTasks: skipped.length,
        totalDurationMs: 0,
        taskResults: ordered.map((id) => ({
          taskId: id,
          success: false,
          output: '(dry run)',
          durationMs: 0,
        })),
      };
    }

    // Execute tasks in waves respecting concurrency.
    const startTime = Date.now();
    const results: RunGoalResult['taskResults'] = [];
    const completed = new Set<string>();
    const failed = new Set<string>();

    for (let wave = 0; wave < ordered.length; wave += concurrency) {
      if (abortSignal?.aborted) break;

      const waveTaskIds = ordered.slice(wave, wave + concurrency);
      const wavePromises = waveTaskIds.map(async (taskId) => {
        const task = taskMap.get(taskId);
        if (!task) {
          return { taskId, success: false, error: 'Task not found', durationMs: 0 };
        }

        // Check if all dependencies are satisfied.
        const depsReady = task.dependsOn.every(
          (depId) => completed.has(depId) || !ordered.includes(depId),
        );
        if (!depsReady) {
          return { taskId, success: false, error: 'Dependencies not met', durationMs: 0 };
        }

        const dispatchResult = await this.dispatchTask(taskId);
        if (dispatchResult.success) {
          completed.add(taskId);
        } else {
          failed.add(taskId);
        }
        return {
          taskId,
          success: dispatchResult.success,
          output: dispatchResult.output,
          error: dispatchResult.error,
          durationMs: dispatchResult.durationMs,
        };
      });

      const waveResults = await Promise.all(wavePromises);
      results.push(...waveResults);
    }

    const totalDurationMs = Date.now() - startTime;

    // Update goal progress.
    await computeGoalProgress(this.projectDir, goalId);
    const finalGoal = await getGoal(this.projectDir, goalId);
    if (finalGoal && finalGoal.progressPercent === 100) {
      await updateGoal(this.projectDir, goalId, { status: 'completed' });
    }

    await emitEvent(this.projectDir, 'orchestration', 'goal.run_completed', {
      goalId,
      totalTasks: allTaskIds.length,
      completed: completed.size,
      failed: failed.size,
      durationMs: totalDurationMs,
    }, 'system', goalId).catch(() => {});

    return {
      goalId,
      companyId: goal.companyId,
      totalTasks: allTaskIds.length,
      completedTasks: completed.size,
      failedTasks: failed.size,
      skippedTasks: skipped.length,
      totalDurationMs,
      taskResults: results,
    };
  }

  // ─── Escalation ──────────────────────────────────────────────────

  /**
   * Escalate a stuck task up the org chart.
   *
   * Finds the agent's manager in the org chart and reassigns the task.
   * If the agent has no manager, the task is flagged for human review.
   */
  async escalateTask(taskId: string, reason: string, orgChartId: string): Promise<EscalationResult> {
    const task = await getTask(this.projectDir, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const chart = await getOrgChart(this.projectDir, orgChartId);
    if (!chart) throw new Error(`Org chart not found: ${orgChartId}`);

    const currentAgentId = task.assigneeId;
    if (!currentAgentId) {
      // No agent assigned — flag for human review.
      await updateTask(this.projectDir, taskId, {
        status: 'review',
        metadata: { ...task.metadata, escalationReason: reason, escalatedAt: new Date().toISOString() },
      });
      return {
        taskId,
        fromAgentId: '(unassigned)',
        toAgentId: '(human review)',
        reason,
        timestamp: new Date().toISOString(),
      };
    }

    // Find the agent's manager in the org chart.
    const node = chart.nodes.find((n) => n.agentId === currentAgentId);
    const managerId = node?.managerId;

    if (!managerId) {
      // Agent is at the top of the chart — flag for human review.
      await updateTask(this.projectDir, taskId, {
        status: 'review',
        metadata: { ...task.metadata, escalationReason: reason, escalatedAt: new Date().toISOString() },
      });
      return {
        taskId,
        fromAgentId: currentAgentId,
        toAgentId: '(human review — top of org)',
        reason,
        timestamp: new Date().toISOString(),
      };
    }

    // Reassign to the manager.
    await updateTask(this.projectDir, taskId, {
      assigneeId: managerId,
      metadata: { ...task.metadata, escalatedFrom: currentAgentId, escalationReason: reason, escalatedAt: new Date().toISOString() },
    });

    await emitEvent(this.projectDir, 'orchestration', 'task.escalated', {
      taskId,
      fromAgentId: currentAgentId,
      toAgentId: managerId,
      reason,
    }, 'system', taskId).catch(() => {});

    return {
      taskId,
      fromAgentId: currentAgentId,
      toAgentId: managerId,
      reason,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Stale Task Detection ─────────────────────────────────────────

  /**
   * Detect and escalate stale tasks that haven't been updated recently.
   */
  async detectAndEscalateStaleTasks(
    orgChartId: string,
    staleAfterMinutes = 30,
  ): Promise<EscalationResult[]> {
    const staleMs = staleAfterMinutes * 60 * 1000;
    const staleTasks = await detectStaleTasks(this.projectDir, new Date(), staleMs);
    const results: EscalationResult[] = [];

    for (const task of staleTasks) {
      try {
        const result = await this.escalateTask(
          task.taskId,
          `No progress for ${staleAfterMinutes} minutes`,
          orgChartId,
        );
        results.push(result);
      } catch (err) {
        logger.warn('Orchestration', 'Failed to escalate stale task', {
          taskId: task.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Find the best agent for a task based on org chart, tags, and workload.
   */
  private async findBestAgent(
    task: Task,
    orgChartId?: string,
  ): Promise<{ agentId: string; adapterId: string }> {
    // If the task is already assigned, honour that assignment.
    if (task.assigneeId) {
      return { agentId: task.assigneeId, adapterId: 'ollama-local' };
    }

    // If we have an org chart, use it to find available agents.
    if (orgChartId) {
      const chart = await getOrgChart(this.projectDir, orgChartId);
      if (chart && chart.nodes.length > 0) {
        // Prefer leaf nodes (workers) for task execution.
        const workers = chart.nodes.filter(
          (n) => n.reportIds.length === 0 || n.role === 'engineer' || n.role === 'researcher',
        );
        if (workers.length > 0) {
          // Round-robin: pick the worker with fewest active tasks.
          const activeTasks = await listTasks(this.projectDir, { status: 'in_progress' });
          const taskCounts = new Map<string, number>();
          for (const at of activeTasks) {
            taskCounts.set(at.assigneeId ?? '', (taskCounts.get(at.assigneeId ?? '') ?? 0) + 1);
          }
          workers.sort((a, b) => (taskCounts.get(a.agentId) ?? 0) - (taskCounts.get(b.agentId) ?? 0));
          const chosen = workers[0];
          return { agentId: chosen.agentId, adapterId: chosen.adapterId ?? 'ollama-local' };
        }
      }
    }

    // Fallback: use the default agent with the Ollama adapter.
    return { agentId: 'default-agent', adapterId: 'ollama-local' };
  }

  /**
   * Topological sort of tasks respecting dependency order.
   * Returns ordered task IDs and any IDs that were skipped due to cycles.
   */
  private async topologicalSortTasks(taskIds: string[]): Promise<{ ordered: string[]; skipped: string[] }> {
    const allTasks = await listTasks(this.projectDir);
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const relevantIds = new Set(taskIds);
    const ordered: string[] = [];
    const skipped: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(id: string): boolean {
      if (visited.has(id)) return true;
      if (visiting.has(id)) {
        // Cycle detected — skip this node.
        skipped.push(id);
        return false;
      }
      if (!relevantIds.has(id)) return true; // External dependency, ignore.

      visiting.add(id);
      const task = taskMap.get(id);
      if (task) {
        for (const depId of task.dependsOn) {
          if (relevantIds.has(depId)) {
            visit(depId);
          }
        }
      }
      visiting.delete(id);
      visited.add(id);
      ordered.push(id);
      return true;
    }

    for (const id of taskIds) {
      visit(id);
    }

    return { ordered, skipped };
  }
}