import { calibrateModelRoutingPolicy, createHelperAgentConfig, createModelRoutingPolicyFromRegistry, getHelperAgentPreset, selectModelForTask, summarizeRoutingMetrics } from './modelRouting';

describe('model routing', () => {
  it('selects the small model for bounded read-only helper work', () => {
    const decision = selectModelForTask(
      { taskType: 'explore', prompt: 'Find relevant files' },
      { smallModel: 'tiny', defaultModel: 'base', strongModel: 'large' },
    );

    expect(decision).toMatchObject({ tier: 'small', model: 'tiny', escalated: false });
    expect(decision.reasons).toContain('bounded low-risk helper task');
  });

  it('escalates when helper confidence is low', () => {
    const decision = selectModelForTask(
      { taskType: 'summarize', confidence: 0.2 },
      { smallModel: 'tiny', defaultModel: 'base', strongModel: 'large' },
    );

    expect(decision).toMatchObject({ tier: 'strong', model: 'large', escalated: true });
    expect(decision.reasons).toContain('low helper confidence');
  });

  it('escalates state-modifying medium-risk edits to a stronger model', () => {
    const decision = selectModelForTask(
      { taskType: 'edit' },
      { smallModel: 'tiny', defaultModel: 'base', strongModel: 'large' },
    );

    expect(decision).toMatchObject({ tier: 'strong', model: 'large', escalated: true });
    expect(decision.reasons).toContain('state-modifying task');
  });

  it('creates helper agent config from presets and policy', () => {
    const config = createHelperAgentConfig(
      { taskType: 'test-triage', prompt: 'Jest failed' },
      { defaultModel: 'base' },
    );

    expect(config.name).toBe('explore');
    expect(config.model).toBe('base');
    expect(config.systemPrompt).toContain('failing test output');
    expect(getHelperAgentPreset('test-triage').allowWrites).toBe(false);
  });

  it('summarizes routing metrics by tier and reason', () => {
    const summary = summarizeRoutingMetrics([
      { tier: 'small', model: 'tiny', success: true, escalated: false, reasons: ['bounded low-risk helper task'] },
      { tier: 'small', model: 'tiny', success: false, escalated: false, reasons: ['bounded low-risk helper task'] },
      { tier: 'strong', model: 'large', success: true, escalated: true, reasons: ['low helper confidence'] },
    ]);

    expect(summary).toMatchObject({ total: 3, success: 2, failure: 1, escalationRate: 0.333 });
    expect(summary.byTier.small).toMatchObject({ count: 2, successRate: 0.5 });
    expect(summary.topReasons[0]).toMatchObject({ reason: 'bounded low-risk helper task', count: 2 });
  });

  it('calibrates policy suggestions from failed small helper metrics', () => {
    const calibration = calibrateModelRoutingPolicy([
      { tier: 'small', model: 'tiny', success: false, escalated: false, reasons: ['bounded low-risk helper task'] },
      { tier: 'small', model: 'tiny', success: false, escalated: false, reasons: ['bounded low-risk helper task'] },
      { tier: 'small', model: 'tiny', success: true, escalated: false, reasons: ['bounded low-risk helper task'] },
    ], { confidenceEscalationThreshold: 0.45 });

    expect(calibration.suggestedPolicy).toMatchObject({ confidenceEscalationThreshold: 0.6, failureEscalationThreshold: 1 });
    expect(calibration.recommendations.join(' ')).toContain('Small helper success');
  });

  it('creates helper routing policy from registry model roles', () => {
    const policy = createModelRoutingPolicyFromRegistry([
      { model_name: 'llama3.1:8b', role: 'local.general', enabled: true },
      { model_name: 'qwen2.5-coder:7b', role: 'local.coder', enabled: true },
      { model_name: 'gpt-4.1', role: 'cloud.reasoner', enabled: true },
      { model_name: 'disabled-reviewer', role: 'cloud.reviewer', enabled: false },
    ]);

    expect(policy).toMatchObject({
      smallModel: 'llama3.1:8b',
      defaultModel: 'qwen2.5-coder:7b',
      strongModel: 'gpt-4.1',
      fallbackModel: 'llama3.1:8b',
    });
  });
});