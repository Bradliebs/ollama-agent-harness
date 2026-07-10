import { assessMarginalCost, classifyModelLocality, summarizeRunCost } from './costProvenance';
import { type ModelRegistryEntry } from '../models/modelRegistry';

function entry(overrides: Partial<ModelRegistryEntry> & Pick<ModelRegistryEntry, 'id' | 'model_name' | 'provider'>): ModelRegistryEntry {
  return {
    role: 'local.general',
    strengths: [],
    weaknesses: [],
    cost_level: 'free',
    privacy_level: 'local',
    speed_level: 'fast',
    max_context: 8192,
    supports_json: true,
    supports_tools: false,
    default_temperature: 0.3,
    enabled: true,
    ...overrides,
  };
}

describe('classifyModelLocality', () => {
  it('classifies a built-in Ollama model as local', () => {
    expect(classifyModelLocality('llama3.1:8b')).toBe('local');
  });

  it('classifies a built-in cloud model as cloud', () => {
    expect(classifyModelLocality('gpt-4.1')).toBe('cloud');
  });

  it('returns unknown for a model not in the registry rather than assuming local', () => {
    expect(classifyModelLocality('mystery-model:99b')).toBe('unknown');
  });

  it('matches by model_name and is case-insensitive', () => {
    const entries = [entry({ id: 'cloud-x', model_name: 'Cloud-X-Turbo', provider: 'openai', privacy_level: 'public_cloud' })];
    expect(classifyModelLocality('cloud-x-turbo', entries)).toBe('cloud');
  });

  it('treats privacy_level local as local even for a non-ollama provider', () => {
    const entries = [entry({ id: 'edge', model_name: 'edge', provider: 'vllm', privacy_level: 'local' })];
    expect(classifyModelLocality('edge', entries)).toBe('local');
  });
});

describe('assessMarginalCost', () => {
  it('claims $0 marginal only when provably local', () => {
    const v = assessMarginalCost('llama3.1:8b');
    expect(v.locality).toBe('local');
    expect(v.freeMarginal).toBe(true);
    expect(v.marginalCostUsd).toBe(0);
  });

  it('reports cloud locality with an unknown (null) dollar amount, never a fabricated price', () => {
    const v = assessMarginalCost('gpt-4.1');
    expect(v.locality).toBe('cloud');
    expect(v.freeMarginal).toBe(false);
    expect(v.marginalCostUsd).toBeNull();
    expect(v.reason).toContain('openai');
  });

  it('does not claim $0 for an unknown model', () => {
    const v = assessMarginalCost('mystery-model:99b');
    expect(v.locality).toBe('unknown');
    expect(v.freeMarginal).toBe(false);
    expect(v.marginalCostUsd).toBeNull();
  });
});

describe('summarizeRunCost', () => {
  it('claims a $0 all-local run only when every call is provably local', () => {
    const s = summarizeRunCost([
      { locality: 'local', promptTokens: 100, completionTokens: 50 },
      { locality: 'local', promptTokens: 20, completionTokens: 30 },
    ]);
    expect(s.calls).toBe(2);
    expect(s.totalTokens).toBe(200);
    expect(s.locality).toBe('local');
    expect(s.freeMarginal).toBe(true);
    expect(s.marginalCostUsd).toBe(0);
  });

  it('treats a run as billed when any call is cloud, with an untracked (null) amount', () => {
    const s = summarizeRunCost([
      { locality: 'local', promptTokens: 100, completionTokens: 50 },
      { locality: 'cloud', promptTokens: 200, completionTokens: 80 },
    ]);
    expect(s.locality).toBe('cloud');
    expect(s.freeMarginal).toBe(false);
    expect(s.marginalCostUsd).toBeNull();
    expect(s.reason).toContain('1 of 2');
  });

  it('stays unknown (not $0) when a call has unprovable locality and none is cloud', () => {
    const s = summarizeRunCost([
      { locality: 'local', promptTokens: 100, completionTokens: 50 },
      { locality: 'unknown', promptTokens: 10, completionTokens: 5 },
    ]);
    expect(s.locality).toBe('unknown');
    expect(s.freeMarginal).toBe(false);
    expect(s.marginalCostUsd).toBeNull();
  });

  it('returns a safe non-free default for an empty run', () => {
    const s = summarizeRunCost([]);
    expect(s.calls).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.freeMarginal).toBe(false);
    expect(s.marginalCostUsd).toBeNull();
  });
});
