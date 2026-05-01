#!/usr/bin/env node

import * as readline from 'readline';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { PermissionEngine } from '../permissions/engine';
import { SessionStorage } from '../persistence/sessionStorage';
import { assembleSystemContext } from '../context/assembly';
import { checkSetupHealth, type SetupHealthResult } from '../setup/health';
import type { ModelRoutingPolicy } from '../agents/modelRouting';
import { OUTPUT_VALIDATION_PROFILES, parseOutputValidationProfile, type OutputValidationProfile } from '../core/outputValidation';
import { formatCliHelp, resolveCliCommand } from './commands';
import type { LoopConfig, PermissionMode } from '../types';

interface CliOptions {
  command?: 'doctor';
  model: string;
  host: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  summarizerModel?: string;
  modelRouting: ModelRoutingPolicy;
  prompt?: string;
  visionModel: string;
  audioTranscribeCommand: string;
  audioSamplePath: string;
  outputValidation?: OutputValidationProfile;
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
  console.log(formatCliHelp(OUTPUT_VALIDATION_PROFILES.map((profile) => profile.profile)));
}

export async function main(): Promise<void> {
  const options = parseArgs();

  if (options.command === 'doctor') {
    const result = await checkSetupHealth({
      host: options.host,
      visionModel: options.visionModel,
      audioTranscribeCommand: options.audioTranscribeCommand,
      audioSamplePath: options.audioSamplePath || undefined,
    });
    console.log(formatSetupHealth(result));
    if (!result.ollama.ok || (options.visionModel ? !result.vision.ok : false) || (options.audioTranscribeCommand ? !result.audio.ok : false)) {
      process.exitCode = 1;
    }
    return;
  }

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
    outputValidation: options.outputValidation ? { enabled: true, profile: options.outputValidation } : undefined,
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
      case 'output_validation':
        console.error(`🧪 output validation ${event.validation.status}: score ${event.validation.score}`);
        for (const finding of event.validation.findings.slice(0, 5)) {
          console.error(`  ${finding.severity.toUpperCase()} ${finding.message}`);
        }
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
        case 'output_validation':
          console.log(`  🧪 output validation ${event.validation.status}: score ${event.validation.score}`);
          for (const finding of event.validation.findings.slice(0, 3)) {
            console.log(`     ${finding.severity.toUpperCase()} ${finding.message}`);
          }
          break;
        case 'done':
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
