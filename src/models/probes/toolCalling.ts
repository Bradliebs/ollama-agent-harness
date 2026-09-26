import type { Message } from 'ollama';
import type { IChatClient } from '../../core/chatClient';
import { liftInlineToolCalls } from '../../core/ollamaClient';
import {
  addTokens,
  assertNotAborted,
  emptyTokens,
  extractArgs,
  functionTool,
  makeResult,
  objectSchema,
  sampleLimit,
  tokenBudgetExceeded,
  type Probe,
  type ProbeRunOptions,
} from './types';

const CASES = [
  { prompt: 'Use the add tool to add 2 and 3. Do not answer in text.', tool: 'add', args: { a: 2, b: 3 } },
  { prompt: 'Use get_weather for Paris. Do not answer in text.', tool: 'get_weather', args: { city: 'Paris' } },
  { prompt: 'Use the add tool to add 10 and -4. Do not answer in text.', tool: 'add', args: { a: 10, b: -4 } },
  { prompt: 'Use get_weather for Tokyo. Do not answer in text.', tool: 'get_weather', args: { city: 'Tokyo' } },
];

const TOOLS = [
  functionTool('add', 'Add two numbers.', objectSchema({
    a: { type: 'number' },
    b: { type: 'number' },
  }, ['a', 'b'])),
  functionTool('get_weather', 'Get weather for a city.', objectSchema({
    city: { type: 'string' },
  }, ['city'])),
  functionTool('echo', 'Echo text.', objectSchema({
    text: { type: 'string' },
  }, ['text'])),
];

export const toolCallingProbe: Probe = {
  id: 'toolCalling',
  defaultSamples: 4,
  defaultTokenBudget: 2000,
  async run(client: IChatClient, opts?: ProbeRunOptions) {
    const started = performance.now();
    const tokens = emptyTokens();
    const samples = Math.min(sampleLimit(opts, this.defaultSamples), CASES.length);
    let correct = 0;
    let jsonInText = 0;
    let attempted = 0;

    for (const testCase of CASES.slice(0, samples)) {
      assertNotAborted(opts?.signal);
      if (tokenBudgetExceeded(tokens, opts)) break;
      const result = await client.chat([
        { role: 'system', content: 'Select exactly one provided tool when the user asks for a tool.' },
        { role: 'user', content: testCase.prompt },
      ], TOOLS, opts?.signal);
      addTokens(tokens, result.usage);
      attempted++;
      if (isCorrectToolCall(result.message, testCase.tool, testCase.args)) correct++;
      if (wasJsonInText(result.message)) jsonInText++;
    }

    return makeResult(this.id, attempted > 0 ? correct / attempted : 0, attempted, {
      jsonInTextRate: attempted > 0 ? jsonInText / attempted : 0,
      correct,
    }, tokens, started);
  },
};

function isCorrectToolCall(message: Message, name: string, expectedArgs: Record<string, unknown>): boolean {
  const call = message.tool_calls?.[0];
  if (!call || call.function?.name !== name) return false;
  const args = extractArgs(call.function.arguments);
  return Object.entries(expectedArgs).every(([key, value]) => args[key] === value);
}

function wasJsonInText(message: Message, toolNames: string[] = ['get_weather', 'add']): boolean {
  const lifted = (message as { __harnessParserLiftedToolCalls?: number }).__harnessParserLiftedToolCalls;
  if (lifted && lifted > 0) return true;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return false;
  const probe: Message = { role: 'assistant', content };
  liftInlineToolCalls(probe, toolNames);
  return Boolean(probe.tool_calls?.length);
}
