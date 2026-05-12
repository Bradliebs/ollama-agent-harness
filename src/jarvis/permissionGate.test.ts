import { evaluatePermissionGate, shouldDeferToEngine } from './permissionGate';
import type { TrustLadderSnapshot } from './trustLadder';

function snap(rung: number): TrustLadderSnapshot {
  return {
    capabilities: { x: { capability: 'x', rung: rung as 0 | 1 | 2 | 3 | 4, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: Number.MAX_SAFE_INTEGER } },
    updatedAt: new Date().toISOString(),
  };
}

describe('permission gate', () => {
  it('rung 0 → shadow', () => {
    expect(evaluatePermissionGate(snap(0), { capability: 'x' }).decision).toBe('shadow');
  });

  it('rung 1 → suggest', () => {
    expect(evaluatePermissionGate(snap(1), { capability: 'x' }).decision).toBe('suggest');
  });

  it('rung 2 → allow (defer to engine)', () => {
    const result = evaluatePermissionGate(snap(2), { capability: 'x' });
    expect(result.decision).toBe('allow');
    expect(shouldDeferToEngine(result)).toBe(true);
  });

  it('rung 3 → confirm', () => {
    expect(evaluatePermissionGate(snap(3), { capability: 'x' }).decision).toBe('confirm');
  });

  it('rung 4 → allow (autonomous)', () => {
    const result = evaluatePermissionGate(snap(4), { capability: 'x' });
    expect(result.decision).toBe('allow');
    expect(result.rationale).toMatch(/autonomous/i);
  });

  it('unknown capability defaults to allow (rung 2)', () => {
    const empty: TrustLadderSnapshot = { capabilities: {}, updatedAt: '' };
    expect(evaluatePermissionGate(empty, { capability: 'unknown' }).decision).toBe('allow');
  });
});
