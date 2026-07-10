import { TurnRetryState } from './turnRetryState';

describe('TurnRetryState', () => {
  it('tryFire returns true once, false thereafter', () => {
    const s = new TurnRetryState();
    expect(s.tryFire('compressedContext')).toBe(true);
    expect(s.tryFire('compressedContext')).toBe(false);
    expect(s.tryFire('compressedContext')).toBe(false);
  });

  it('flags are independent', () => {
    const s = new TurnRetryState();
    expect(s.tryFire('compressedContext')).toBe(true);
    expect(s.tryFire('falledBackModel')).toBe(true);
    expect(s.tryFire('rotatedCredential')).toBe(true);
    expect(s.tryFire('compressedContext')).toBe(false);
    expect(s.tryFire('falledBackModel')).toBe(false);
    expect(s.tryFire('rotatedCredential')).toBe(false);
  });

  it('hasFired reflects state without consuming a fire', () => {
    const s = new TurnRetryState();
    expect(s.hasFired('compressedContext')).toBe(false);
    s.tryFire('compressedContext');
    expect(s.hasFired('compressedContext')).toBe(true);
    // hasFired must not flip the flag (no double consumption).
    expect(s.hasFired('compressedContext')).toBe(true);
    expect(s.tryFire('compressedContext')).toBe(false);
  });

  it('separate states are independent', () => {
    const a = new TurnRetryState();
    const b = new TurnRetryState();
    expect(a.tryFire('compressedContext')).toBe(true);
    expect(b.tryFire('compressedContext')).toBe(true);
  });

  it('firedFlags reports fired entries', () => {
    const s = new TurnRetryState();
    s.tryFire('compressedContext');
    s.tryFire('rotatedCredential');
    const flags = s.firedFlags();
    expect(flags).toHaveLength(2);
    expect(flags).toContain('compressedContext');
    expect(flags).toContain('rotatedCredential');
  });

  it('reset clears all flags', () => {
    const s = new TurnRetryState();
    s.tryFire('compressedContext');
    s.tryFire('falledBackModel');
    s.reset();
    expect(s.firedFlags()).toHaveLength(0);
    expect(s.tryFire('compressedContext')).toBe(true);
  });
});
