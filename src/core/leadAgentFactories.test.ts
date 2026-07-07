import { parseWorkstreams, DECOMPOSER_SYSTEM_PROMPT } from './leadAgentFactories';

describe('parseWorkstreams', () => {
  it('parses a clean workstream graph', () => {
    const tasks = parseWorkstreams(
      '{"workstreams":[{"id":"impl","role":"coder","prompt":"write code","dependsOn":[]},{"id":"review","role":"reviewer","prompt":"review it","dependsOn":["impl"]}]}',
      'task',
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: 'impl', role: 'coder', prompt: 'write code' });
    expect(tasks[1]).toMatchObject({ id: 'review', role: 'reviewer', dependsOn: ['impl'] });
  });

  it('tolerates markdown fences and prose', () => {
    const text = 'Here is the plan:\n```json\n{"workstreams":[{"role":"coder","prompt":"do it"}]}\n```\nDone.';
    const tasks = parseWorkstreams(text, 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('do it');
  });

  it('defaults an unknown role to coder and synthesises missing ids', () => {
    const tasks = parseWorkstreams('{"workstreams":[{"role":"wizard","prompt":"cast"}]}', 'task');
    expect(tasks[0].role).toBe('coder');
    expect(tasks[0].id).toBeTruthy();
  });

  it('drops workstreams with empty prompts', () => {
    const tasks = parseWorkstreams('{"workstreams":[{"role":"coder","prompt":"  "},{"role":"coder","prompt":"keep"}]}', 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('keep');
  });

  it('prunes dependencies that point at unknown or self ids', () => {
    const tasks = parseWorkstreams(
      '{"workstreams":[{"id":"a","role":"coder","prompt":"x","dependsOn":["ghost","a"]}]}',
      'task',
    );
    expect(tasks[0].dependsOn).toEqual([]);
  });

  it('deduplicates repeated ids', () => {
    const tasks = parseWorkstreams(
      '{"workstreams":[{"id":"dup","role":"coder","prompt":"one"},{"id":"dup","role":"coder","prompt":"two"}]}',
      'task',
    );
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  it('falls back to a single coder workstream on garbage', () => {
    const tasks = parseWorkstreams('no json here', 'fix the build');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ role: 'coder', prompt: 'fix the build' });
  });

  it('exposes the roles it supports in the system prompt', () => {
    expect(DECOMPOSER_SYSTEM_PROMPT).toContain('coder');
    expect(DECOMPOSER_SYSTEM_PROMPT).toMatch(/ONLY a JSON object/i);
  });
});
