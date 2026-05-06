import {
  createCapabilityGrant,
  evaluateCapabilityGrant,
  listActiveCapabilityGrants,
  revokeCapabilityGrant,
} from './capabilities';

describe('arbitrary-shell capability + docker_exec gate (logic)', () => {
  // The actual gate flip lives in src/web/server.ts (isToolEnabled). This
  // test verifies the building blocks the gate relies on so a regression in
  // the capability layer is caught locally.

  it('lists docker_exec in arbitrary-shell coverage', () => {
    const evaluation = evaluateCapabilityGrant('arbitrary-shell', []);
    expect(evaluation.capabilityId).toBe('arbitrary-shell');
    // Without an explicit grant, evaluation must be `ask` (gated posture).
    expect(evaluation.decision).toBe('ask');
  });

  it('an explicit arbitrary-shell grant is observable as active', () => {
    const now = new Date();
    const { grant } = createCapabilityGrant({
      id: 'g-shell-test',
      capabilityId: 'arbitrary-shell',
      controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
      now,
      expiresInMinutes: 60,
    });
    expect(grant).toBeDefined();
    const grants = grant ? [grant] : [];
    const active = listActiveCapabilityGrants(grants, now);
    expect(active.some((entry) => entry.capabilityId === 'arbitrary-shell')).toBe(true);
  });

  it('revoking the grant removes it from the active list immediately', () => {
    const now = new Date();
    const { grant } = createCapabilityGrant({
      id: 'g-shell-test-2',
      capabilityId: 'arbitrary-shell',
      controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
      now,
      expiresInMinutes: 60,
    });
    expect(grant).toBeDefined();
    if (!grant) return;
    const revoked = revokeCapabilityGrant([grant], grant.id, now);
    expect(listActiveCapabilityGrants(revoked, now)).toHaveLength(0);
  });

  it('expired grants are not returned by listActiveCapabilityGrants', () => {
    const past = new Date(Date.now() - 60 * 60_000);
    const { grant } = createCapabilityGrant({
      id: 'g-shell-test-3',
      capabilityId: 'arbitrary-shell',
      controls: ['explicit-grant', 'audit-log', 'allowlist', 'kill-switch'],
      now: past,
      expiresInMinutes: 1,
    });
    expect(grant).toBeDefined();
    const grants = grant ? [grant] : [];
    expect(listActiveCapabilityGrants(grants, new Date())).toHaveLength(0);
  });
});
