import { createDefaultCapabilityRegistry } from './capabilityRegistry';
import { BUILTIN_CAPABILITY_TEMPLATES, evaluateCapabilityTemplate, evaluateCapabilityTemplates } from './capabilityTemplates';

describe('capabilityTemplates', () => {
  it('marks local document templates ready when required local capabilities exist', () => {
    const registry = createDefaultCapabilityRegistry();
    const meeting = BUILTIN_CAPABILITY_TEMPLATES.find((template) => template.id === 'meeting-notes-actions')!;

    const result = evaluateCapabilityTemplate(registry, {}, meeting);

    expect(result.status).toBe('ready');
    expect(result.readinessScore).toBe(100);
    expect(result.missingCapabilities).toEqual([]);
  });

  it('reports missing capabilities and connectors for morning brief', () => {
    const registry = createDefaultCapabilityRegistry();
    const morningBrief = BUILTIN_CAPABILITY_TEMPLATES.find((template) => template.id === 'morning-brief')!;

    const result = evaluateCapabilityTemplate(registry, {}, morningBrief);

    expect(result.status).toBe('blocked');
    expect(result.missingCapabilities).toEqual(expect.arrayContaining(['Email sending', 'Calendar integration', 'Telegram messaging']));
    expect(result.missingConnectors).toEqual(expect.arrayContaining(['google', 'telegram']));
    expect(result.nextAction).toBe('Enable Email sending.');
  });

  it('counts configured required connectors toward readiness', () => {
    const registry = createDefaultCapabilityRegistry();
    registry.register('telegram', 'Telegram messaging', 'available');
    const morningBrief = BUILTIN_CAPABILITY_TEMPLATES.find((template) => template.id === 'morning-brief')!;

    const result = evaluateCapabilityTemplate(registry, {
      telegram: { connector: 'telegram', configured: true, running: true, hasAllowedChatIds: true },
    }, morningBrief);

    expect(result.readyConnectors).toContain('telegram');
    expect(result.missingConnectors).toContain('google');
  });

  it('returns the built-in high-priority catalog in stable order', () => {
    const registry = createDefaultCapabilityRegistry();

    const results = evaluateCapabilityTemplates(registry);

    expect(results.map((template) => template.id)).toEqual([
      'morning-brief',
      'meeting-notes-actions',
      'automated-pr-review',
      'dependency-vulnerability-scan',
      'content-repurpose',
      'second-brain',
    ]);
  });
});

