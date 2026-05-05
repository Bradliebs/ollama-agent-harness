#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:4000';
const DEFAULT_MODELS = ['kimi-k2.5:cloud', 'gemma4:e4b'];

const baseUrl = (argValue('--base-url') || process.env.HARNESS_NEWS_SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const models = (argValue('--models') || process.env.HARNESS_NEWS_SMOKE_MODELS || DEFAULT_MODELS.join(','))
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const timeoutMs = Number(argValue('--timeout-ms') || process.env.HARNESS_NEWS_SMOKE_TIMEOUT_MS || 300000);
const message = argValue('--message') || process.env.HARNESS_NEWS_SMOKE_PROMPT || 'Bounded verification: use web_search once for current global news, read at most one result if needed, then give one headline in one sentence.';

async function runSmoke(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, message, skipValidation: true }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 500)}`);
    const events = parseSseEvents(text);
    const toolCalls = events.filter((event) => event.type === 'tool_call').map((event) => event.call && event.call.name).filter(Boolean);
    const failedTools = events
      .filter((event) => event.type === 'tool_result' && event.result && event.result.success === false)
      .map((event) => ({ tool: event.call && event.call.name, error: event.result.error, output: String(event.result.output || '').slice(0, 160) }));
    const warningCount = events.filter((event) => event.type === 'context_warning').length;
    const routed = events.find((event) => event.type === 'model_routed') || null;
    const routeRequired = /^gemma4:(e4b|26b)$/i.test(model);
    const done = [...events].reverse().find((event) => event.type === 'done') || null;
    const textOut = events.filter((event) => event.type === 'text').map((event) => event.content || '').join('').slice(0, 500);
    return {
      model,
      ok: warningCount === 0 && Boolean(done) && done.reason === 'completed' && toolCalls.includes('web_search') && (!routeRequired || Boolean(routed)),
      eventCount: events.length,
      warningCount,
      routeRequired,
      routed,
      toolCalls,
      failedTools,
      done,
      textOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseSseEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((entry) => entry.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Ignore malformed diagnostic lines.
    }
  }
  return events;
}

async function main() {
  const results = [];
  for (const model of models) {
    results.push(await runSmoke(model));
  }
  const summary = {
    ok: results.every((result) => result.ok),
    baseUrl,
    models,
    results,
  };
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