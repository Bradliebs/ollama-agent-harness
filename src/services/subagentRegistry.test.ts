import {
  cancelSubagent,
  getActiveSubagent,
  listActiveSubagents,
  registerSubagent,
  unregisterSubagent,
  updateSubagentActivity,
  _resetSubagentRegistryForTests,
} from './subagentRegistry';

describe('subagentRegistry', () => {
  beforeEach(() => { _resetSubagentRegistryForTests(); });

  it('registers and lists active sub-agents', () => {
    const controller = new AbortController();
    registerSubagent({ id: 'r1', name: 'researcher', prompt: 'find docs', controller });
    const list = listActiveSubagents();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('r1');
    expect(list[0].name).toBe('researcher');
    expect(list[0].promptSnippet).toBe('find docs');
  });

  it('truncates prompt to 200 chars in the snippet', () => {
    const controller = new AbortController();
    const longPrompt = 'a'.repeat(500);
    registerSubagent({ id: 'r2', name: 'x', prompt: longPrompt, controller });
    const record = getActiveSubagent('r2');
    expect(record?.promptSnippet).toHaveLength(200);
  });

  it('orders active list by start time ascending', () => {
    registerSubagent({ id: 'a', name: 'a', prompt: '', controller: new AbortController(), startedAtMs: 1000 });
    registerSubagent({ id: 'b', name: 'b', prompt: '', controller: new AbortController(), startedAtMs: 500 });
    const list = listActiveSubagents();
    expect(list.map((record) => record.id)).toEqual(['b', 'a']);
  });

  it('unregisters by id', () => {
    registerSubagent({ id: 'r1', name: 'researcher', prompt: '', controller: new AbortController() });
    unregisterSubagent('r1');
    expect(listActiveSubagents()).toHaveLength(0);
  });

  it('cancel aborts the controller and returns true', () => {
    const controller = new AbortController();
    registerSubagent({ id: 'r1', name: 'researcher', prompt: '', controller });
    expect(cancelSubagent('r1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('cancel returns false for an unknown id', () => {
    expect(cancelSubagent('missing')).toBe(false);
  });

  it('updateSubagentActivity stamps lastActivity and updatedAtMs', () => {
    const before = Date.now();
    registerSubagent({ id: 'r1', name: 'x', prompt: '', controller: new AbortController() });
    updateSubagentActivity('r1', '🔧 read_file');
    const record = getActiveSubagent('r1');
    expect(record?.lastActivity).toBe('🔧 read_file');
    expect(record?.updatedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('updateSubagentActivity truncates labels to 120 chars', () => {
    registerSubagent({ id: 'r1', name: 'x', prompt: '', controller: new AbortController() });
    updateSubagentActivity('r1', 'a'.repeat(500));
    expect(getActiveSubagent('r1')?.lastActivity).toHaveLength(120);
  });

  it('updateSubagentActivity is a no-op for unknown ids', () => {
    expect(() => updateSubagentActivity('missing', 'whatever')).not.toThrow();
    expect(getActiveSubagent('missing')).toBeUndefined();
  });
});
