import express from 'express';
import { addOverride, checkBudgetState, getEnvCapUsd, readTodaySpend } from '../budget/dailyBudget';
import { appendCapabilityAuditEvent } from '../permissions/capabilityAudit';
import { recordSwallowed } from '../observability/silentFailureSink';
import { logger } from '../core/logger';

export interface BudgetRoutesDeps {
  projectDir: string;
  requireEscalationAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  requireAuditReason: (raw: unknown, res: express.Response, label: string) => string | null;
}

export function createBudgetRouter(deps: BudgetRoutesDeps): express.Router {
  const { projectDir, requireEscalationAuth, requireAuditReason } = deps;
  const router = express.Router();

  router.get('/api/budget/status', async (_req, res) => {
    try {
      const cap = getEnvCapUsd();
      const [state, todayRecord] = await Promise.all([
        checkBudgetState(projectDir, cap),
        readTodaySpend(projectDir),
      ]);
      res.json({
        state,
        byModel: todayRecord?.byModel ?? {},
        firstAt: todayRecord?.firstAt ?? null,
        lastAt: todayRecord?.lastAt ?? null,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/budget/override', async (req, res) => {
    try {
      if (!requireEscalationAuth(req, res, 'daily spend override')) return;
      const reason = requireAuditReason(req.body?.reason, res, 'Daily spend override');
      if (!reason) return;
      const additionalUsd = Number(req.body?.additionalUsd);
      if (!Number.isFinite(additionalUsd) || additionalUsd <= 0) {
        res.status(400).json({ error: 'additionalUsd must be a positive number.' });
        return;
      }
      if (additionalUsd > 1000) {
        res.status(400).json({ error: 'additionalUsd capped at 1000 per request. Issue multiple overrides if intentional.' });
        return;
      }
      const cap = getEnvCapUsd();
      const state = await addOverride(projectDir, additionalUsd, cap);
      logger.warn('Budget', 'Daily spend override applied', { additionalUsd, newCap: state.effectiveCapUsd, utcDate: state.utcDate });
      appendCapabilityAuditEvent(projectDir, {
        type: 'budget.override',
        reason: `${reason} (+$${additionalUsd.toFixed(2)}, new cap $${state.effectiveCapUsd.toFixed(2)} for ${state.utcDate})`,
      }).catch((err) => recordSwallowed('appendCapabilityAuditEvent', err));
      res.json({ state });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
