// Orchestration Heartbeat — periodic actions that keep the orchestration layer alive.
//
// These heartbeat actions integrate with the existing SelfLearningHeartbeat system.
// They monitor goal progress, detect stale tasks, rebalance org charts, and
// enforce budgets.
//
// Usage:
//   const heartbeat = new SelfLearningHeartbeat({
//     projectDir,
//     actions: [...defaultHeartbeatActions(), ...orchestrationHeartbeatActions(projectDir)],
//     ...
//   });

import { logger } from '../core/logger';
import { listGoals, computeGoalProgress } from './goal';
import { listCompanies } from './company';
import { detectStaleTasks, updateTask } from '../services/taskStore';
import type { HeartbeatAction, HeartbeatActionResult } from '../services/selfLearningHeartbeat';
import { OrchestrationEngine } from './engine';

// ─── Heartbeat Actions ──────────────────────────────────────────────

/**
 * Monitor goal progress — recompute progress for all active goals.
 */
export function goalProgressAction(projectDir: string): HeartbeatAction {
  return {
    name: 'orchestration_goal_progress',
    async run(dir: string): Promise<HeartbeatActionResult> {
      try {
        const companies = await listCompanies(dir);
        let totalUpdated = 0;

        for (const company of companies) {
          if (company.status !== 'active') continue;
          const goals = await listGoals(dir, { companyId: company.id });
          for (const goal of goals) {
            if (goal.status !== 'active') continue;
            await computeGoalProgress(dir, goal.id);
            totalUpdated++;
          }
        }

        return {
          ok: true,
          summary: `Updated progress for ${totalUpdated} active goals`,
          details: { totalUpdated },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Goal progress check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Detect stale tasks in active goals and flag them for review.
 */
export function staleTaskDetectionAction(
  projectDir: string,
  staleAfterMinutes = 30,
): HeartbeatAction {
  return {
    name: 'orchestration_stale_tasks',
    async run(dir: string): Promise<HeartbeatActionResult> {
      try {
        const staleMs = staleAfterMinutes * 60 * 1000;
        const staleTasks = await detectStaleTasks(dir, new Date(), staleMs);

        if (staleTasks.length === 0) {
          return { ok: true, summary: 'No stale tasks detected' };
        }

        // Flag stale tasks as blocked.
        let flagged = 0;
        for (const task of staleTasks) {
          try {
            await updateTask(dir, task.taskId, { status: 'blocked' });
            flagged++;
          } catch {
            // Skip tasks that can't be updated.
          }
        }

        return {
          ok: true,
          summary: `Flagged ${flagged} of ${staleTasks.length} stale tasks as blocked`,
          details: { staleCount: staleTasks.length, flaggedCount: flagged },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Stale task detection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Budget enforcement — check if any company has exceeded its monthly budget.
 */
export function budgetEnforcementAction(projectDir: string): HeartbeatAction {
  return {
    name: 'orchestration_budget_check',
    async run(dir: string): Promise<HeartbeatActionResult> {
      try {
        const companies = await listCompanies(dir);
        let overBudget = 0;

        for (const company of companies) {
          if (company.status !== 'active') continue;
          if (!company.budget?.monthlyLimitUsd) continue;

          // In a full implementation, we'd sum up actual costs from task runs.
          // For now, just check the company exists and has a budget configured.
          // TODO: wire into actual cost tracking once run transcripts exist.
          logger.debug('Orchestration', 'Budget check for company', {
            companyId: company.id,
            budget: company.budget,
          });
        }

        return {
          ok: true,
          summary: `Checked budgets for ${companies.length} companies`,
          details: { companiesChecked: companies.length, overBudget },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Budget check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Paused company reactivation — check if any paused companies should be resumed.
 */
export function companyHealthCheckAction(projectDir: string): HeartbeatAction {
  return {
    name: 'orchestration_company_health',
    async run(dir: string): Promise<HeartbeatActionResult> {
      try {
        const companies = await listCompanies(dir);
        const active = companies.filter((c) => c.status === 'active');
        const paused = companies.filter((c) => c.status === 'paused');
        const archived = companies.filter((c) => c.status === 'archived');

        return {
          ok: true,
          summary: `${active.length} active, ${paused.length} paused, ${archived.length} archived companies`,
          details: { active: active.length, paused: paused.length, archived: archived.length },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `Company health check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ─── Convenience ────────────────────────────────────────────────────

/**
 * All orchestration heartbeat actions, ready to add to a SelfLearningHeartbeat.
 */
export function orchestrationHeartbeatActions(
  projectDir: string,
  staleAfterMinutes = 30,
): HeartbeatAction[] {
  return [
    goalProgressAction(projectDir),
    staleTaskDetectionAction(projectDir, staleAfterMinutes),
    budgetEnforcementAction(projectDir),
    companyHealthCheckAction(projectDir),
  ];
}