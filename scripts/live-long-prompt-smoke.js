#!/usr/bin/env node

async function main() {
  const { OllamaClient } = require('../dist/core/ollamaClient');

  const model = process.env.HARNESS_LONG_PROMPT_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b';
  const host = process.env.OLLAMA_HOST;
  const lineCount = parsePositiveInteger(process.env.HARNESS_LONG_PROMPT_LINES, 320);
  const timeoutMs = parsePositiveInteger(process.env.HARNESS_LONG_PROMPT_TIMEOUT_MS, 600000);
  const numCtx = parsePositiveInteger(process.env.HARNESS_LONG_PROMPT_NUM_CTX, 32768);
  const expected = 'long smoke ok';
  const started = Date.now();

  const client = new OllamaClient({ model, host, numCtx });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const context = Array.from(
    { length: lineCount },
    (_, index) => `Line ${index}: the required final answer is ${expected}.`,
  ).join('\n');

  try {
    const result = await client.chat([
      { role: 'user', content: `${context}\n\nAfter reading the context, reply with exactly: ${expected}` },
    ], undefined, controller.signal);
    clearTimeout(timer);

    const content = String(result.message.content ?? '').trim();
    const ok = content === expected;
    console.log(JSON.stringify({ ok, model, elapsedMs: Date.now() - started, content, usage: result.usage }, null, 2));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    clearTimeout(timer);
    console.log(JSON.stringify({
      ok: false,
      model,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});