import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient, StreamChunk } from './chatClient';

/**
 * Options describing how to exercise a backend under the conformance suite.
 *
 * The factory is responsible for returning a client whose transport is wired to
 * a deterministic fake (or a live backend in integration runs). The suite never
 * asserts on specific response *content* — only on the structural contract every
 * `IChatClient` must honour so the agent loop, compaction, and subagents can
 * treat all backends interchangeably.
 */
export interface ChatClientConformanceOptions {
  /** Build a fresh client for each assertion. May be async. */
  makeClient: () => IChatClient | Promise<IChatClient>;
  /** The model string the client must report from `getModel()`. */
  expectedModel: string;
  /** Set false for backends that do not implement streaming. Defaults to true. */
  supportsStreaming?: boolean;
  /** Messages sent during the suite. Defaults to a single user turn. */
  sampleMessages?: Message[];
  /** Tools passed alongside the sample messages. Defaults to none. */
  sampleTools?: Tool[];
}

function assertChatResult(result: ChatResult): void {
  expect(result).toBeDefined();
  expect(result.message).toBeDefined();
  expect(typeof result.message.role).toBe('string');
  expect(typeof result.message.content).toBe('string');

  const usage = result.usage;
  expect(usage).toBeDefined();
  for (const field of ['promptTokens', 'completionTokens', 'totalDurationNs'] as const) {
    expect(typeof usage[field]).toBe('number');
    expect(Number.isFinite(usage[field])).toBe(true);
    expect(usage[field]).toBeGreaterThanOrEqual(0);
  }
}

/**
 * Shared behavioural contract for any {@link IChatClient}. Call from a backend's
 * own test file inside (or as) a `describe` block:
 *
 * ```ts
 * runChatClientConformance('OllamaClient (fake transport)', {
 *   makeClient: () => new OllamaClient({ model: 'test' }),
 *   expectedModel: 'test',
 * });
 * ```
 */
export function runChatClientConformance(label: string, options: ChatClientConformanceOptions): void {
  const supportsStreaming = options.supportsStreaming ?? true;
  const messages = options.sampleMessages ?? [{ role: 'user', content: 'ping' }];
  const tools = options.sampleTools;

  describe(`IChatClient conformance: ${label}`, () => {
    it('reports the configured model', async () => {
      const client = await options.makeClient();
      expect(client.getModel()).toBe(options.expectedModel);
      expect(client.getModel().length).toBeGreaterThan(0);
    });

    it('chat() resolves to a well-formed ChatResult', async () => {
      const client = await options.makeClient();
      assertChatResult(await client.chat(messages, tools));
    });

    it('chatOnce() resolves to a well-formed ChatResult', async () => {
      const client = await options.makeClient();
      assertChatResult(await client.chatOnce(messages, tools));
    });

    if (supportsStreaming) {
      it('chatStream() yields chunks terminated by done=true', async () => {
        const client = await options.makeClient();
        const chunks: StreamChunk[] = [];
        for await (const chunk of client.chatStream(messages, tools)) {
          expect(typeof chunk.content).toBe('string');
          expect(typeof chunk.done).toBe('boolean');
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[chunks.length - 1].done).toBe(true);
        expect(typeof chunks.map((c) => c.content).join('')).toBe('string');
      });
    }

    it('listModels() resolves to an array of strings', async () => {
      const client = await options.makeClient();
      const models = await client.listModels();
      expect(Array.isArray(models)).toBe(true);
      for (const model of models) {
        expect(typeof model).toBe('string');
      }
    });

    it('getContextWindow() resolves to a positive number or null', async () => {
      const client = await options.makeClient();
      const window = await client.getContextWindow();
      if (window !== null) {
        expect(typeof window).toBe('number');
        expect(window).toBeGreaterThan(0);
      }
    });

    it('healthCheck() resolves to an object with a boolean ok flag', async () => {
      const client = await options.makeClient();
      const health = await client.healthCheck();
      expect(typeof health.ok).toBe('boolean');
      if (health.error !== undefined) {
        expect(typeof health.error).toBe('string');
      }
    });

    it('getLocality(), when implemented, returns a known locality', async () => {
      const client = await options.makeClient();
      if (typeof client.getLocality === 'function') {
        expect(['local', 'cloud']).toContain(client.getLocality());
      }
    });
  });
}
