import {
  abortRun,
  isRunning,
  listRunning,
  registerRun,
  unregisterRun,
  _resetRunRegistryForTest,
} from './runRegistry';

describe('goal/runRegistry', () => {
  beforeEach(() => { _resetRunRegistryForTest(); });
  afterEach(() => { _resetRunRegistryForTest(); });

  it('registers a run and returns an AbortController', () => {
    const abort = registerRun('g1');
    expect(abort).toBeInstanceOf(AbortController);
    expect(isRunning('g1')).toBe(true);
  });

  it('rejects double-register for the same goal', () => {
    registerRun('g1');
    expect(() => registerRun('g1')).toThrow(/already has an active run/);
  });

  it('abortRun signals the controller and returns true', () => {
    const abort = registerRun('g1');
    expect(abortRun('g1')).toBe(true);
    expect(abort.signal.aborted).toBe(true);
  });

  it('abortRun returns false for unknown goal', () => {
    expect(abortRun('nope')).toBe(false);
  });

  it('unregisterRun removes the entry without aborting', () => {
    const abort = registerRun('g1');
    unregisterRun('g1');
    expect(isRunning('g1')).toBe(false);
    expect(abort.signal.aborted).toBe(false);
  });

  it('listRunning returns all current runs', () => {
    registerRun('g1');
    registerRun('g2');
    const list = listRunning();
    expect(list.map((r) => r.goalId).sort()).toEqual(['g1', 'g2']);
    expect(list[0].startedAt).toBeInstanceOf(Date);
  });
});
