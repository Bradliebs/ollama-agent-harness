import { SandboxSwitch } from './sandboxSwitch';

describe('SandboxSwitch', () => {
  it('starts disengaged', () => {
    const sb = new SandboxSwitch();
    expect(sb.isActive()).toBe(false);
    expect(sb.getReason()).toBe('');
    expect(sb.snapshot()).toEqual({ active: false, reason: '' });
  });

  it('engages with a custom reason and reports active', () => {
    const sb = new SandboxSwitch();
    sb.engage('auto-engaged for autonomy');
    expect(sb.isActive()).toBe(true);
    expect(sb.getReason()).toBe('auto-engaged for autonomy');
  });

  it('engage with empty/whitespace reason falls back to default', () => {
    const sb = new SandboxSwitch();
    sb.engage('   ');
    expect(sb.getReason()).toBe('Sandbox engaged.');
  });

  it('release clears state', () => {
    const sb = new SandboxSwitch();
    sb.engage('lockdown');
    sb.release();
    expect(sb.isActive()).toBe(false);
    expect(sb.getReason()).toBe('');
  });

  it('restore() does not fire listeners (startup-only)', () => {
    const sb = new SandboxSwitch();
    const listener = jest.fn();
    sb.onChange(listener);
    sb.restore({ active: true, reason: 'persisted sandbox' });
    expect(sb.isActive()).toBe(true);
    expect(sb.getReason()).toBe('persisted sandbox');
    expect(listener).not.toHaveBeenCalled();
  });

  it('restore() with active=false clears reason regardless of input', () => {
    const sb = new SandboxSwitch();
    sb.restore({ active: false, reason: 'leftover text' });
    expect(sb.getReason()).toBe('');
  });

  it('restore() defaults reason when active but reason missing', () => {
    const sb = new SandboxSwitch();
    sb.restore({ active: true });
    expect(sb.isActive()).toBe(true);
    expect(sb.getReason()).toBe('Sandbox restored from saved state.');
  });

  it('snapshot returns a defensive copy', () => {
    const sb = new SandboxSwitch();
    sb.engage('lockdown');
    const snap = sb.snapshot();
    snap.active = false;
    snap.reason = 'tampered';
    expect(sb.isActive()).toBe(true);
    expect(sb.getReason()).toBe('lockdown');
  });

  it('listeners fire on engage and release', () => {
    const sb = new SandboxSwitch();
    const listener = jest.fn();
    sb.onChange(listener);
    sb.engage('on');
    sb.release();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { active: true, reason: 'on' });
    expect(listener).toHaveBeenNthCalledWith(2, { active: false, reason: '' });
  });

  it('unsubscribe stops further notifications', () => {
    const sb = new SandboxSwitch();
    const listener = jest.fn();
    const off = sb.onChange(listener);
    sb.engage('first');
    off();
    sb.release();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a crashing listener does not break the switch or other listeners', () => {
    const sb = new SandboxSwitch();
    const good = jest.fn();
    sb.onChange(() => { throw new Error('listener boom'); });
    sb.onChange(good);
    expect(() => sb.engage('safe')).not.toThrow();
    expect(sb.isActive()).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
