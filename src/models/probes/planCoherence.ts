import type { Message } from 'ollama';
import type { IChatClient } from '../../core/chatClient';
import {
  addTokens,
  assertNotAborted,
  emptyTokens,
  extractArgs,
  functionTool,
  makeResult,
  objectSchema,
  type Probe,
  type ProbeRunOptions,
} from './types';

const TOOLS = [
  functionTool('set_kv', 'Set a string value by key.', objectSchema({
    key: { type: 'string' },
    value: { type: 'string' },
  }, ['key', 'value'])),
  functionTool('get_kv', 'Get a string value by key.', objectSchema({
    key: { type: 'string' },
  }, ['key'])),
];

export const planCoherenceProbe: Probe = {
  id: 'planCoherence',
  defaultSamples: 1,
  defaultTokenBudget: 4000,
  async run(client: IChatClient, opts?: ProbeRunOptions) {
    const started = performance.now();
    const tokens = emptyTokens();
    const store = new Map<string, string>();
    const messages: Message[] = [
      {
        role: 'system',
        content: 'Use tools to maintain the key-value store. When complete, answer exactly FINAL: <beta value>.',
      },
      {
        role: 'user',
        content: 'Do these dependent steps: set alpha to blue; get alpha; set beta to the retrieved value plus "-done"; get beta; then final answer.',
      },
    ];

    let finalText = '';
    for (let turn = 0; turn < 8; turn++) {
      assertNotAborted(opts?.signal);
      const result = await client.chat(messages, TOOLS, opts?.signal);
      addTokens(tokens, result.usage);
      messages.push(result.message);
      const calls = result.message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = String(result.message.content ?? '');
        break;
      }
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const output = executeStoreTool(store, call.function?.name ?? '', extractArgs(call.function?.arguments));
        messages.push({
          role: 'tool',
          content: output,
          tool_call_id: (call as { id?: string }).id ?? `probe_call_${turn}_${i}`,
        } as Message);
      }
    }

    const correctState = store.get('beta') === 'blue-done';
    const correctFinal = /FINAL:\s*blue-done/i.test(finalText);
    const score = correctState && correctFinal ? 1 : correctState ? 0.7 : 0;
    return makeResult(this.id, score, 1, {
      finalText,
      finalState: Object.fromEntries(store.entries()),
      correctState,
      correctFinal,
    }, tokens, started);
  },
};

function executeStoreTool(store: Map<string, string>, name: string, args: Record<string, unknown>): string {
  if (name === 'set_kv') {
    const key = String(args.key ?? '');
    const value = String(args.value ?? '');
    if (!key) return JSON.stringify({ ok: false, error: 'missing key' });
    store.set(key, value);
    return JSON.stringify({ ok: true, key, value });
  }
  if (name === 'get_kv') {
    const key = String(args.key ?? '');
    return JSON.stringify({ ok: store.has(key), key, value: store.get(key) ?? null });
  }
  return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
}
