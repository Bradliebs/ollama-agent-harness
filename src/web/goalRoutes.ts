// Express router for Active Goal management.
//
// Exposes CRUD + lifecycle (pause/resume/abandon) + SSE event stream for a
// running loop. The router is created via `createGoalRouter(deps)` so the
// caller injects projectDir + auth + a runner factory. This keeps the goal
// module decoupled from server.ts's globals and from any specific iteration
// runner implementation (shell, queryLoop, custom).

import express from 'express';
import {
  createGoal as storeCreateGoal,
  readGoal,
  listGoals,
  transitionGoal,
  setActiveGoal,
} from '../goal/store';
import { resumeGoal } from '../goal/resume';
import { getResumableGoal } from '../goal/resume';
import { runGoalLoop, type GoalLoopEvent } from '../goal/loop';
import { abortRun, isRunning, registerRun, unregisterRun } from '../goal/runRegistry';
import { isTerminal, makeGoal, type GoalCheck, type GoalConstraint, type NewGoalInput } from '../goal/types';
import type { IterationRunner } from '../goal/shellRunner';

export interface GoalRoutesDeps {
  projectDir: string;
  /** Returns true if the request is authorised; should send 401 + return false otherwise. */
  requireAuth?: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
  /** Builds an IterationRunner from the POST /start body. Throw to reject the request. */
  makeRunner: (body: unknown, goalId: string) => IterationRunner;
  /** Override clock for tests. */
  now?: () => Date;
  /** Override the loop generator (for tests). Defaults to runGoalLoop. */
  runLoop?: typeof runGoalLoop;
}

export function createGoalRouter(deps: GoalRoutesDeps): express.Router {
  const router = express.Router();
  const requireAuth = deps.requireAuth ?? (() => true);
  const now = deps.now ?? (() => new Date());
  const runLoop = deps.runLoop ?? runGoalLoop;

  // ── List ───────────────────────────────────────────────────────────────
  router.get('/api/goals', async (_req, res) => {
    try {
      const goals = await listGoals(deps.projectDir);
      res.json({ goals });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // ── Active pointer ─────────────────────────────────────────────────────
  // NB: must come before `/api/goals/:id` so 'active' is not swallowed as an id.
  router.get('/api/goals/active', async (_req, res) => {
    try {
      const r = await getResumableGoal(deps.projectDir);
      res.json(r);
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // ── Read ───────────────────────────────────────────────────────────────
  router.get('/api/goals/:id', async (req, res) => {
    try {
      const g = await readGoal(deps.projectDir, req.params.id);
      if (!g) { res.status(404).json({ error: 'goal not found' }); return; }
      res.json({ goal: g, running: isRunning(g.id) });
    } catch (err) {
      sendError(res, 500, err);
    }
  });

  // ── Create ─────────────────────────────────────────────────────────────
  router.post('/api/goals', async (req, res) => {
    if (!requireAuth(req, res, 'create goal')) return;
    try {
      const input = parseNewGoalInput(req.body);
      const goal = await storeCreateGoal(deps.projectDir, input, now());
      res.status(201).json({ goal });
    } catch (err) {
      sendError(res, 400, err);
    }
  });

  // ── Pause ──────────────────────────────────────────────────────────────
  router.post('/api/goals/:id/pause', async (req, res) => {
    if (!requireAuth(req, res, 'pause goal')) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : 'paused by user';
    try {
      const goal = await transitionGoal(deps.projectDir, req.params.id, 'paused', {
        pause: { reason: reason || 'paused by user', pausedAt: now().toISOString(), pausedBy: 'human' },
      }, now());
      // Best-effort: interrupt the in-flight loop if one is running.
      abortRun(req.params.id);
      res.json({ goal });
    } catch (err) {
      sendError(res, 400, err);
    }
  });

  // ── Resume ─────────────────────────────────────────────────────────────
  router.post('/api/goals/:id/resume', async (req, res) => {
    if (!requireAuth(req, res, 'resume goal')) return;
    try {
      const goal = await resumeGoal(deps.projectDir, req.params.id, now());
      res.json({ goal });
    } catch (err) {
      sendError(res, 400, err);
    }
  });

  // ── Abandon ────────────────────────────────────────────────────────────
  router.post('/api/goals/:id/abandon', async (req, res) => {
    if (!requireAuth(req, res, 'abandon goal')) return;
    try {
      const current = await readGoal(deps.projectDir, req.params.id);
      if (!current) { res.status(404).json({ error: 'goal not found' }); return; }
      if (isTerminal(current.status)) {
        res.status(409).json({ error: `goal is already terminal (${current.status})` });
        return;
      }
      // Drop straight to abandoned regardless of current state (all non-terminal
      // statuses have 'abandoned' in their ALLOWED_TRANSITIONS table).
      const goal = await transitionGoal(deps.projectDir, req.params.id, 'abandoned', {}, now());
      abortRun(req.params.id);
      res.json({ goal });
    } catch (err) {
      sendError(res, 400, err);
    }
  });

  // ── Start (SSE) ────────────────────────────────────────────────────────
  router.post('/api/goals/:id/start', async (req, res) => {
    if (!requireAuth(req, res, 'start goal')) return;
    const goalId = req.params.id;

    const goal = await readGoal(deps.projectDir, goalId);
    if (!goal) { res.status(404).json({ error: 'goal not found' }); return; }
    if (isTerminal(goal.status)) {
      res.status(409).json({ error: `goal is terminal (${goal.status})` });
      return;
    }
    if (isRunning(goalId)) {
      res.status(409).json({ error: 'goal already has an in-flight run in this process' });
      return;
    }

    let runner: IterationRunner;
    try {
      runner = deps.makeRunner(req.body, goalId);
    } catch (err) {
      sendError(res, 400, err);
      return;
    }

    // Mark active (best-effort; failure here is fatal because the loop relies
    // on the goal existing).
    try { await setActiveGoal(deps.projectDir, goalId); } catch (err) {
      sendError(res, 500, err);
      return;
    }

    // SSE wire-up.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abort = registerRun(goalId);
    const cleanup = (): void => {
      unregisterRun(goalId);
    };

    // Client disconnect → cooperative abort.
    req.on('close', () => {
      if (!abort.signal.aborted) abort.abort();
    });

    try {
      const gen = runLoop({
        projectDir: deps.projectDir,
        goalId,
        runIteration: runner,
        now,
        abortSignal: abort.signal,
      });
      for await (const ev of gen) {
        writeSseEvent(res, ev);
        if (ev.type === 'loop_end') break;
      }
    } catch (err) {
      writeSseEvent(res, { type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      cleanup();
      try { res.end(); } catch { /* socket already closed */ }
    }
  });

  return router;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sendError(res: express.Response, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  res.status(status).json({ error: message });
}

function writeSseEvent(res: express.Response, event: GoalLoopEvent | { type: string; [k: string]: unknown }): void {
  // SSE: `event: <type>\ndata: <json>\n\n`. Naming the event lets clients
  // wire up addEventListener(type, ...) rather than parsing every payload.
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function parseNewGoalInput(body: unknown): NewGoalInput {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.target !== 'string' || b.target.trim().length === 0) {
    throw new Error('target is required and must be a non-empty string');
  }
  const out: NewGoalInput = { target: b.target.trim() };
  if (Array.isArray(b.verification)) {
    out.verification = b.verification.map((v, i) => parseCheck(v, i));
  }
  if (Array.isArray(b.constraints)) {
    out.constraints = b.constraints.map((c, i) => parseConstraint(c, i));
  }
  if (typeof b.spawnedFrom === 'string') out.spawnedFrom = b.spawnedFrom;
  // Smoke-test that the input would build into a valid Goal shape.
  makeGoal(out, 'preview-id');
  return out;
}

function parseCheck(v: unknown, idx: number): GoalCheck {
  if (!v || typeof v !== 'object') throw new Error(`verification[${idx}] must be an object`);
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.description !== 'string' || typeof c.required !== 'boolean') {
    throw new Error(`verification[${idx}] requires {id, description, required, spec}`);
  }
  if (!c.spec || typeof c.spec !== 'object') throw new Error(`verification[${idx}].spec missing`);
  // Spec validation is deliberately shallow: the verification runners
  // surface concrete errors per kind, and we don't want to keep this in
  // sync with every spec field by hand.
  return c as unknown as GoalCheck;
}

function parseConstraint(v: unknown, idx: number): GoalConstraint {
  if (!v || typeof v !== 'object') throw new Error(`constraints[${idx}] must be an object`);
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.description !== 'string') {
    throw new Error(`constraints[${idx}] requires {id, description, spec}`);
  }
  if (!c.spec || typeof c.spec !== 'object') throw new Error(`constraints[${idx}].spec missing`);
  return c as unknown as GoalConstraint;
}
