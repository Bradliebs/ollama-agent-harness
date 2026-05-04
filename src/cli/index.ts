#!/usr/bin/env node

import * as readline from 'readline';
import { OllamaClient } from '../core/ollamaClient';
import { createChatClient } from '../core/chatClientFactory';
import type { IChatClient } from '../core/chatClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { PermissionEngine } from '../permissions/engine';
import { SessionStorage } from '../persistence/sessionStorage';
import { assembleSystemContext } from '../context/assembly';
import { checkSetupHealth, type SetupHealthResult } from '../setup/health';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import { OUTPUT_VALIDATION_PROFILES, parseOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { formatCliHelp, resolveCliCommand } from './commands';
import { runMyceliumCli } from '../mycelium/cli';
import type { LoopConfig, PermissionMode } from '../types';

interface CliOptions {
  command?: 'doctor' | 'mycelium';
  myceliumArgs?: string[];
  model: string;
  host: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  summarizerModel?: string;
  modelRouting: ModelRoutingPolicy;
  prompt?: string;
  promptFile?: string;
  visionModel: string;
  audioTranscribeCommand: string;
  audioSamplePath: string;
  outputValidation?: OutputValidationProfile;
  unproductiveTurnLimit?: number;
  backend?: string;
  compactRemoteSmoke?: boolean;
  /** When set, doctor re-runs every `watchIntervalMs` instead of exiting. */
  watchIntervalMs?: number;
}

export function parseArgs(args: string[] = process.argv.slice(2)): CliOptions {
  const options: CliOptions = {
    model: 'qwen2.5-coder:7b',
    host: 'http://localhost:11434',
    permissionMode: 'default',
    maxTurns: 50,
    modelRouting: {},
    visionModel: process.env.HARNESS_VISION_MODEL ?? '',
    audioTranscribeCommand: process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND ?? '',
    audioSamplePath: '',
  };

  const command = resolveCliCommand(args[0]);
  if (command?.name === 'doctor') {
    options.command = command.name;
    args = args.slice(1);
  } else if (command?.name === 'mycelium') {
    options.command = 'mycelium';
    // Everything after 'mycelium' is forwarded to the subcommand handler.
    options.myceliumArgs = args.slice(1);
    args = [];
  }

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
      case '--vision-model':
        options.visionModel = args[++i];
        break;
      case '--audio-command':
        options.audioTranscribeCommand = args[++i];
        break;
      case '--audio-sample':
        options.audioSamplePath = args[++i];
        break;
      case '--validate-output':
        options.outputValidation = parseOutputValidationProfile(args[++i]);
        break;
      case '--unproductive-turn-limit':
        options.unproductiveTurnLimit = parseInt(args[++i], 10);
        break;
      case '--backend':
        options.backend = args[++i];
        break;
      case '--compact-remote-smoke':
        options.compactRemoteSmoke = true;
        break;
      case '--watch': {
        // Optional numeric arg: --watch 10 or just --watch (defaults to 5s).
        // Min 1s to avoid hammering Ollama; max 3600s (1h) as a sanity cap.
        const next = args[i + 1];
        let seconds = 5;
        if (next && /^\d+$/.test(next)) { seconds = parseInt(next, 10); i++; }
        seconds = Math.max(1, Math.min(3600, seconds));
        options.watchIntervalMs = seconds * 1000;
        break;
      }
      case '--helper-confidence-threshold':
        options.modelRouting.confidenceEscalationThreshold = parseFloat(args[++i]);
        break;
      case '-p':
      case '--prompt':
        options.prompt = args[++i];
        break;
      case '--prompt-file':
        options.promptFile = args[++i];
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
  console.log(formatCliHelp(OUTPUT_VALIDATION_PROFILES.map((profile) => profile.profile)));
}

export async function main(): Promise<void> {
  const options = parseArgs();

  if (options.command === 'doctor') {
    const runOnce = async () => {
      const result = await checkSetupHealth({
        host: options.host,
        visionModel: options.visionModel,
        audioTranscribeCommand: options.audioTranscribeCommand,
        audioSamplePath: options.audioSamplePath || undefined,
        pdfOcrCommand: process.env.HARNESS_PDF_OCR_COMMAND,
      });
      console.log(formatSetupHealth(result));
      const failedRequired = !result.ollama.ok
        || (options.visionModel ? !result.vision.ok : false)
        || (options.audioTranscribeCommand ? !result.audio.ok : false);
      return failedRequired;
    };

    if (options.watchIntervalMs !== undefined) {
      // Watch mode: redraw on every tick. Useful when toggling API keys
      // in the UI to confirm doctor reflects them, or when bringing
      // Ollama up/down. Ctrl+C stops the loop. Exit code stays 0 in
      // watch mode — it's a monitoring view, not a one-shot check.
      const seconds = Math.round(options.watchIntervalMs / 1000);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Best-effort screen clear. process.stdout.write avoids the extra
        // blank line console.clear() sometimes leaves on Windows.
        if (process.stdout.isTTY) process.stdout.write('\x1B[2J\x1B[0f');
        console.log(`harness doctor --watch (every ${seconds}s, Ctrl+C to stop) — ${new Date().toISOString()}`);
        try {
          await runOnce();
        } catch (error) {
          console.error(`doctor failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, options.watchIntervalMs));
      }
    }

    const failedRequired = await runOnce();
    if (failedRequired) process.exitCode = 1;
    return;
  }

  if (options.command === 'mycelium') {
    const result = await runMyceliumCli({ projectDir: process.cwd(), args: options.myceliumArgs ?? [] });
    console.log(result.output);
    process.exitCode = result.exitCode;
    return;
  }

  const projectDir = process.cwd();

  // Initialize client (Ollama by default; OpenAI-compatible providers via
  // --backend or HARNESS_BACKEND env var).
  const client = createChatClient({
    backend: options.backend,
    model: options.model,
    host: options.host,
    autoFallback: true,
  });

  // Health check
  const health = await client.healthCheck();
  if (!health.ok) {
    console.error(`❌ ${health.error}`);
    process.exit(1);
  }

  let headlessPrompt: string | undefined = options.prompt;
  if (!headlessPrompt && options.promptFile) {
    const fs = await import('fs/promises');
    headlessPrompt = await fs.readFile(options.promptFile, 'utf-8');
  }
  if (options.compactRemoteSmoke && headlessPrompt) {
    await runCompactRemoteSmoke(client, headlessPrompt);
    return;
  }

  // Set up components
  const tools = options.compactRemoteSmoke ? [] : getBuiltinTools();
  const permissionEngine = new PermissionEngine([], options.permissionMode);
  const session = new SessionStorage(projectDir, options.model);
  await session.initialize();

  const systemPrompt = await assembleSystemContext({
    systemPrompt: options.compactRemoteSmoke ? 'Reply briefly in plain text.' : buildSystemPrompt(options.modelRouting),
    projectDir,
  });

  const config: LoopConfig = {
    model: options.model,
    systemPrompt,
    maxTurns: options.maxTurns,
    unproductiveTurnLimit: options.unproductiveTurnLimit,
    outputValidation: options.outputValidation ? { enabled: true, profile: options.outputValidation } : undefined,
  };

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: (call) => permissionEngine.evaluateAsync(call),
    session,
    summarizerClient: options.summarizerModel
      ? createChatClient({ backend: options.backend, model: options.summarizerModel, host: options.host, autoFallback: true })
      : undefined,
  };

  // Headless mode — accept either an inline prompt or a path to read from.
  // --prompt-file lets callers pass large prompts (e.g. inline file contents)
  // that would otherwise overflow shell command-line size limits.
  if (headlessPrompt) {
    await runHeadless(config, deps, session, headlessPrompt);
    return;
  }

  // Interactive mode
  await runInteractive(config, deps, session);
}

export function formatSetupHealth(result: SetupHealthResult): string {
  const lines = [
    'Setup doctor',
    formatHealthLine('Ollama', result.ollama.ok, result.ollama.message),
    formatHealthLine('Vision', result.vision.ok, result.vision.message),
    formatHealthLine('Audio', result.audio.ok, result.audio.message),
  ];
  if (result.pdfOcr) lines.push(formatHealthLine('PDF OCR', result.pdfOcr.ok, result.pdfOcr.message));
  lines.push(formatHealthLine('Node', result.local.node.ok, result.local.node.message));
  lines.push(formatHealthLine('Package', result.local.package.ok, result.local.package.message));
  lines.push(formatHealthLine('Sessions', result.local.sessions.ok, result.local.sessions.message));
  lines.push(formatHealthLine('Tools', result.local.tools.ok, result.local.tools.message));
  lines.push(formatHealthLine('Automations', result.local.automations.ok, result.local.automations.message));
  lines.push(formatHealthLine('Mycelium', result.local.mycelium.ok, result.local.mycelium.message));
  if (result.backends && result.backends.length > 0) {
    lines.push('Backends (OpenAI-compatible):');
    for (const backend of result.backends) {
      lines.push('  ' + formatHealthLine(backend.label, backend.ok, backend.message));
    }
    // Discoverability: when at least one backend is configured, point
    // users at the smoke that exercises end-to-end CLI round-trips for
    // every configured backend. Skipped backends are clearly skipped,
    // so this is safe to surface even with a single key set.
    if (result.backends.some((b) => b.ok)) {
      lines.push('  Tip: run `npm run smoke:remote-backends` to round-trip every configured backend through the CLI.');
    }
  }
  if (result.fallback) {
    const f = result.fallback;
    const status = f.enabled
      ? `enabled, ${f.configuredCount} backend(s) with keys, cooldown ${Math.round(f.cooldownMs / 1000)}s, order: ${f.order}`
      : 'disabled (HARNESS_REMOTE_AUTO_FALLBACK=0)';
    lines.push(formatHealthLine('Fallback', f.enabled && f.configuredCount > 1, `Provider fallback ${status}.`));
  }
  return lines.join('\n');
}

function formatHealthLine(label: string, ok: boolean, message: string): string {
  return `${ok ? 'OK' : 'WARN'} ${label}: ${message}`;
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

function summarizeConsoleToolResult(name: string, success: boolean, output: string): string | null {
  if (['skill', 'list_files', 'file_read', 'recall'].includes(name)) return null;
  const text = output.replace(/\s+/g, ' ').trim();
  if (!text) return success ? null : `${name} failed`;
  const taskMatch = text.match(/\+ Task added:\s*([^\r\n]+)/i);
  if (taskMatch) return `Added task: ${taskMatch[1].trim()}`;
  if (/telegram message sent successfully/i.test(text)) return null;
  return `${name}: ${text.slice(0, 160)}`;
}

export function buildConsoleToolOnlyResponse(input: { toolCalls: number; toolSummaries: string[]; errors: string[]; doneReason?: string }): string {
  if (input.errors.length > 0) return `Harness reported an error:\n${input.errors.slice(-2).join('\n')}`;
  if (input.toolSummaries.length > 0) return `Done.\n${input.toolSummaries.slice(-4).join('\n')}`;
  if (input.doneReason === 'max_turns_synthesized') return 'Done (synthesis turn produced no visible text).';
  if (input.toolCalls > 0) return 'Done. The model used tools, but did not return a readable final message.';
  return 'No response from the model.';
}

async function runHeadless(
  config: LoopConfig,
  deps: QueryLoopDeps,
  session: SessionStorage,
  prompt: string,
): Promise<void> {
  const messages = [{ role: 'user' as const, content: prompt }];
  let assistantText = '';
  let toolCalls = 0;
  const toolSummaries: string[] = [];
  const errors: string[] = [];

  for await (const event of queryLoop(config, deps, messages)) {
    switch (event.type) {
      case 'text':
        assistantText += event.content;
        console.log(event.content);
        break;
      case 'tool_call':
        console.error(`🔧 ${event.call.name}(${JSON.stringify(event.call.input).slice(0, 100)})`);
        break;
      case 'tool_result':
        toolCalls++;
        const summary = summarizeConsoleToolResult(event.call.name, event.result.success, event.result.output);
        if (summary) toolSummaries.push(summary);
        const icon = event.result.success ? '✅' : '❌';
        console.error(`  ${icon} ${event.result.output.slice(0, 200)}`);
        break;
      case 'context':
        console.error(`🧠 context ${event.strategy}: freed ~${event.tokensFreed} tokens, pressure ${Math.round(event.pressure * 100)}%${event.autosaved ? ', autosaved' : ''}`);
        break;
      case 'output_validation':
        console.error(`🧪 output validation ${event.validation.status}: score ${event.validation.score}`);
        for (const finding of event.validation.findings.slice(0, 5)) {
          console.error(`  ${finding.severity.toUpperCase()} ${finding.message}`);
        }
        break;
      case 'error':
        errors.push(event.message);
        console.error(`⚠️ ${event.message}`);
        break;
      case 'done':
        if (!assistantText.trim()) console.log(buildConsoleToolOnlyResponse({ toolCalls, toolSummaries, errors, doneReason: event.reason }));
        console.error(`\n--- ${event.reason} (${event.turns} turns) ---`);
        break;
    }
  }
}

async function runCompactRemoteSmoke(client: IChatClient, prompt: string): Promise<void> {
  const result = await client.chat([{ role: 'user', content: prompt }]);
  const content = typeof result.message.content === 'string'
    ? result.message.content
    : JSON.stringify(result.message.content);
  console.log(content.trim());
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
    let assistantText = '';
    let toolCalls = 0;
    const toolSummaries: string[] = [];
    const errors: string[] = [];
    for await (const event of queryLoop(config, deps, messages)) {
      switch (event.type) {
        case 'text':
          assistantText += event.content;
          console.log(`\n${event.content}\n`);
          break;
        case 'tool_call':
          console.log(`  🔧 ${event.call.name}(${JSON.stringify(event.call.input).slice(0, 100)})`);
          break;
        case 'tool_result':
          toolCalls++;
          const summary = summarizeConsoleToolResult(event.call.name, event.result.success, event.result.output);
          if (summary) toolSummaries.push(summary);
          const icon = event.result.success ? '✅' : '❌';
          console.log(`  ${icon} ${event.result.output.slice(0, 200)}`);
          break;
        case 'error':
          errors.push(event.message);
          console.log(`  ⚠️ ${event.message}`);
          break;
        case 'context':
          console.log(`  🧠 context ${event.strategy}: freed ~${event.tokensFreed} tokens, pressure ${Math.round(event.pressure * 100)}%${event.autosaved ? ', autosaved' : ''}`);
          break;
        case 'output_validation':
          console.log(`  🧪 output validation ${event.validation.status}: score ${event.validation.score}`);
          for (const finding of event.validation.findings.slice(0, 3)) {
            console.log(`     ${finding.severity.toUpperCase()} ${finding.message}`);
          }
          break;
        case 'done':
          if (!assistantText.trim()) console.log(`\n${buildConsoleToolOnlyResponse({ toolCalls, toolSummaries, errors, doneReason: event.reason })}\n`);
          break;
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
