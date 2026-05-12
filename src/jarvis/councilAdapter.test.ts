import { runCouncilForChat, type CouncilClientFactory } from './councilAdapter';

function makeFactory(answers: Record<string, string>): CouncilClientFactory {
  return (model: string) => ({
    async chat() {
      return { message: { role: 'assistant' as const, content: answers[model] ?? `(no answer for ${model})` } } as unknown as Awaited<ReturnType<import('../core/chatClient').IChatClient['chat']>>;
    },
  });
}

describe('council adapter', () => {
  it('round-trips vote mode through chat-client factory', async () => {
    const factory = makeFactory({
      a: 'The capital of France is Paris on the Seine river',
      b: 'Paris is the capital of France',
      c: 'Lyon is famous for cuisine',
    });
    const result = await runCouncilForChat('What is the capital of France?', {
      mode: 'vote',
      members: [{ model: 'a' }, { model: 'b' }, { model: 'c' }],
    }, factory);
    expect(['a', 'b']).toContain(result.chosen.model);
  });

  it('arbiter mode returns synthesized answer', async () => {
    const factory = makeFactory({ a: 'one', b: 'two', arb: 'synthesized' });
    const result = await runCouncilForChat('q', {
      mode: 'arbiter',
      members: [{ model: 'a' }, { model: 'b' }],
      arbiter: 'arb',
    }, factory);
    expect(result.chosen.text).toBe('synthesized');
  });
});
