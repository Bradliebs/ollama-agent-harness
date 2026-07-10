import express from 'express';
import type { NervousSystemController } from '../nervous';

export type NervousSnapshot = {
  summary: ReturnType<NervousSystemController['getSummary']>;
  signals: ReturnType<NervousSystemController['getSignals']>;
  recovery: ReturnType<NervousSystemController['getRecoveryPlan']>;
  runState: ReturnType<NervousSystemController['getRunState']>;
} | null;

export interface NervousRoutesDeps {
  projectDir: string;
  getLastSnapshot: () => NervousSnapshot;
  getPermissionMode: () => string;
  isVerificationBypassActive: () => boolean;
  readPersistedSignals: (projectDir: string, limit: number) => Promise<unknown[]>;
}

export function createNervousRouter(deps: NervousRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir, getLastSnapshot, getPermissionMode, isVerificationBypassActive, readPersistedSignals } = deps;

  router.get('/api/nervous', (_req, res) => {
    const snap = getLastSnapshot();
    const state = snap?.runState ?? null;
    const signals = snap?.signals ?? [];
    const summary = snap?.summary ?? { totalSignals: 0, bySeverity: {}, byType: {}, runActive: false };
    const recovery = snap?.recovery ?? null;
    res.json({
      active: state !== null,
      permissionMode: getPermissionMode(),
      verificationBypassActive: isVerificationBypassActive(),
      summary,
      signals: signals.slice(-20).map((s) => ({ type: s.type, severity: s.severity, message: s.message, source: s.source, createdAt: s.createdAt })),
      recovery: recovery ? { reason: recovery.reason, safeNextAction: recovery.safeNextAction } : null,
    });
  });

  router.get('/api/nervous/history', async (_req, res) => {
    try {
      const history = await readPersistedSignals(projectDir, 100);
      res.json({ signals: history });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
