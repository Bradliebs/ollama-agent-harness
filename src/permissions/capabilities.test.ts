import { CAPABILITY_POLICIES, createCapabilityGrant, evaluateCapabilityGrant, evaluateCapabilityPolicy, findExpiredGrants, listActiveCapabilityGrants, listCapabilityPolicies, mapToolsToCapabilityCoverage, revokeCapabilityGrant, sanitizeCapabilityGrants, summarizeCapabilityAlignment } from './capabilities';

describe('capability policies', () => {
  it('covers every requested high-level capability surface', () => {
    expect(CAPABILITY_POLICIES.map((policy) => policy.id).sort()).toEqual([
      'arbitrary-shell',
      'auto-install-third-party-skills',
      'background-autonomous-jobs',
      'browser-profile-access',
      'calendar-editing',
      'desktop-control',
      'email-sending',
      'internet-skill-marketplace',
      'live-broker-trading',
      'multi-agent-swarm',
      'password-manager-access',
      'self-modifying-code',
    ].sort());
  });

  it('blocks or design-gates sensitive connector surfaces by default', () => {
    for (const id of ['password-manager-access', 'live-broker-trading', 'internet-skill-marketplace', 'desktop-control', 'email-sending', 'calendar-editing']) {
      const result = evaluateCapabilityPolicy({ capabilityId: id, explicitGrant: true, requestedControls: ['explicit-grant', 'audit-log', 'kill-switch'] });
      expect(result.decision).toBe('deny');
      expect(['blocked', 'design-only']).toContain(result.posture);
    }
  });

  it('requires explicit grants and all controls for gated capabilities', () => {
    const withoutGrant = evaluateCapabilityPolicy({ capabilityId: 'arbitrary-shell' });
    expect(withoutGrant).toMatchObject({ decision: 'ask' });
    expect(withoutGrant.missingControls).toEqual(expect.arrayContaining(['explicit-grant', 'audit-log', 'allowlist', 'kill-switch']));

    const allowed = evaluateCapabilityPolicy({
      capabilityId: 'arbitrary-shell',
      explicitGrant: true,
      requestedControls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
    });
    expect(allowed).toMatchObject({ decision: 'allow', missingControls: [] });
  });

  it('denies every capability while the kill switch is active', () => {
    const result = evaluateCapabilityPolicy({
      capabilityId: 'self-modifying-code',
      explicitGrant: true,
      requestedControls: ['explicit-grant', 'audit-log', 'dry-run', 'rollback', 'kill-switch'],
      killSwitchActive: true,
    });

    expect(result).toMatchObject({ decision: 'deny', reason: 'Kill switch active.' });
  });

  it('returns immutable policy copies and summary counts', () => {
    const policies = listCapabilityPolicies();
    policies[0].existingCoverage.push('mutated');

    expect(listCapabilityPolicies()[0].existingCoverage).not.toContain('mutated');
    expect(summarizeCapabilityAlignment()).toEqual(expect.objectContaining({ gated: 4, blocked: 3, 'design-only': 5 }));
  });

  it('maps existing builtin tool names to capability coverage', () => {
    const coverage = mapToolsToCapabilityCoverage();

    expect(coverage['arbitrary-shell']).toContain('bash');
    expect(coverage['self-modifying-code']).toEqual(expect.arrayContaining(['file_edit', 'file_write']));
  });

  it('creates time-limited grants only when gated capability controls are satisfied', () => {
    const granted = createCapabilityGrant({
      id: 'grant-shell',
      capabilityId: 'arbitrary-shell',
      controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
      expiresInMinutes: 30,
      now: new Date('2026-05-01T00:00:00.000Z'),
    });

    expect(granted.evaluation.decision).toBe('allow');
    expect(granted.grant).toMatchObject({ id: 'grant-shell', capabilityId: 'arbitrary-shell', expiresAt: '2026-05-01T00:30:00.000Z' });

    const blocked = createCapabilityGrant({
      id: 'grant-broker',
      capabilityId: 'live-broker-trading',
      controls: ['explicit-grant', 'time-limit', 'audit-log', 'dry-run', 'allowlist', 'human-confirmation', 'kill-switch'],
      now: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(blocked.grant).toBeUndefined();
    expect(blocked.evaluation).toMatchObject({ decision: 'deny', posture: 'blocked' });
  });

  it('evaluates active, expired, and revoked grants', () => {
    const created = createCapabilityGrant({
      id: 'grant-background',
      capabilityId: 'background-autonomous-jobs',
      controls: ['explicit-grant', 'time-limit', 'audit-log', 'allowlist', 'kill-switch'],
      expiresInMinutes: 10,
      now: new Date('2026-05-01T00:00:00.000Z'),
    }).grant;
    expect(created).toBeDefined();
    const grant = created!;

    expect(evaluateCapabilityGrant('background-autonomous-jobs', [grant], { now: new Date('2026-05-01T00:05:00.000Z') }).decision).toBe('allow');
    expect(evaluateCapabilityGrant('background-autonomous-jobs', [grant], { now: new Date('2026-05-01T00:11:00.000Z') }).decision).toBe('ask');
    expect(listActiveCapabilityGrants([grant], new Date('2026-05-01T00:05:00.000Z'))).toHaveLength(1);
    const revoked = revokeCapabilityGrant([grant], 'grant-background', new Date('2026-05-01T00:06:00.000Z'));
    expect(evaluateCapabilityGrant('background-autonomous-jobs', revoked, { now: new Date('2026-05-01T00:07:00.000Z') }).decision).toBe('ask');
  });

  it('sanitizes persisted grant records', () => {
    const grants = sanitizeCapabilityGrants([
      { id: 'valid', capabilityId: 'arbitrary-shell', controls: ['explicit-grant', 'bad-control'], reason: 'ok', grantedAt: '2026-05-01T00:00:00Z', expiresAt: '2026-05-01T01:00:00Z' },
      { id: 'bad', capabilityId: 'unknown', controls: [], grantedAt: 'bad', expiresAt: 'bad' },
    ]);

    expect(grants).toEqual([{ id: 'valid', capabilityId: 'arbitrary-shell', controls: ['explicit-grant'], reason: 'ok', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2026-05-01T01:00:00.000Z' }]);
  });

  it('finds grants that expired naturally without being revoked', () => {
    const active = { id: 'g1', capabilityId: 'arbitrary-shell', controls: ['explicit-grant'] as any[], reason: '', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2026-05-01T02:00:00.000Z' };
    const expired = { id: 'g2', capabilityId: 'background-autonomous-jobs', controls: ['explicit-grant'] as any[], reason: '', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2026-05-01T00:30:00.000Z' };
    const revoked = { id: 'g3', capabilityId: 'self-modifying-code', controls: ['explicit-grant'] as any[], reason: '', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2026-05-01T00:30:00.000Z', revokedAt: '2026-05-01T00:15:00.000Z' };

    const now = new Date('2026-05-01T01:00:00.000Z');
    const result = findExpiredGrants([active, expired, revoked], now);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g2');
  });
});
