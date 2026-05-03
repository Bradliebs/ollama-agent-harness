import { SignalBus, createSignal, type NervousSignal } from './signals';
import { inspectUserQuery, inspectToolResult, inspectVerifierResult, inspectLoopBehavior, inspectContextPressure } from './sensory';
import { createRunState, evaluateReflexes } from './reflexes';
import { calculateAttentionBiases } from './attention';
import { checkMotorPermission } from './motor';
import { extractPainSignals, aggregatePainMultiplier, isSafetyRewardSignal } from './pain';
import { buildRecoveryPlan } from './recovery';
import { NervousSystemController } from './controller';

describe('Nervous System', () => {
  // ─── Signals ────────────────────────────────────────────────────

  describe('SignalBus', () => {
    it('publishes signals to typed handlers', () => {
      const bus = new SignalBus();
      const received: NervousSignal[] = [];
      bus.on('TOOL_ERROR', (s) => received.push(s));
      bus.publish(createSignal('TOOL_ERROR', 'test', 'high', 'fail'));
      bus.publish(createSignal('TOOL_SUCCESS', 'test', 'info', 'ok'));
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('TOOL_ERROR');
    });

    it('publishes to onAny handlers', () => {
      const bus = new SignalBus();
      const received: NervousSignal[] = [];
      bus.onAny((s) => received.push(s));
      bus.publish(createSignal('TOOL_ERROR', 'test', 'high', 'fail'));
      bus.publish(createSignal('TOOL_SUCCESS', 'test', 'info', 'ok'));
      expect(received).toHaveLength(2);
    });

    it('keeps a rolling log', () => {
      const bus = new SignalBus(3);
      for (let i = 0; i < 5; i++) bus.publish(createSignal('USER_INTENT', 'test', 'info', `msg ${i}`));
      expect(bus.recent()).toHaveLength(3);
    });
  });

  // ─── Sensory layer ──────────────────────────────────────────────

  describe('sensory', () => {
    it('detects user correction', () => {
      const signals = inspectUserQuery('No that is wrong, redo it');
      expect(signals.some((s) => s.type === 'USER_CORRECTION')).toBe(true);
    });

    it('detects irreversible action', () => {
      const signals = inspectUserQuery('Delete all the test files');
      expect(signals.some((s) => s.type === 'IRREVERSIBLE_ACTION')).toBe(true);
      expect(signals.some((s) => s.type === 'DRY_RUN_REQUIRED')).toBe(true);
      expect(signals.some((s) => s.type === 'CONFIRMATION_REQUIRED')).toBe(true);
    });

    it('detects privacy risk', () => {
      const signals = inspectUserQuery('Show me the API key for production');
      expect(signals.some((s) => s.type === 'PRIVACY_RISK')).toBe(true);
    });

    it('detects high-risk domain', () => {
      const signals = inspectUserQuery('Deploy this to the production server');
      expect(signals.some((s) => s.type === 'TASK_RISK')).toBe(true);
    });

    it('detects user confusion', () => {
      const signals = inspectUserQuery("I don't understand what you mean");
      expect(signals.some((s) => s.type === 'USER_CONFUSION')).toBe(true);
    });

    it('detects tool failure', () => {
      const signals = inspectToolResult('bash', false, 'command not found', 3);
      expect(signals.some((s) => s.type === 'TOOL_ERROR')).toBe(true);
      expect(signals.some((s) => s.type === 'REPEATED_FAILURE')).toBe(true);
    });

    it('detects verifier failure', () => {
      const signals = inspectVerifierResult('fail', 0.2, ['Test failed']);
      expect(signals.some((s) => s.type === 'VERIFIER_FAIL')).toBe(true);
      expect(signals.some((s) => s.type === 'RECOVERY_REQUIRED')).toBe(true);
    });

    it('detects agent loop', () => {
      const signals = inspectLoopBehavior(['bash', 'bash', 'bash', 'bash']);
      expect(signals.some((s) => s.type === 'AGENT_LOOP')).toBe(true);
    });

    it('detects context overload', () => {
      const signals = inspectContextPressure(95000, 100000);
      expect(signals.some((s) => s.type === 'CONTEXT_OVERLOAD')).toBe(true);
      expect(signals.some((s) => s.type === 'COMPRESSION_REQUIRED')).toBe(true);
    });

    it('detects token pressure below overload', () => {
      const signals = inspectContextPressure(80000, 100000);
      expect(signals.some((s) => s.type === 'TOKEN_PRESSURE')).toBe(true);
      expect(signals.some((s) => s.type === 'CONTEXT_OVERLOAD')).toBe(false);
    });
  });

  // ─── Reflexes ───────────────────────────────────────────────────

  describe('reflexes', () => {
    it('irreversible action reflex sets dry-run and zero exploration', () => {
      const state = createRunState('test', 'general');
      const signals = inspectUserQuery('Delete all production data');
      const { triggered } = evaluateReflexes(signals, state);
      expect(triggered.some((r) => r.reflexName === 'irreversible_action')).toBe(true);
      expect(state.dryRunRequired).toBe(true);
      expect(state.confirmationRequired).toBe(true);
      expect(state.explorationRate).toBe(0);
    });

    it('high-risk domain reflex reduces exploration', () => {
      const state = createRunState('test', 'general');
      const signals = inspectUserQuery('Deploy to production live system');
      evaluateReflexes(signals, state);
      expect(state.explorationRate).toBeLessThanOrEqual(0.02);
      expect(state.verifierRequired).toBe(true);
    });

    it('user correction reflex requires verifier', () => {
      const state = createRunState('test', 'general');
      const signals = inspectUserQuery('No that is wrong');
      evaluateReflexes(signals, state);
      expect(state.verifierRequired).toBe(true);
      expect(state.explorationRate).toBeLessThanOrEqual(0.05);
    });

    it('context overload triggers compression', () => {
      const state = createRunState('test', 'general');
      const signals = inspectContextPressure(95000, 100000);
      evaluateReflexes(signals, state);
      expect(state.compressionRequired).toBe(true);
    });

    it('recovery reflex activates recovery mode', () => {
      const state = createRunState('test', 'general');
      const signals = inspectVerifierResult('fail', 0.1);
      evaluateReflexes(signals, state);
      expect(state.recoveryMode).toBe(true);
      expect(state.explorationRate).toBe(0);
    });
  });

  // ─── Attention ──────────────────────────────────────────────────

  describe('attention', () => {
    it('boosts safety under high risk', () => {
      const state = createRunState('test', 'general');
      state.riskLevel = 'high';
      const biases = calculateAttentionBiases([], state);
      expect(biases.safetyNodes).toBeGreaterThan(1.0);
      expect(biases.novelRoutes).toBeLessThan(0);
    });

    it('boosts novelty for creative tasks', () => {
      const state = createRunState('test', 'creative');
      const biases = calculateAttentionBiases([], state);
      expect(biases.novelRoutes).toBeGreaterThanOrEqual(0.8);
    });

    it('boosts user message on correction', () => {
      const state = createRunState('test', 'general');
      const signals = [createSignal('USER_CORRECTION', 'test', 'high', 'wrong')];
      const biases = calculateAttentionBiases(signals, state);
      expect(biases.latestUserMessage).toBe(1.5);
    });
  });

  // ─── Motor permissions ──────────────────────────────────────────

  describe('motor permissions', () => {
    it('allows read-only tools', () => {
      const state = createRunState('test', 'general');
      state.riskLevel = 'critical';
      expect(checkMotorPermission('file_read', '', state).decision).toBe('ALLOW');
    });

    it('blocks destructive shell commands', () => {
      const state = createRunState('test', 'general');
      const result = checkMotorPermission('bash', '', state, { command: 'rm -rf /' });
      expect(result.decision).toBe('BLOCK');
    });

    it('requires confirmation when confirmationRequired is set', () => {
      const state = createRunState('test', 'general');
      state.confirmationRequired = true;
      expect(checkMotorPermission('file_write', '', state).decision).toBe('REQUIRE_CONFIRMATION');
    });

    it('allows dry-run only when dryRunRequired is set', () => {
      const state = createRunState('test', 'general');
      state.dryRunRequired = true;
      expect(checkMotorPermission('email_send', '', state).decision).toBe('ALLOW_DRY_RUN_ONLY');
    });

    it('interrupts when interruptRequested', () => {
      const state = createRunState('test', 'general');
      state.interruptRequested = true;
      expect(checkMotorPermission('file_write', '', state).decision).toBe('INTERRUPT_AND_RECOVER');
    });
  });

  // ─── Pain engine ────────────────────────────────────────────────

  describe('pain', () => {
    it('extracts pain from failure signals', () => {
      const signals = [createSignal('TOOL_ERROR', 'test', 'high', 'fail')];
      const pain = extractPainSignals(signals);
      expect(pain).toHaveLength(1);
      expect(pain[0].multiplier).toBe(0.35);
    });

    it('aggregates pain to minimum multiplier', () => {
      const pain = [
        { painType: 'a', severity: 'medium' as const, multiplier: 0.65, affectedNodeIds: [], affectedEdgeIds: [], reason: '', confidence: 0.7 },
        { painType: 'b', severity: 'high' as const, multiplier: 0.35, affectedNodeIds: [], affectedEdgeIds: [], reason: '', confidence: 0.85 },
      ];
      expect(aggregatePainMultiplier(pain)).toBe(0.35);
    });

    it('returns 1.0 when no pain', () => {
      expect(aggregatePainMultiplier([])).toBe(1.0);
    });

    it('identifies safety reward signals', () => {
      expect(isSafetyRewardSignal(createSignal('IRREVERSIBLE_ACTION', 'test', 'critical', 'blocked'))).toBe(true);
      expect(isSafetyRewardSignal(createSignal('TOOL_ERROR', 'test', 'high', 'fail'))).toBe(false);
    });
  });

  // ─── Recovery ───────────────────────────────────────────────────

  describe('recovery', () => {
    it('builds a recovery plan', () => {
      const state = createRunState('test', 'general');
      state.recoveryMode = true;
      state.toolErrors.set('bash', 3);
      const signals = [createSignal('REPEATED_FAILURE', 'test', 'high', 'bash failed 3 times')];
      const plan = buildRecoveryPlan(state, signals);
      expect(plan.whatFailed.length).toBeGreaterThan(0);
      expect(plan.verifierRequired).toBe(true);
    });
  });

  // ─── Full controller ───────────────────────────────────────────

  describe('NervousSystemController', () => {
    it('inspects a safe query with no reflexes', () => {
      const ns = new NervousSystemController();
      const result = ns.inspectQuery('What is the weather today?', 'general');
      expect(result.runState.riskLevel).toBe('low');
      expect(result.reflexesTriggered).toHaveLength(0);
      expect(result.runState.dryRunRequired).toBe(false);
    });

    it('inspects a dangerous query and triggers reflexes', () => {
      const ns = new NervousSystemController();
      const result = ns.inspectQuery('Delete all production databases', 'safety_critical');
      expect(result.runState.dryRunRequired).toBe(true);
      expect(result.runState.confirmationRequired).toBe(true);
      expect(result.reflexesTriggered).toContain('irreversible_action');
    });

    it('tracks tool errors across calls', () => {
      const ns = new NervousSystemController();
      ns.inspectQuery('Fix the bug', 'coding');
      ns.onToolResult('bash', false, 'error');
      ns.onToolResult('bash', false, 'error');
      ns.onToolResult('bash', false, 'error');
      const state = ns.getRunState();
      expect(state?.toolErrors.get('bash')).toBe(3);
    });

    it('provides a summary for route explanations', () => {
      const ns = new NervousSystemController();
      ns.inspectQuery('Write a business plan', 'writing');
      const summary = ns.getSummary();
      expect(summary.taskType).toBe('writing');
      expect(typeof summary.signalCount).toBe('number');
    });

    it('full dry-run flow does not crash', () => {
      const ns = new NervousSystemController();
      const result = ns.inspectQuery('Deploy to production', 'safety_critical');
      expect(result.runState.dryRunRequired).toBe(true);

      const permission = ns.checkToolPermission('bash', { command: 'npm run deploy' });
      expect(permission.decision).not.toBe('ALLOW');

      ns.onToolResult('bash', false, 'denied');
      ns.onToolCallSequence(['bash']);

      const verifier = ns.onVerifierResult('fail', 0.2);
      expect(verifier.painMultiplier).toBeLessThan(1.0);

      // Recovery mode should be active after verifier failure signals
      // triggered the recovery reflex
      const state = ns.getRunState();
      expect(state?.recoveryMode).toBe(true);
      const recovery = ns.getRecoveryPlan();
      expect(recovery).toBeDefined();

      ns.reset();
      expect(ns.getRunState()).toBeNull();
    });
  });
});
