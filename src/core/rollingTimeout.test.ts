import { InactivityTimeoutError, withRollingTimeout, withTimeout } from './rollingTimeout';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('withTimeout', () => {
  it('resolves with the operation value when it settles before the deadline', async () => {
    await expect(withTimeout(200, Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rejects with InactivityTimeoutError when the operation exceeds the deadline', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(50, slow)).rejects.toBeInstanceOf(InactivityTimeoutError);
  });

  it('exposes the configured ms and kind on the timeout error', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    try {
      await withTimeout(40, slow);
      fail('expected timeout');
    } catch (e) {
      const err = e as InactivityTimeoutError;
      expect(err).toBeInstanceOf(InactivityTimeoutError);
      expect(err.inactivityMs).toBe(40);
      expect(err.kind).toBe('flat');
    }
  });

  it('propagates the operation rejection unchanged when it errors before the deadline', async () => {
    const boom = Promise.reject(new Error('inner'));
    await expect(withTimeout(200, boom)).rejects.toThrow('inner');
  });
});

describe('withRollingTimeout', () => {
  it('rejects with InactivityTimeoutError when no heartbeat fires within the budget', async () => {
    const promise = withRollingTimeout<string>(80, () => ({
      promise: new Promise<string>(() => { /* never settles, never heartbeats */ }),
    }));
    await expect(promise).rejects.toBeInstanceOf(InactivityTimeoutError);
  });

  it('does NOT fire when heartbeats arrive faster than the budget', async () => {
    let resolveOp!: (v: string) => void;
    const op = new Promise<string>((r) => { resolveOp = r; });
    const result = withRollingTimeout<string>(150, (heartbeat) => {
      // beat every 50ms for ~500ms, well under the 150ms budget but for
      // long enough that a flat 150ms timer would have fired several times
      const interval = setInterval(heartbeat, 50);
      setTimeout(() => { clearInterval(interval); resolveOp('done'); }, 500);
      return { promise: op, cleanup: () => clearInterval(interval) };
    });
    await expect(result).resolves.toBe('done');
  });

  it('runs cleanup on success', async () => {
    const cleanup = jest.fn();
    await withRollingTimeout<string>(200, (heartbeat) => {
      heartbeat();
      return { promise: Promise.resolve('ok'), cleanup };
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup on timeout', async () => {
    const cleanup = jest.fn();
    const promise = withRollingTimeout<string>(40, () => ({
      promise: new Promise<string>(() => { /* never */ }),
      cleanup,
    }));
    await expect(promise).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup on operation rejection', async () => {
    const cleanup = jest.fn();
    const promise = withRollingTimeout<string>(200, (heartbeat) => {
      heartbeat();
      return { promise: Promise.reject(new Error('inner')), cleanup };
    });
    await expect(promise).rejects.toThrow('inner');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not fire after the operation has already settled', async () => {
    const cleanup = jest.fn();
    await withRollingTimeout<string>(30, () => ({
      promise: Promise.resolve('ok'),
      cleanup,
    }));
    // Wait long enough that a stale timer would have fired.
    await sleep(80);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
