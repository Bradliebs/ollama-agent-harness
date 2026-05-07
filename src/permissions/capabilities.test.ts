import { CAPABILITY_POLICIES, commandMatchesGrantAllowlist, createCapabilityGrant, evaluateCapabilityGrant, evaluateCapabilityPolicy, findExpiredGrants, listActiveCapabilityGrants, listCapabilityPolicies, mapToolsToCapabilityCoverage, revokeCapabilityGrant, sanitizeCapabilityGrants, summarizeCapabilityAlignment } from './capabilities';

describe('capability policies', () => {
  it('covers every requested high-level capability surface', () => {
    expect(CAPABILITY_POLICIES.map((policy) => policy.id).sort()).toEqual([
      'arbitrary-shell',
      'auto-install-third-party-skills',
      'background-autonomous-jobs',
      'browser-page-access',
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
    for (const id of ['password-manager-access', 'live-broker-trading', 'internet-skill-marketplace']) {
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
    expect(summarizeCapabilityAlignment()).toEqual(expect.objectContaining({ gated: 10, blocked: 3, 'design-only': 0 }));
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

  describe('commandAllowlist on capability grants', () => {
    const baseGrant = {
      capabilityId: 'arbitrary-shell',
      controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'] as any[],
      reason: 'Operator-approved daily brief script.',
      now: new Date('2026-05-06T00:00:00.000Z'),
    };

    it('persists a sanitized commandAllowlist when valid regex sources are provided', () => {
      const { grant } = createCapabilityGrant({
        ...baseGrant,
        id: 'g-allowlist',
        expiresInMinutes: 60,
        commandAllowlist: [
          '^cmd /c "cd /d C:\\\\AI\\\\Oracle\\\\Trading && python.*daily_advisor\\.py.*"$',
          '^echo hello$',
          '   ',
          'duplicate',
          'duplicate',
          '(unbalanced',
        ],
      });
      expect(grant?.commandAllowlist).toEqual([
        '^cmd /c "cd /d C:\\\\AI\\\\Oracle\\\\Trading && python.*daily_advisor\\.py.*"$',
        '^echo hello$',
        'duplicate',
      ]);
    });

    it('round-trips commandAllowlist through sanitizeCapabilityGrants', () => {
      const stored = [{
        id: 'g-rt',
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant'],
        reason: '',
        grantedAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-01T01:00:00.000Z',
        commandAllowlist: ['^echo hi$', '(broken', 42, ''],
      }];
      const [sanitized] = sanitizeCapabilityGrants(stored);
      expect(sanitized.commandAllowlist).toEqual(['^echo hi$']);
    });

    it('omits commandAllowlist field entirely when no valid entries remain', () => {
      const stored = [{
        id: 'g-empty',
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant'],
        reason: '',
        grantedAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-05-01T01:00:00.000Z',
        commandAllowlist: ['(broken', 42, ''],
      }];
      const [sanitized] = sanitizeCapabilityGrants(stored);
      expect(sanitized.commandAllowlist).toBeUndefined();
    });

    it('matches a command against an active grant allowlist and surfaces the matching grant', () => {
      const { grant } = createCapabilityGrant({
        ...baseGrant,
        id: 'g-match',
        expiresInMinutes: 120,
        commandAllowlist: ['^python\\s+daily_advisor\\.py\\s+--mode\\s+(morning|midday|evening)$'],
      });
      const result = commandMatchesGrantAllowlist(
        'arbitrary-shell',
        [grant!],
        'python daily_advisor.py --mode morning',
        new Date('2026-05-06T00:30:00.000Z'),
      );
      expect(result.matched).toBe(true);
      expect(result.grantId).toBe('g-match');
    });

    it('does not match when the grant is expired', () => {
      const { grant } = createCapabilityGrant({
        ...baseGrant,
        id: 'g-expired',
        expiresInMinutes: 1,
        commandAllowlist: ['^python anything$'],
      });
      const result = commandMatchesGrantAllowlist(
        'arbitrary-shell',
        [grant!],
        'python anything',
        new Date('2026-05-06T01:00:00.000Z'), // 1 hour later, definitely expired
      );
      expect(result.matched).toBe(false);
    });

    it('does not match when the grant is for a different capability', () => {
      const { grant } = createCapabilityGrant({
        capabilityId: 'background-autonomous-jobs',
        controls: ['explicit-grant', 'audit-log', 'kill-switch'],
        reason: 'unrelated',
        now: baseGrant.now,
        id: 'g-wrong-cap',
        expiresInMinutes: 60,
        commandAllowlist: ['^python anything$'],
      });
      // Even when the grant carries a commandAllowlist, it must be tied
      // to the arbitrary-shell capability for the runner to admit shell
      // commands. Cross-capability leakage would be a privilege bypass.
      const result = commandMatchesGrantAllowlist('arbitrary-shell', grant ? [grant] : [], 'python anything', baseGrant.now);
      expect(result.matched).toBe(false);
    });

    it('returns no-match for an empty command', () => {
      const { grant } = createCapabilityGrant({
        ...baseGrant,
        id: 'g-empty-cmd',
        expiresInMinutes: 60,
        commandAllowlist: ['.*'],
      });
      const result = commandMatchesGrantAllowlist('arbitrary-shell', [grant!], '   ', baseGrant.now);
      expect(result.matched).toBe(false);
    });

    it('honours requested expiry beyond 24h when the grant carries a commandAllowlist', () => {
      const oneWeekMinutes = 7 * 24 * 60;
      const { grant } = createCapabilityGrant({
        ...baseGrant,
        id: 'g-long',
        expiresInMinutes: oneWeekMinutes,
        commandAllowlist: ['^echo hi$'],
      });
      const elapsed = Date.parse(grant!.expiresAt) - Date.parse(grant!.grantedAt);
      // Grants WITHOUT a commandAllowlist are still capped at 24h. A
      // grant with an allowlist may live up to 1 year (525,600 minutes)
      // because the allowlist itself is the security bound.
      expect(elapsed).toBe(oneWeekMinutes * 60_000);
    });

    it('still caps grants without commandAllowlist at 24h', () => {
      const oneWeekMinutes = 7 * 24 * 60;
      const { grant } = createCapabilityGrant({
        capabilityId: 'arbitrary-shell',
        controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
        reason: 'open-ended',
        now: baseGrant.now,
        id: 'g-no-allowlist',
        expiresInMinutes: oneWeekMinutes,
      });
      const elapsed = Date.parse(grant!.expiresAt) - Date.parse(grant!.grantedAt);
      expect(elapsed).toBe(24 * 60 * 60_000);
    });
  });
});
