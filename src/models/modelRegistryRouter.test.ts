import { ModelRegistry, BUILTIN_MODEL_REGISTRY } from './modelRegistry';
import { ModelRouter } from './modelRouter';

describe('modelRegistry', () => {
  it('creates registry with builtin models', () => {
    const registry = new ModelRegistry();
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it('finds models by role', () => {
    const registry = new ModelRegistry();
    const generals = registry.byRole('local.general');
    expect(generals.length).toBeGreaterThan(0);
    expect(generals[0].role).toBe('local.general');
  });

  it('bestForRole returns the cheapest enabled model', () => {
    const registry = new ModelRegistry();
    const best = registry.bestForRole('local.general');
    expect(best).toBeDefined();
    expect(best!.cost_level).toBe('free');
  });

  it('returns undefined for unavailable roles', () => {
    const registry = new ModelRegistry([]);
    expect(registry.bestForRole('cloud.reasoner')).toBeUndefined();
  });

  it('lists local and cloud models separately', () => {
    const registry = new ModelRegistry();
    const local = registry.localModels();
    const cloud = registry.cloudModels();
    expect(local.length).toBeGreaterThan(0);
    for (const m of local) expect(m.privacy_level).toBe('local');
    // Cloud models are disabled by default, so may be empty
    for (const m of cloud) expect(m.privacy_level).not.toBe('local');
  });

  it('serializes and deserializes via manifest', () => {
    const registry = new ModelRegistry();
    const manifest = registry.toManifest();
    expect(manifest.version).toBe(1);
    const restored = ModelRegistry.fromManifest(manifest);
    expect(restored.list().length).toBe(registry.list().length);
  });

  it('registers and removes models', () => {
    const registry = new ModelRegistry([]);
    registry.register(BUILTIN_MODEL_REGISTRY[0]);
    expect(registry.list().length).toBe(1);
    registry.remove(BUILTIN_MODEL_REGISTRY[0].id);
    expect(registry.list().length).toBe(0);
  });
});

describe('modelRouter', () => {
  it('selects local general model for classification', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const result = router.route('classification');
    expect(result.model).toBeDefined();
    expect(result.model!.role).toBe('local.general');
  });

  it('selects local coder model for code editing', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const result = router.route('code_edit');
    expect(result.model).toBeDefined();
    expect(result.model!.role).toBe('local.coder');
  });

  it('selects local embedder for embedding', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const result = router.route('embedding');
    expect(result.model).toBeDefined();
    expect(result.model!.role).toBe('local.embedder');
  });

  it('selects cloud reasoner for architecture when available', () => {
    const registry = new ModelRegistry();
    // Enable cloud model
    const gpt = registry.get('gpt-4.1')!;
    gpt.enabled = true;
    registry.register(gpt);
    const router = new ModelRouter(registry);
    const result = router.route('architecture');
    expect(result.model!.role).toBe('cloud.reasoner');
  });

  it('falls back to local when no cloud models are enabled', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const result = router.route('architecture');
    // Should fall back to a local model
    expect(result.model).toBeDefined();
    expect(result.fallback).toBe(true);
  });

  it('routeLocal prefers local models', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const result = router.routeLocal('classification');
    expect(result.model!.privacy_level).toBe('local');
  });

  it('shouldEscalateToCloud returns false when no cloud models available', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    expect(router.shouldEscalateToCloud('architecture')).toBe(false);
  });

  it('shouldEscalateToCloud returns true for complex tasks with cloud models', () => {
    const registry = new ModelRegistry();
    const gpt = registry.get('gpt-4.1')!;
    gpt.enabled = true;
    registry.register(gpt);
    const router = new ModelRouter(registry);
    expect(router.shouldEscalateToCloud('architecture')).toBe(true);
  });

  it('produces explain output', () => {
    const registry = new ModelRegistry();
    const router = new ModelRouter(registry);
    const explanation = router.explain('classification');
    expect(explanation).toContain('classification');
    expect(explanation).toContain('local');
  });
});
