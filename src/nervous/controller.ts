// Nervous System — Main controller.
//
// Orchestrates the full nervous system pipeline:
// 1. Sensory inspection → signals
// 2. Signal bus → distribution
// 3. Reflex evaluation → run state modifications
// 4. Attention biases → for Mycelium router
// 5. Motor permissions → before tool calls
// 6. Pain extraction → after execution
// 7. Recovery planning → when things go wrong

import { SignalBus, createSignal, type NervousSignal } from './signals';
import { inspectUserQuery, inspectToolResult, inspectVerifierResult, inspectLoopBehavior, inspectContextPressure } from './sensory';
import { createRunState, evaluateReflexes, type NervousRunState } from './reflexes';
import { calculateAttentionBiases, type AttentionBiases } from './attention';
import { checkMotorPermission, type MotorPermission } from './motor';
import { extractPainSignals, aggregatePainMultiplier, isSafetyRewardSignal, type PainSignal } from './pain';
import { buildRecoveryPlan, formatRecoveryPlan, type RecoveryPlan } from './recovery';
import { logger } from '../core/logger';
import { withFileLock } from '../persistence/atomicFile';
import { recordSwallowed } from '../observability/silentFailureSink';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface NervousSystemResult {
  runState: NervousRunState;
  signals: NervousSignal[];
  attentionBiases: AttentionBiases;
  reflexesTriggered: string[];
  recoveryPlan?: RecoveryPlan;
}

export class NervousSystemController {
  private bus: SignalBus;
  private runState: NervousRunState | null = null;
  private allSignals: NervousSignal[] = [];

  constructor() {
    this.bus = new SignalBus(500);
    this.bus.onAny((signal) => {
      this.allSignals.push(signal);
      if (signal.severity === 'critical' || signal.severity === 'high') {
        logger.warn('NervousSystem', `${signal.type}: ${signal.message}`, { severity: signal.severity, source: signal.source });
      }
    });
  }

  /** Phase 1: Inspect user query and create run state. */
  inspectQuery(query: string, taskType: string): NervousSystemResult {
    const runId = `run-${Date.now().toString(36)}`;
    this.runState = createRunState(runId, taskType);
    this.allSignals = [];

    // Sensory inspection
    const signals = inspectUserQuery(query, taskType);
    this.bus.publishMany(signals);

    // Reflex evaluation
    const { triggered } = evaluateReflexes(signals, this.runState);

    // Attention biases
    const attentionBiases = calculateAttentionBiases(signals, this.runState);

    // Recovery plan if needed
    let recoveryPlan: RecoveryPlan | undefined;
    if (this.runState.recoveryMode) {
      recoveryPlan = buildRecoveryPlan(this.runState, signals);
    }

    logger.info('NervousSystem', 'Query inspected', {
      taskType,
      riskLevel: this.runState.riskLevel,
      reflexes: triggered.length,
      signals: signals.length,
    });

    return {
      runState: this.runState,
      signals,
      attentionBiases,
      reflexesTriggered: triggered.map((r) => r.reflexName),
      recoveryPlan,
    };
  }

  /** Phase 2: Check motor permission before a tool call. */
  checkToolPermission(toolName: string, toolInput?: Record<string, unknown>): MotorPermission {
    if (!this.runState) {
      return { decision: 'ALLOW', reason: 'No nervous system run state.', actionType: toolName, target: '' };
    }
    return checkMotorPermission(toolName, '', this.runState, toolInput);
  }

  /** Phase 3: Inspect a tool result during execution. */
  onToolResult(toolName: string, success: boolean, output: string): NervousSignal[] {
    if (!this.runState) return [];

    // Track tool errors
    if (!success) {
      const count = (this.runState.toolErrors.get(toolName) ?? 0) + 1;
      this.runState.toolErrors.set(toolName, count);
    }

    const signals = inspectToolResult(toolName, success, output, this.runState.toolErrors.get(toolName) ?? 0);
    this.bus.publishMany(signals);

    // Re-evaluate reflexes with new signals
    if (signals.some((s) => s.severity === 'high' || s.severity === 'critical')) {
      evaluateReflexes(signals, this.runState);
    }

    return signals;
  }

  /** Phase 4: Inspect loop behavior during execution. */
  onToolCallSequence(toolCallSequence: string[]): NervousSignal[] {
    const signals = inspectLoopBehavior(toolCallSequence);
    this.bus.publishMany(signals);
    if (this.runState && signals.length > 0) {
      evaluateReflexes(signals, this.runState);
    }
    return signals;
  }

  /** Phase 5: Inspect context pressure. */
  onContextPressure(tokenCount: number, maxTokens: number): NervousSignal[] {
    const signals = inspectContextPressure(tokenCount, maxTokens);
    this.bus.publishMany(signals);
    if (this.runState && signals.length > 0) {
      evaluateReflexes(signals, this.runState);
    }
    return signals;
  }

  /** Phase 6: Inspect verifier result after execution. */
  onVerifierResult(status: string, score: number, notes?: string[]): { signals: NervousSignal[]; painSignals: PainSignal[]; painMultiplier: number } {
    const signals = inspectVerifierResult(status, score, notes);
    this.bus.publishMany(signals);

    // Re-evaluate reflexes (may trigger recovery mode on verifier failure)
    if (this.runState && signals.some((s) => s.severity === 'high' || s.severity === 'critical' || s.type === 'RECOVERY_REQUIRED')) {
      evaluateReflexes(signals, this.runState);
    }

    // Extract pain
    const routeNodeIds = this.runState?.requiredNodes ?? [];
    const painSignals = extractPainSignals([...this.allSignals, ...signals], routeNodeIds);
    const painMultiplier = aggregatePainMultiplier(painSignals);

    // Check for safety reward signals
    const safetyRewards = this.allSignals.filter(isSafetyRewardSignal);

    if (safetyRewards.length > 0) {
      logger.info('NervousSystem', 'Safety signals correctly fired', { count: safetyRewards.length });
    }

    return { signals, painSignals, painMultiplier };
  }

  /** Get recovery plan if in recovery mode. */
  getRecoveryPlan(): RecoveryPlan | undefined {
    if (!this.runState?.recoveryMode) return undefined;
    return buildRecoveryPlan(this.runState, this.allSignals);
  }

  /** Format recovery plan as text. */
  getRecoveryText(): string {
    const plan = this.getRecoveryPlan();
    return plan ? formatRecoveryPlan(plan) : '';
  }

  /** Get current run state. */
  getRunState(): NervousRunState | null {
    return this.runState;
  }

  /** Get all signals from current run. */
  getSignals(): NervousSignal[] {
    return [...this.allSignals];
  }

  /** Get signal bus for external subscribers. */
  getBus(): SignalBus {
    return this.bus;
  }

  /** Get a summary for route explanations. */
  getSummary(): Record<string, unknown> {
    if (!this.runState) return {};
    return {
      taskType: this.runState.taskType,
      riskLevel: this.runState.riskLevel,
      explorationRate: this.runState.explorationRate,
      dryRunRequired: this.runState.dryRunRequired,
      confirmationRequired: this.runState.confirmationRequired,
      verifierRequired: this.runState.verifierRequired,
      recoveryMode: this.runState.recoveryMode,
      activeReflexes: this.runState.activeReflexes,
      safetyNotes: this.runState.safetyNotes,
      signalCount: this.allSignals.length,
      painSignals: this.allSignals.filter((s) => s.severity === 'high' || s.severity === 'critical').length,
    };
  }

  /** Persist signals to disk for historical analysis. */
  async persistSignals(projectDir: string): Promise<void> {
    if (this.allSignals.length === 0) return;
    const dir = path.join(projectDir, '.harness', 'nervous');
    const filePath = path.join(dir, 'signals.jsonl');
    try {
      await fs.mkdir(dir, { recursive: true });
      const lines = this.allSignals.map((s) => JSON.stringify({
        id: s.id,
        type: s.type,
        severity: s.severity,
        source: s.source,
        message: s.message,
        runId: this.runState?.runId,
        taskType: this.runState?.taskType,
        createdAt: s.createdAt,
      })).join('\n') + '\n';
      await withFileLock(filePath, () => fs.appendFile(filePath, lines, 'utf-8'));
    } catch (error) {
      recordSwallowed('NervousSystemController.persistSignals', error);
    }
  }

  /** Read recent persisted signals. */
  static async readPersistedSignals(projectDir: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(path.join(projectDir, '.harness', 'nervous', 'signals.jsonl'), 'utf-8');
      return raw.trim().split(/\r?\n/)
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((e): e is Record<string, unknown> => e !== null)
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  /** Reset for next run. */
  reset(): void {
    this.runState = null;
    this.allSignals = [];
  }
}
