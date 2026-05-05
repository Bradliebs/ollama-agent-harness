const fs = require('fs');
const path = require('path');

const { buildSystemPrompt } = require('../dist/cli/index');
const { assembleSystemContext } = require('../dist/context/assembly');
const { getBuiltinTools } = require('../dist/tools');
const { toolToSchema } = require('../dist/types/tool');

const model = process.env.HARNESS_PROBE_MODEL || 'gemma4:e4b';
const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const timeoutMs = Number(process.env.HARNESS_PROBE_TIMEOUT_MS || 30000);
const outputPath = process.argv[2] || path.join('agent-outputs', 'gemma4-e4b-payload-isolation-2026-05-05.json');

function estimateChars(messages, tools) {
  const messageChars = messages.reduce((total, message) => total + String(message.content || '').length, 0);
  const toolSchemaChars = tools.length === 0 ? 0 : JSON.stringify(tools).length;
  return {
    messageChars,
    messageTokenEstimate: Math.ceil(messageChars / 4),
    toolCount: tools.length,
    toolSchemaChars,
    toolSchemaTokenEstimate: Math.ceil(toolSchemaChars / 4),
    totalChars: messageChars + toolSchemaChars,
    totalTokenEstimate: Math.ceil((messageChars + toolSchemaChars) / 4),
  };
}

async function runProbe(name, messages, tools, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, options }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    return {
      name,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
      payload: estimateChars(messages, tools),
      toolCalls: parsed?.message?.tool_calls || [],
      contentPreview: typeof parsed?.message?.content === 'string' ? parsed.message.content.slice(0, 500) : '',
      error: response.ok ? undefined : text.slice(0, 500),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - started,
      payload: estimateChars(messages, tools),
      toolCalls: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const builtins = getBuiltinTools();
  const allTools = builtins.map(toolToSchema);
  const webTools = builtins.filter((tool) => ['web_search', 'web_read', 'web_fetch'].includes(tool.name)).map(toolToSchema);
  const oneTool = builtins.filter((tool) => tool.name === 'web_search').map(toolToSchema);
  const minimalMessages = [
    { role: 'system', content: 'Use tools when needed. For current news, call web_search.' },
    { role: 'user', content: 'what is in the news today?' },
  ];
  const fullSystemPrompt = await assembleSystemContext({
    systemPrompt: buildSystemPrompt({}),
    projectDir: process.cwd(),
    skillsDir: path.join(process.cwd(), '.harness', 'skills'),
  });
  const fullMessages = [
    { role: 'system', content: fullSystemPrompt },
    { role: 'user', content: 'what is in the news today? use web search' },
  ];

  const cases = [
    ['minimal-one-tool', minimalMessages, oneTool, {}],
    ['minimal-web-tools', minimalMessages, webTools, {}],
    ['minimal-all-tools', minimalMessages, allTools, {}],
    ['full-prompt-one-tool', fullMessages, oneTool, {}],
    ['full-prompt-one-tool-num-ctx-4096', fullMessages, oneTool, { num_ctx: 4096 }],
  ];
  const results = [];
  for (const [name, messages, tools, options] of cases) {
    console.log(`probe ${name}`);
    results.push(await runProbe(name, messages, tools, options));
  }
  const output = { model, host, timeoutMs, createdAt: new Date().toISOString(), results };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});