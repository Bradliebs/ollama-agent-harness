#!/usr/bin/env node

import * as readline from 'readline';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { PermissionEngine } from '../permissions/engine';
import { SessionStorage } from '../persistence/sessionStorage';
import { assembleSystemContext } from '../context/assembly';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import type { LoopConfig, PermissionMode } from '../types';

interface CliOptions {
  model: string;
  host: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  summarizerModel?: string;
  modelRouting: ModelRoutingPolicy;
  prompt?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    model: 'qwen2.5-coder:7b',
    host: 'http://localhost:11434',
    permissionMode: 'default',
    maxTurns: 50,
    modelRouting: {},
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
      case '-m':
        options.model = args[++i];
        break;
      case '--host':
        options.host = args[++i];
        break;
      case '--mode':
        options.permissionMode = args[++i] as PermissionMode;
        break;
      case '--max-turns':
        options.maxTurns = parseInt(args[++i], 10);
        break;
      case '--summarizer-model':
        options.summarizerModel = args[++i];
        break;
      case '--small-helper-model':
        options.modelRouting.smallModel = args[++i];
        break;
      case '--default-helper-model':
        options.modelRouting.defaultModel = args[++i];
        break;
      case '--strong-helper-model':
        options.modelRouting.strongModel = args[++i];
        break;
      case '--helper-confidence-threshold':
        options.modelRouting.confidenceEscalationThreshold = parseFloat(args[++i]);
        break;
      case '-p':
      case '--prompt':
        options.prompt = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Ollama Agent Harness — local-first agentic coding tool

Usage:
  harness [options]              Interactive mode
  harness -p "your prompt"       Headless mode (single prompt)

Options:
  -m, --model <name>     Ollama model (default: qwen2.5-coder:7b)
  --host <url>           Ollama host (default: http://localhost:11434)
  --mode <mode>          Permission mode: default, acceptEdits, dontAsk
  --max-turns <n>        Max agent loop turns (default: 50)
  --summarizer-model <n> Optional smaller model for context compaction
  --small-helper-model <n> Model for bounded read-only helper agents
  --default-helper-model <n> Model for normal helper agents
  --strong-helper-model <n> Model for escalated helper agents
  --helper-confidence-threshold <n> Escalate helpers below this confidence (default: 0.45)
  -p, --prompt <text>    Run a single prompt (headless mode)
  -h, --help             Show this help
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const projectDir = process.cwd();

  // Initialize client
  const client = new OllamaClient({
    model: options.model,
    host: options.host,
  });

  // Health check
  const health = await client.healthCheck();
  if (!health.ok) {
    console.error(`❌ ${health.error}`);
    process.exit(1);
  }

  // Set up components
  const tools = getBuiltinTools();
  const permissionEngine = new PermissionEngine([], options.permissionMode);
  const session = new SessionStorage(projectDir, options.model);
  await session.initialize();

  const systemPrompt = await assembleSystemContext({
    systemPrompt: buildSystemPrompt(options.modelRouting),
    projectDir,
  });

  const config: LoopConfig = {
    model: options.model,
    systemPrompt,
    maxTurns: options.maxTurns,
  };

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: (call) => permissionEngine.evaluateAsync(call),
    session,
    summarizerClient: options.summarizerModel
      ? new OllamaClient({ model: options.summarizerModel, host: options.host })
      : undefined,
  };

  // Headless mode
  if (options.prompt) {
    await runHeadless(config, deps, session, options.prompt);
    return;
  }

  // Interactive mode
  await runInteractive(config, deps, session);
}

function buildSystemPrompt(modelRouting: ModelRoutingPolicy): string {
  const routingLines = Object.entries(modelRouting)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  const routingText = routingLines.length
    ? `\n\nHelper model routing policy:\n${routingLines.join('\n')}`
    : '';
  return 'You are a helpful coding assistant. Use the available tools to help the user with their task. Read files, write code, and execute commands as needed.' + routingText;
}

async function runHeadless(
  config: LoopConfig,
  deps: QueryLoopDeps,
  session: SessionStorage,
  prompt: string,
): Promise<void> {
  const messages = [{ role: 'user' as const, content: prompt }];

  for await (const event of queryLoop(config, deps, messages)) {
    switch (event.type) {
      case 'text':
        console.log(event.content);
        break;
      case 'tool_call':
        console.error(`🔧 ${event.call.name}(${JSON.stringify(event.call.input).slice(0, 100)})`);
        break;
      case 'tool_result':
        const icon = event.result.success ? '✅' : '❌';
        console.error(`  ${icon} ${event.result.output.slice(0, 200)}`);
        break;
      case 'context':
        console.error(`🧠 context ${event.strategy}: freed ~${event.tokensFreed} tokens, pressure ${Math.round(event.pressure * 100)}%${event.autosaved ? ', autosaved' : ''}`);
        break;
      case 'error':
        console.error(`⚠️ ${event.message}`);
        break;
      case 'done':
        console.error(`\n--- ${event.reason} (${event.turns} turns) ---`);
        break;
    }
  }
}

async function runInteractive(
  config: LoopConfig,
  deps: QueryLoopDeps,
  session: SessionStorage,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`🤖 Ollama Agent Harness (${config.model})`);
  console.log('Type your message, or /quit to exit.\n');

  const prompt = (): Promise<string> =>
    new Promise((resolve) => rl.question('> ', resolve));

  while (true) {
    const input = await prompt();
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye!');
      rl.close();
      return;
    }

    const messages = [{ role: 'user' as const, content: trimmed }];
    for await (const event of queryLoop(config, deps, messages)) {
      switch (event.type) {
        case 'text':
          console.log(`\n${event.content}\n`);
          break;
        case 'tool_call':
          console.log(`  🔧 ${event.call.name}(${JSON.stringify(event.call.input).slice(0, 100)})`);
          break;
        case 'tool_result':
          const icon = event.result.success ? '✅' : '❌';
          console.log(`  ${icon} ${event.result.output.slice(0, 200)}`);
          break;
        case 'error':
          console.log(`  ⚠️ ${event.message}`);
          break;
        case 'context':
          console.log(`  🧠 context ${event.strategy}: freed ~${event.tokensFreed} tokens, pressure ${Math.round(event.pressure * 100)}%${event.autosaved ? ', autosaved' : ''}`);
          break;
        case 'done':
          break;
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
