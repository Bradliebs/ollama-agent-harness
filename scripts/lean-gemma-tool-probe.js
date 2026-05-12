#!/usr/bin/env node

const DEFAULT_MODEL = 'gemma4:e4b';
const DEFAULT_HOST = 'http://127.0.0.1:11434';

const model = argValue('--model') || process.env.HARNESS_GEMMA_PROBE_MODEL || DEFAULT_MODEL;
const host = (argValue('--host') || process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, '');
const timeoutMs = Number(argValue('--timeout-ms') || process.env.HARNESS_GEMMA_PROBE_TIMEOUT_MS || 180000);
const requireExactFinal = process.argv.includes('--require-exact-final') || process.env.HARNESS_GEMMA_PROBE_REQUIRE_EXACT_FINAL === '1';

const tool = {
  type: 'function',
  function: {
    name: 'get_fixed_time',
    description: 'Return the fixed current time string for this diagnostic.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

async function chat(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: [tool],
        stream: false,
        keep_alive: '1m',
        options: { num_ctx: 2048, temperature: 0 },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const messages = [
    { role: 'system', content: 'You are a tool-use diagnostic. When asked for the time, call get_fixed_time. Do not answer from memory.' },
    { role: 'user', content: 'What time is it? Use the tool.' },
  ];
  const first = await chat(messages);
  const firstMessage = first.message || {};
  const toolCalls = Array.isArray(firstMessage.tool_calls) ? firstMessage.tool_calls : [];
  const summary = {
    model,
    host,
    ok: false,
    firstContent: String(firstMessage.content || '').slice(0, 300),
    firstToolCallCount: toolCalls.length,
    firstToolCallNames: toolCalls.map((call) => call.function && call.function.name).filter(Boolean),
    firstPromptTokens: first.prompt_eval_count || 0,
    firstCompletionTokens: first.eval_count || 0,
    secondContent: null,
    secondToolCallCount: null,
    secondPromptTokens: null,
    secondCompletionTokens: null,
    toolCallOk: false,
    exactFinalOk: false,
  };

  if (toolCalls.length > 0) {
    summary.toolCallOk = true;
    messages.push(firstMessage);
    messages.push({ role: 'tool', content: 'The fixed diagnostic time is 2026-05-05T17:00:00+01:00.' });
    const second = await chat(messages);
    const secondMessage = second.message || {};
    summary.secondContent = String(secondMessage.content || '').slice(0, 500);
    summary.secondToolCallCount = Array.isArray(secondMessage.tool_calls) ? secondMessage.tool_calls.length : 0;
    summary.secondPromptTokens = second.prompt_eval_count || 0;
    summary.secondCompletionTokens = second.eval_count || 0;
    summary.exactFinalOk = summary.secondContent.includes('2026-05-05T17:00:00+01:00');
    summary.ok = requireExactFinal ? summary.exactFinalOk : summary.toolCallOk;
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});