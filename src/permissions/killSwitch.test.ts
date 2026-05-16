import { KillSwitch } from './killSwitch';

describe('KillSwitch', () => {
  it('starts disengaged', () => {
    const ks = new KillSwitch();
    expect(ks.isActive()).toBe(false);
    expect(ks.getReason()).toBe('');
    expect(ks.snapshot()).toEqual({ active: false, reason: '' });
  });

  it('engages with a custom reason and reports active', () => {
    const ks = new KillSwitch();
    ks.engage('manual stop');
    expect(ks.isActive()).toBe(true);
    expect(ks.getReason()).toBe('manual stop');
  });

  it('engage with empty/whitespace reason falls back to default', () => {
    const ks = new KillSwitch();
    ks.engage('   ');
    expect(ks.getReason()).toBe('Kill switch engaged.');
  });

  it('release clears state', () => {
    const ks = new KillSwitch();
    ks.engage('halt');
    ks.release();
    expect(ks.isActive()).toBe(false);
    expect(ks.getReason()).toBe('');
  });

  it('restore() does not fire listeners (startup-only)', () => {
    const ks = new KillSwitch();
    const listener = jest.fn();
    ks.onChange(listener);
    ks.restore({ active: true, reason: 'persisted halt' });
    expect(ks.isActive()).toBe(true);
    expect(ks.getReason()).toBe('persisted halt');
    expect(listener).not.toHaveBeenCalled();
  });

  it('restore() with active=false clears reason regardless of input', () => {
    const ks = new KillSwitch();
    ks.restore({ active: false, reason: 'leftover text' });
    expect(ks.getReason()).toBe('');
  });

  it('restore() defaults reason when active but reason missing', () => {
    const ks = new KillSwitch();
    ks.restore({ active: true });
    expect(ks.isActive()).toBe(true);
    expect(ks.getReason()).toBe('Kill switch restored from saved state.');
  });

  it('snapshot returns a defensive copy', () => {
    const ks = new KillSwitch();
    ks.engage('halt');
    const snap = ks.snapshot();
    snap.active = false;
    snap.reason = 'tampered';
    expect(ks.isActive()).toBe(true);
    expect(ks.getReason()).toBe('halt');
  });

  it('listeners fire on engage and release', () => {
    const ks = new KillSwitch();
    const listener = jest.fn();
    ks.onChange(listener);
    ks.engage('halt');
    ks.release();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { active: true, reason: 'halt' });
    expect(listener).toHaveBeenNthCalledWith(2, { active: false, reason: '' });
  });

  it('unsubscribe stops further notifications', () => {
    const ks = new KillSwitch();
    const listener = jest.fn();
    const off = ks.onChange(listener);
    ks.engage('first');
    off();
    ks.release();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listener crash does not break the switch or sibling listeners', () => {
    const ks = new KillSwitch();
    const crashing = jest.fn(() => { throw new Error('boom'); });
    const sibling = jest.fn();
    ks.onChange(crashing);
    ks.onChange(sibling);
    expect(() => ks.engage('halt')).not.toThrow();
    expect(ks.isActive()).toBe(true);
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('reason is capped at 500 chars on restore', () => {
    const ks = new KillSwitch();
    const long = 'x'.repeat(2000);
    ks.restore({ active: true, reason: long });
    expect(ks.getReason().length).toBe(500);
  });
});
