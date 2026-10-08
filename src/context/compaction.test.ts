import {
  applyBudgetReduction,
  applyAutoCompact,
  applySnip,
  compactIfNeeded,
  COMPACTION_STRATEGIES,
  DEFAULT_COMPACTION_CONFIG,
  elideOldToolCallArguments,
  isCompactionBoundary,
  AUTO_COMPACT_BOUNDARY_PREFIX,
  HISTORICAL_CONTEXT_BEGIN_MARKER,
  HISTORICAL_CONTEXT_END_MARKER,
} from './compaction';
import { estimateTokenCount, estimateToolSchemaTokens } from './assembly';
import type { Message } from 'ollama';

describe('Context Compaction', () => {
  describe('verify-compaction-budget', () => {
    it('stays under the configured token budget across 3 sequential snip cycles', () => {
      const maxTokens = 500;
      // Create messages that will exceed the budget
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'y'.repeat(200) },
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'y'.repeat(200) },
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'y'.repeat(200) },
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'y'.repeat(200) },
        { role: 'user', content: 'latest' },
      ];

      let current = messages;
      for (let i = 0; i < 3; i++) {
        const snipResult = applySnip(current, 4);
        current = snipResult.messages;
        const tokenCount = estimateTokenCount(current);
        expect(tokenCount).toBeLessThanOrEqual(maxTokens);
      }
    });
  });

  describe('applyBudgetReduction', () => {
    it('truncates oversized tool results', () => {
      const longContent = 'x'.repeat(10_000);
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'tool', content: longContent },
      ];

      const result = applyBudgetReduction(messages, 500);
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg!.content!.length).toBeLessThan(longContent.length);
      expect(toolMsg!.content).toContain('...(truncated)');
      expect(result.tokensFreed).toBeGreaterThan(0);
    });

    it('leaves small tool results unchanged', () => {
      const messages: Message[] = [
        { role: 'tool', content: 'short result' },
      ];

      const result = applyBudgetReduction(messages, 500);
      expect(result.messages[0].content).toBe('short result');
      expect(result.tokensFreed).toBe(0);
    });
  });

  describe('applySnip', () => {
    it('removes older messages when count exceeds keepCount', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'reply 3' },
      ];

      const result = applySnip(messages, 3);
      // Should keep system + boundary + last 3 non-system messages
      expect(result.messages.length).toBe(5); // system + boundary + 3 kept
      expect(result.tokensFreed).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1].content).toBe('reply 3');
    });

    it('returns unchanged if message count is within keepCount', () => {
      const messages: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];

      const result = applySnip(messages, 5);
      expect(result.messages).toEqual(messages);
      expect(result.tokensFreed).toBe(0);
    });
  });

  describe('applyAutoCompact', () => {
    it('returns summary metadata for persistence boundaries', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'first decision' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second decision' },
        { role: 'assistant', content: 'second answer' },
        { role: 'user', content: 'latest request' },
      ];
      const client = {
        chat: jest.fn().mockResolvedValue({
          message: { role: 'assistant', content: 'summary text' },
        }),
      };

      const result = await applyAutoCompact(messages, client as never);

      expect(result.strategy).toBe('auto_compact');
      expect(result.summary).toBe('summary text');
      expect(result.compactedCount).toBe(3);
      expect(result.messages.some((m) => m.content?.includes('summary text'))).toBe(true);
    });

    describe('historical-context directive (HARNESS_LOOP_HARDENING)', () => {
      const original = process.env.HARNESS_LOOP_HARDENING;
      afterEach(() => {
        if (original === undefined) delete process.env.HARNESS_LOOP_HARDENING;
        else process.env.HARNESS_LOOP_HARDENING = original;
      });

      const buildMessages = (): Message[] => [
        { role: 'user', content: 'first decision' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second decision' },
        { role: 'assistant', content: 'second answer' },
        { role: 'user', content: 'latest request' },
      ];
      const buildClient = () => ({
        chat: jest.fn().mockResolvedValue({
          message: { role: 'assistant', content: 'summary text' },
        }),
      });

      it('with flag OFF, summary content has NO historical-context markers (legacy shape)', async () => {
        process.env.HARNESS_LOOP_HARDENING = '0';
        const result = await applyAutoCompact(buildMessages(), buildClient() as never);
        const summaryMsg = result.messages.find((m) =>
          typeof m.content === 'string' && m.content.startsWith(AUTO_COMPACT_BOUNDARY_PREFIX),
        );
        expect(summaryMsg).toBeDefined();
        expect(summaryMsg!.content).not.toContain(HISTORICAL_CONTEXT_BEGIN_MARKER);
        expect(summaryMsg!.content).not.toContain(HISTORICAL_CONTEXT_END_MARKER);
        // Legacy shape: prefix + count + newline + raw summary text.
        expect(summaryMsg!.content).toBe(
          `${AUTO_COMPACT_BOUNDARY_PREFIX}3 messages]\nsummary text`,
        );
      });

      it('with flag ON, summary content is wrapped in BEGIN/END historical markers', async () => {
        process.env.HARNESS_LOOP_HARDENING = '1';
        const result = await applyAutoCompact(buildMessages(), buildClient() as never);
        const summaryMsg = result.messages.find((m) =>
          typeof m.content === 'string' && m.content.startsWith(AUTO_COMPACT_BOUNDARY_PREFIX),
        );
        expect(summaryMsg).toBeDefined();
        expect(summaryMsg!.content).toContain(HISTORICAL_CONTEXT_BEGIN_MARKER);
        expect(summaryMsg!.content).toContain(HISTORICAL_CONTEXT_END_MARKER);
        expect(summaryMsg!.content).toContain('summary text');
        // Boundary detector must still match the prefix-based shape so old
        // session JSONL stays parseable.
        expect(isCompactionBoundary(summaryMsg!)).toBe(true);
      });

      it('boundary detector accepts both legacy and hardened shapes', () => {
        const legacy: Message = {
          role: 'system',
          content: `${AUTO_COMPACT_BOUNDARY_PREFIX}3 messages]\nsummary`,
        };
        const hardened: Message = {
          role: 'system',
          content: `${AUTO_COMPACT_BOUNDARY_PREFIX}3 messages]\n${HISTORICAL_CONTEXT_BEGIN_MARKER}\nsummary\n${HISTORICAL_CONTEXT_END_MARKER}`,
        };
        expect(isCompactionBoundary(legacy)).toBe(true);
        expect(isCompactionBoundary(hardened)).toBe(true);
      });
    });
  });

  describe('compactIfNeeded', () => {
    it('auto-compacts before snipping near the context limit', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'a'.repeat(120) },
        { role: 'assistant', content: 'b'.repeat(120) },
        { role: 'user', content: 'c'.repeat(120) },
        { role: 'assistant', content: 'd'.repeat(120) },
        { role: 'user', content: 'latest' },
      ];
      const client = {
        chat: jest.fn().mockResolvedValue({
          message: { role: 'assistant', content: 'continuity summary' },
        }),
      };

      const result = await compactIfNeeded(messages, {
        maxTokens: 100,
        budgetPerToolResult: 4000,
        snipThreshold: 0.7,
        autoCompactThreshold: 0.85,
      }, client as never);

      expect(result.strategy).toBe('auto_compact');
      expect(result.summary).toBe('continuity summary');
    });
  });

  describe('elideOldToolCallArguments', () => {
    const write = (path: string, size: number): Message => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path, content: 'x'.repeat(size) } } }] });
    const conversation = (): Message[] => [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'write three files' },
      write('a.ts', 6000), { role: 'tool', content: 'wrote a.ts' },
      write('b.ts', 6000), { role: 'tool', content: 'wrote b.ts' },
      write('c.ts', 6000), { role: 'tool', content: 'wrote c.ts' },
    ];

    it('shortens long arguments of older calls only, keeping paths and recent calls', () => {
      const result = elideOldToolCallArguments(conversation(), 2);
      const args = result.messages.filter((m) => m.tool_calls).map((m) => m.tool_calls![0].function.arguments as Record<string, string>);
      expect(args[0]).toEqual({ path: 'a.ts', content: '[6000 chars omitted to save context; this call already ran]' });
      expect(args[1].content).toHaveLength(6000);
      expect(args[2].content).toHaveLength(6000);
      expect(result.tokensFreed).toBeGreaterThan(1400);
      // Idempotent: a second pass changes nothing.
      expect(elideOldToolCallArguments(result.messages, 2).tokensFreed).toBe(0);
    });

    it('runs under pressure before any message is snipped', async () => {
      const client = { chat: jest.fn() };
      const result = await compactIfNeeded(conversation(), { ...DEFAULT_COMPACTION_CONFIG, maxTokens: 5000 }, client as never);
      expect(client.chat).not.toHaveBeenCalled();
      expect(result.messages).toHaveLength(conversation().length);
      expect(result.tokensFreed).toBeGreaterThan(1400);
    });

    it('leaves the transcript alone when there is no pressure', async () => {
      const messages = conversation();
      const result = await compactIfNeeded(messages, { ...DEFAULT_COMPACTION_CONFIG, maxTokens: 100_000 }, { chat: jest.fn() } as never);
      expect(result.messages).toEqual(messages);
      expect(result.tokensFreed).toBe(0);
    });
  });

  describe('estimateTokenCount', () => {
    it('estimates roughly 4 chars per token', () => {
      const messages: Message[] = [
        { role: 'user', content: 'a'.repeat(400) },
      ];
      const count = estimateTokenCount(messages);
      expect(count).toBe(100);
    });

    it('counts tool-call arguments, which are re-sent every turn', () => {
      const call: Message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_write', arguments: { path: 'a.ts', content: 'x'.repeat(4000) } } }] };
      expect(estimateTokenCount([call])).toBeGreaterThan(1000);
    });

    it('estimates tool-schema tokens from the serialized definitions', () => {
      const schema = { type: 'function', function: { name: 'a', description: 'd'.repeat(390), parameters: {} } };
      expect(estimateToolSchemaTokens([schema])).toBeGreaterThan(100);
      expect(estimateToolSchemaTokens([])).toBe(0);
    });
  });

  describe('CompactionStrategy contract', () => {
    it('exposes the closed set of strategies', () => {
      expect(COMPACTION_STRATEGIES).toEqual([
        'budget_reduction',
        'snip',
        'auto_compact',
        'snip_quality_fallback',
      ]);
    });
  });

  describe('isCompactionBoundary', () => {
    it('matches auto-compact summary boundaries', () => {
      expect(isCompactionBoundary({
        role: 'system',
        content: `${AUTO_COMPACT_BOUNDARY_PREFIX}5 messages]\nsummary body`,
      })).toBe(true);
    });

    it('matches snip boundaries with any digit count', () => {
      expect(isCompactionBoundary({
        role: 'system',
        content: '[12 earlier messages snipped to save context]',
      })).toBe(true);
      expect(isCompactionBoundary({
        role: 'system',
        content: '[1 earlier messages snipped to save context]',
      })).toBe(true);
    });

    it('rejects unrelated system messages', () => {
      expect(isCompactionBoundary({ role: 'system', content: 'system prompt' })).toBe(false);
      expect(isCompactionBoundary({ role: 'system', content: '[notes] hello' })).toBe(false);
      expect(isCompactionBoundary({ role: 'system', content: '[abc earlier messages snipped to save context]' })).toBe(false);
    });

    it('rejects non-system roles even if content looks boundary-like', () => {
      expect(isCompactionBoundary({
        role: 'user',
        content: `${AUTO_COMPACT_BOUNDARY_PREFIX}5 messages]\nfake`,
      })).toBe(false);
    });
  });

  describe('boundary accumulation guard', () => {
    it('does not stack snip boundaries across repeated compactions', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'reply 3' },
        { role: 'user', content: 'msg 4' },
        { role: 'assistant', content: 'reply 4' },
      ];

      const first = applySnip(messages, 3);
      const second = applySnip(first.messages, 3);
      const third = applySnip(second.messages, 3);

      const boundaries = third.messages.filter(isCompactionBoundary);
      expect(boundaries.length).toBe(1);
    });

    it('drops the prior auto-compact summary before producing a new one', async () => {
      const seedSummary: Message = {
        role: 'system',
        content: `${AUTO_COMPACT_BOUNDARY_PREFIX}3 messages]\nold summary`,
      };
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        seedSummary,
        { role: 'user', content: 'new question 1' },
        { role: 'assistant', content: 'new reply 1' },
        { role: 'user', content: 'new question 2' },
        { role: 'assistant', content: 'new reply 2' },
        { role: 'user', content: 'latest' },
      ];
      const client = {
        chat: jest.fn().mockResolvedValue({
          message: { role: 'assistant', content: 'fresh summary' },
        }),
      };

      const result = await applyAutoCompact(messages, client as never);

      const boundaries = result.messages.filter(isCompactionBoundary);
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].content).toContain('fresh summary');
      expect(boundaries[0].content).not.toContain('old summary');
      // ...but the old summary is folded into the new one, not lost.
      const summarizerInput = String(client.chat.mock.calls[0][0][1].content);
      expect(summarizerInput).toContain('[PREVIOUS SUMMARY]: old summary');
    });

    it('keeps the latest auto-compact summary when snipping', () => {
      const summary: Message = { role: 'system', content: `${AUTO_COMPACT_BOUNDARY_PREFIX}6 messages]\nthe early decisions` };
      const messages: Message[] = [
        { role: 'system', content: 'system' },
        summary,
        ...Array.from({ length: 8 }, (_, i): Message => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` })),
      ];
      const result = applySnip(messages, 3);
      expect(result.messages).toContain(summary);
      expect(result.messages.filter((m) => isCompactionBoundary(m) && !String(m.content).startsWith(AUTO_COMPACT_BOUNDARY_PREFIX))).toHaveLength(1);
      expect(applySnip(result.messages, 2).messages).toContain(summary);
    });
  });
});
