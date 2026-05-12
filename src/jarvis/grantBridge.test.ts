import { applyGrantToLadder } from './grantBridge';
import type { TrustLadderSnapshot } from './trustLadder';

function snap(): TrustLadderSnapshot { return { capabilities: {}, updatedAt: new Date().toISOString() }; }

describe('grant bridge', () => {
  it('records a create as an acceptance', () => {
    const s = snap();
    const result = applyGrantToLadder(s, 'arbitrary-shell', 'create');
    expect(s.capabilities['arbitrary-shell'].acceptedStreak).toBe(1);
    expect(result.rung).toBe(2);
  });

  it('records a revoke as a rejection', () => {
    const s = snap();
    const result = applyGrantToLadder(s, 'arbitrary-shell', 'revoke');
    expect(s.capabilities['arbitrary-shell'].rejectedStreak).toBe(1);
    expect(result.rung).toBe(2);
  });

  it('promotes after 5 creates', () => {
    const s = snap();
    let rung = 0;
    for (let i = 0; i < 5; i++) rung = applyGrantToLadder(s, 'web', 'create').rung;
    expect(rung).toBe(3);
  });

  it('demotes after 2 revokes from rung 3', () => {
    const s: TrustLadderSnapshot = { capabilities: { x: { capability: 'x', rung: 3, acceptedStreak: 0, rejectedStreak: 0, decayAfterMs: 999_999_999 } }, updatedAt: '' };
    applyGrantToLadder(s, 'x', 'revoke');
    const result = applyGrantToLadder(s, 'x', 'revoke');
    expect(result.demoted).toBe(2);
  });
});
