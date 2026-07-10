import { SchedulerRegistry, type ManagedScheduler } from './schedulerRegistry';

function makeScheduler(name: string, opts: { stop?: jest.Mock; isRunning?: jest.Mock; restart?: jest.Mock } = {}): ManagedScheduler & { stop: jest.Mock; isRunning?: jest.Mock; restart?: jest.Mock } {
  const stop = opts.stop ?? jest.fn();
  const sched: ManagedScheduler & { stop: jest.Mock; isRunning?: jest.Mock; restart?: jest.Mock } = {
    name,
    stop,
  };
  if (opts.isRunning) sched.isRunning = opts.isRunning;
  if (opts.restart) sched.restart = opts.restart;
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
        { name: 'a', running: true, restartable: false },
        { name: 'b', running: true, restartable: false },
      ]);
    });

    it('uses isRunning() when provided', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { isRunning: jest.fn().mockReturnValue(false) }));
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: false }]);
    });

    it('swallows isRunning() errors and reports running: false', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { isRunning: jest.fn(() => { throw new Error('probe blew up'); }) }));
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: false }]);
    });

    it('replacing by name stops the previous instance synchronously', () => {
      const reg = new SchedulerRegistry();
      const oldStop = jest.fn();
      const replacementStop = jest.fn();
      reg.register(makeScheduler('a', { stop: oldStop }));
      reg.register(makeScheduler('a', { stop: replacementStop }));
      expect(oldStop).toHaveBeenCalledTimes(1);
      expect(reg.list()).toEqual([{ name: 'a', running: true, restartable: false }]);
    });

    it('replacement still wins even if the previous stop throws', () => {
      const reg = new SchedulerRegistry();
      const oldStop = jest.fn(() => { throw new Error('cleanup failed'); });
      const replacementStop = jest.fn();
      reg.register(makeScheduler('a', { stop: oldStop }));
      expect(() => reg.register(makeScheduler('a', { stop: replacementStop }))).not.toThrow();
      expect(reg.list()).toEqual([{ name: 'a', running: true, restartable: false }]);
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

  describe('restart', () => {
    it('returns null when the entry is missing', async () => {
      const reg = new SchedulerRegistry();
      await expect(reg.restart('missing')).resolves.toBeNull();
    });

    it('reports ok: false when the scheduler has no restart hook', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a'));
      const result = await reg.restart('a');
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/not restartable/);
    });

    it('calls restart() and reports ok: true on success', async () => {
      const reg = new SchedulerRegistry();
      const restart = jest.fn();
      reg.register(makeScheduler('a', { restart }));
      await expect(reg.restart('a')).resolves.toEqual({ name: 'a', ok: true });
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it('awaits async restart()', async () => {
      const reg = new SchedulerRegistry();
      let resolved = false;
      const restart = jest.fn(() => new Promise<void>((resolve) => {
        setTimeout(() => { resolved = true; resolve(); }, 5);
      }));
      reg.register(makeScheduler('a', { restart }));
      await reg.restart('a');
      expect(resolved).toBe(true);
    });

    it('reports ok: false with the error message when restart throws', async () => {
      const reg = new SchedulerRegistry();
      const restart = jest.fn(() => { throw new Error('reconfigure failed'); });
      reg.register(makeScheduler('a', { restart }));
      await expect(reg.restart('a')).resolves.toEqual({ name: 'a', ok: false, error: 'reconfigure failed' });
    });

    it('marks entries with a restart hook as restartable in list()', () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { restart: jest.fn() }));
      reg.register(makeScheduler('b'));
      expect(reg.list()).toEqual([
        { name: 'a', running: true, restartable: true },
        { name: 'b', running: true, restartable: false },
      ]);
    });

    it('reports ok: false when the hook runs but the scheduler does not re-register', async () => {
      // Mimics a configureX() whose enabled-guard is now false: it unregisters
      // the tombstone and early-returns without registering a live entry.
      const reg = new SchedulerRegistry();
      const restart = jest.fn(() => { reg.unregister('a'); });
      reg.register(makeScheduler('a', { stop: jest.fn(() => { reg.unregister('a'); }), restart }));
      await reg.stop('a');
      const result = await reg.restart('a');
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/did not start/);
    });

    it('reports ok: false when the hook leaves the entry registered but not running', async () => {
      const reg = new SchedulerRegistry();
      const restart = jest.fn();
      reg.register(makeScheduler('a', { restart, isRunning: jest.fn().mockReturnValue(false) }));
      const result = await reg.restart('a');
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/did not start/);
    });
  });

  describe('stop tombstones', () => {
    // Real schedulers unregister themselves inside stop() (their stopX() helper
    // clears the instance and calls unregister). A restartable one must still
    // leave an idle row so the UI can offer Start — see the tombstone logic.
    it('leaves an idle restartable tombstone when a restartable entry unregisters itself', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', {
        stop: jest.fn(() => { reg.unregister('a'); }),
        restart: jest.fn(),
      }));
      await reg.stop('a');
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: true }]);
    });

    it('does not leave a tombstone when the entry is not restartable', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { stop: jest.fn(() => { reg.unregister('a'); }) }));
      await reg.stop('a');
      expect(reg.list()).toEqual([]);
    });

    it('does not duplicate the entry when stop() leaves it registered', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { stop: jest.fn(), restart: jest.fn(), isRunning: jest.fn().mockReturnValue(false) }));
      await reg.stop('a');
      // stop() did not unregister, so the original entry stays — no tombstone added.
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: true }]);
    });

    it('restart() on a tombstone runs the hook and can re-register a live entry', async () => {
      const reg = new SchedulerRegistry();
      const restart = jest.fn(() => {
        // Mimics configureX(): unregister the tombstone, register a live entry.
        reg.unregister('a');
        reg.register(makeScheduler('a', { stop: jest.fn(() => { reg.unregister('a'); }), restart }));
      });
      reg.register(makeScheduler('a', { stop: jest.fn(() => { reg.unregister('a'); }), restart }));
      await reg.stop('a');
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: true }]);
      await reg.restart('a');
      expect(restart).toHaveBeenCalledTimes(1);
      expect(reg.list()).toEqual([{ name: 'a', running: true, restartable: true }]);
    });

    it('stopping a tombstone again is a no-op that keeps the row', async () => {
      const reg = new SchedulerRegistry();
      reg.register(makeScheduler('a', { stop: jest.fn(() => { reg.unregister('a'); }), restart: jest.fn() }));
      await reg.stop('a');
      await reg.stop('a');
      expect(reg.list()).toEqual([{ name: 'a', running: false, restartable: true }]);
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
