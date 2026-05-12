import { runCouncil, type Invoke } from './modelCouncil';

function staticInvoke(map: Record<string, string>): Invoke {
  return async (model: string) => {
    if (!(model in map)) throw new Error(`unknown model ${model}`);
    return map[model];
  };
}

describe('model council', () => {
  it('vote mode selects the answer with the highest token overlap', async () => {
    const invoke = staticInvoke({
      a: 'The capital of France is Paris and Paris is on the Seine river',
      b: 'Paris is the capital of France located on the Seine',
      c: 'Lyon is a city in France famous for cuisine',
    });
    const result = await runCouncil('What is the capital of France?', {
      mode: 'vote',
      members: [{ model: 'a' }, { model: 'b' }, { model: 'c' }],
    }, invoke);
    expect(['a', 'b']).toContain(result.chosen.model);
    expect(result.mode).toBe('vote');
  });

  it('debate mode parses an arbiter JSON choice', async () => {
    const invoke = staticInvoke({
      a: 'Answer A about the topic',
      b: 'Answer B about the topic',
      arb: '{"choice": 2, "reason": "B is more accurate"}',
    });
    const result = await runCouncil('q', {
      mode: 'debate',
      members: [{ model: 'a' }, { model: 'b' }],
      arbiter: 'arb',
    }, invoke);
    expect(result.chosen.model).toBe('b');
  });

  it('arbiter mode returns the synthesized answer', async () => {
    const invoke = staticInvoke({
      a: 'thought 1',
      b: 'thought 2',
      arb: 'Synthesized final answer combining 1 and 2',
    });
    const result = await runCouncil('q', {
      mode: 'arbiter',
      members: [{ model: 'a' }, { model: 'b' }],
      arbiter: 'arb',
    }, invoke);
    expect(result.chosen.model).toBe('arb');
    expect(result.chosen.text).toContain('Synthesized');
  });

  it('handles a member that throws', async () => {
    const invoke: Invoke = async (model: string) => {
      if (model === 'b') throw new Error('boom');
      return 'ok answer about thing';
    };
    const result = await runCouncil('q', {
      mode: 'vote',
      members: [{ model: 'a' }, { model: 'b' }, { model: 'c' }],
    }, invoke);
    expect(result.answers.find((a) => a.model === 'b')?.error).toBe('boom');
    expect(result.chosen.error).toBeUndefined();
  });

  it('throws when no members configured', async () => {
    await expect(runCouncil('q', { mode: 'vote', members: [] }, async () => '')).rejects.toThrow(/at least one member/);
  });

  it('throws when debate mode missing arbiter', async () => {
    await expect(runCouncil('q', { mode: 'debate', members: [{ model: 'a' }] }, async () => 'x')).rejects.toThrow(/arbiter/);
  });
});
