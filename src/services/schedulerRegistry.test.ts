import { SchedulerRegistry, type ManagedScheduler } from './schedulerRegistry';

function makeScheduler(name: string, opts: { stop?: jest.Mock; isRunning?: jest.Mock } = {}): ManagedScheduler & { stop: jest.Mock; isRunning?: jest.Mock } {
  const stop = opts.stop ?? jest.fn();
  const sched: ManagedScheduler & { stop: jest.Mock; isRunning?: jest.Mock } = {
    name,
    stop,
  };
  if (opts.isRunning) sched.isRunning = opts.isRunning;
  return sched;
}

describe('SchedulerRegistry', () => {
  describe('register', () => {
    it('rejects entries without a name', () => {
      const reg = new SchedulerRegistry();
      expect(() => reg.register({ name: '', stop: () => undefined } as ManagedScheduler)).toThrow();
    });

    it('lists every registered scheduler', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a'));
      reg.register(makeScheduler('b'));
      expect(reg.list()).toEqual([
        { name: 'a', running: true },
        { name: 'b', running: true },
      ]);
    });

    it('uses isRunning() when provided', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { isRunning: jest.fn().mockReturnValue(false) }));
      expect(reg.list()).toEqual([{ name: 'a', running: false }]);
    });

    it('swallows isRunning() errors and reports running: false', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { isRunning: jest.fn(() => { throw new Error('probe blew up'); }) }));
      expect(reg.list()).toEqual([{ name: 'a', running: false }]);
    });

    it('replacing by name stops the previous instance synchronously', () => {
      const reg = new SchedulerRegistry();
      const oldStop = jest.fn();
      const replacementStop = jest.fn();
      reg.register(makeScheduler('a', { stop: oldStop }));
      reg.register(makeScheduler('a', { stop: replacementStop }));
      expect(oldStop).toHaveBeenCalledTimes(1);
      expect(reg.list()).toEqual([{ name: 'a', running: true }]);
    });

    it('replacement still wins even if the previous stop throws', () => {
      const reg = new SchedulerRegistry();
      const oldStop = jest.fn(() => { throw new Error('cleanup failed'); });
      const replacementStop = jest.fn();
      reg.register(makeScheduler('a', { stop: oldStop }));
      expect(() => reg.register(makeScheduler('a', { stop: replacementStop }))).not.toThrow();
      expect(reg.list()).toEqual([{ name: 'a', running: true }]);
    });
  });

  describe('unregister', () => {
    it('removes the entry without stopping it', () => {
      const reg = new SchedulerRegistry();
      const stop = jest.fn();
      reg.register(makeScheduler('a', { stop }));
      expect(reg.unregister('a')).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      expect(reg.list()).toEqual([]);
    });

    it('returns false when the entry does not exist', () => {
      const reg = new SchedulerRegistry();
      expect(reg.unregister('missing')).toBe(false);
    });
  });

  describe('stop', () => {
    it('returns null when the entry is missing', async () => {
      const reg = new SchedulerRegistry();
      await expect(reg.stop('missing')).resolves.toBeNull();
    });

    it('calls stop and reports ok: true on success', async () => {
      const reg = new SchedulerRegistry();
      const stop = jest.fn();
      reg.register(makeScheduler('a', { stop }));
      await expect(reg.stop('a')).resolves.toEqual({ name: 'a', ok: true });
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('awaits async stop()', async () => {
      const reg = new SchedulerRegistry();
      let resolved = false;
      const stop = jest.fn(() => new Promise<void>((resolve) => {
        setTimeout(() => { resolved = true; resolve(); }, 5);
      }));
      reg.register(makeScheduler('a', { stop }));
      await reg.stop('a');
      expect(resolved).toBe(true);
    });

    it('reports ok: false with the error message when stop throws', async () => {
      const reg = new SchedulerRegistry();
      const stop = jest.fn(() => { throw new Error('boom'); });
      reg.register(makeScheduler('a', { stop }));
      await expect(reg.stop('a')).resolves.toEqual({ name: 'a', ok: false, error: 'boom' });
    });
  });

  describe('stopAll', () => {
    it('stops every scheduler in reverse-registration order', async () => {
      const reg = new SchedulerRegistry();
      const order: string[] = [];
      reg.register(makeScheduler('a', { stop: jest.fn(() => { order.push('a'); }) }));
      reg.register(makeScheduler('b', { stop: jest.fn(() => { order.push('b'); }) }));
      reg.register(makeScheduler('c', { stop: jest.fn(() => { order.push('c'); }) }));
      const results = await reg.stopAll();
      expect(order).toEqual(['c', 'b', 'a']);
      expect(results.map((r) => r.name)).toEqual(['c', 'b', 'a']);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('isolates failures — one bad stop does not block the rest', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a'));
      reg.register(makeScheduler('b', { stop: jest.fn(() => { throw new Error('b broke'); }) }));
      reg.register(makeScheduler('c'));
      const results = await reg.stopAll();
      const byName = Object.fromEntries(results.map((r) => [r.name, r]));
      expect(byName.a.ok).toBe(true);
      expect(byName.b.ok).toBe(false);
      expect(byName.b.error).toBe('b broke');
      expect(byName.c.ok).toBe(true);
    });

    it('safely iterates when an entry unregisters siblings during stop', async () => {
      const reg = new SchedulerRegistry();
      const aStop = jest.fn();
      reg.register(makeScheduler('a', { stop: aStop }));
      reg.register(makeScheduler('b', {
        stop: jest.fn(() => { reg.unregister('a'); }),
      }));
      const results = await reg.stopAll();
      // 'b' stops first (reverse order); during its stop it removes 'a'.
      // The snapshot still holds a reference to a, so a.stop is still called.
      expect(results.map((r) => r.name)).toEqual(['b', 'a']);
      expect(aStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('clear', () => {
    it('drops all registrations without stopping', () => {
      const reg = new SchedulerRegistry();
      const stop = jest.fn();
      reg.register(makeScheduler('a', { stop }));
      reg.clear();
      expect(reg.list()).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
    });
  });
});
