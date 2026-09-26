export interface CliOptionDef {
  flags: string[];
  valueName?: string;
  description: string;
}

export interface CliCommandDef {
  name: string;
  description: string;
  aliases?: string[];
  usage: string;
  options: CliOptionDef[];
}

export const CLI_COMMAND_REGISTRY: CliCommandDef[] = [
  {
    name: 'run',
    description: 'Interactive mode or headless single-prompt mode',
    aliases: [],
    usage: 'harness [options] | harness -p "your prompt"',
    options: [
      { flags: ['-m', '--model'], valueName: '<name>', description: 'Ollama model (default: qwen2.5-coder:7b)' },
      { flags: ['--backend'], valueName: '<name>', description: 'Chat backend: ollama (default), cerebras, cloudflare, groq, github, mistral, openrouter, openai, replicate' },
      { flags: ['--compact-remote-smoke'], description: 'Use a tiny no-tools prompt for free-tier remote backend smoke tests' },
      { flags: ['--host'], valueName: '<url>', description: 'Ollama host (default: http://localhost:11434)' },
      { flags: ['--mode'], valueName: '<mode>', description: 'Permission mode: default, acceptEdits, dontAsk' },
      { flags: ['--max-turns'], valueName: '<n>', description: 'Max agent loop turns (default: 50)' },
      { flags: ['--unproductive-turn-limit'], valueName: '<n>', description: 'Stop early after N consecutive turns with no file edits (default: off)' },
      { flags: ['--summarizer-model'], valueName: '<name>', description: 'Optional smaller model for context compaction' },
      { flags: ['--small-helper-model'], valueName: '<name>', description: 'Model for bounded read-only helper agents' },
      { flags: ['--default-helper-model'], valueName: '<name>', description: 'Model for normal helper agents' },
      { flags: ['--strong-helper-model'], valueName: '<name>', description: 'Model for escalated helper agents' },
      { flags: ['--helper-confidence-threshold'], valueName: '<n>', description: 'Escalate helpers below this confidence (default: 0.45)' },
      { flags: ['--vision-model'], valueName: '<name>', description: 'Vision model to check in Ollama' },
      { flags: ['--audio-command'], valueName: '<cmd>', description: 'Audio transcription command with {input}' },
      { flags: ['--audio-sample'], valueName: '<path>', description: 'Optional audio file path for an end-to-end transcription check' },
      { flags: ['--validate-output'], valueName: '<profile>', description: 'Validate final output against a built-in profile' },
      { flags: ['-p', '--prompt'], valueName: '<text>', description: 'Run a single prompt in headless mode' },
      { flags: ['-h', '--help'], description: 'Show this help' },
    ],
  },
  {
    name: 'doctor',
    description: 'Check Ollama, local runtime, media, tools, sessions, and automation setup',
    aliases: ['health'],
    usage: 'harness doctor [options]',
    options: [
      { flags: ['--host'], valueName: '<url>', description: 'Ollama host to check' },
      { flags: ['--vision-model'], valueName: '<name>', description: 'Vision model to check in Ollama' },
      { flags: ['--audio-command'], valueName: '<cmd>', description: 'Audio transcription command with {input}' },
      { flags: ['--audio-sample'], valueName: '<path>', description: 'Optional audio sample for transcription verification' },
      { flags: ['--watch'], valueName: '[seconds]', description: 'Re-run every N seconds (default 5). Press Ctrl+C to stop.' },
      { flags: ['--fix'], description: 'Auto-remediate diagnosed issues (vision pull, contextMaxTokens auto, prune agent-outputs)' },
      { flags: ['-y', '--yes'], description: 'Approve destructive fixes (e.g. ollama pull) without an interactive confirm' },
    ],
  },
  {
    name: 'mycelium',
    description: 'Inspect and manage the mycelial context router graph',
    aliases: [],
    usage: 'harness mycelium <subcommand> [options]',
    options: [
      { flags: ['init'], description: 'Create the mycelium graph store' },
      { flags: ['seed'], description: 'Seed generic safety/agent/verifier/workflow nodes' },
      { flags: ['status'], description: 'Show counts and recent reward' },
      { flags: ['route', '--query'], valueName: '"..."', description: 'Classify, route, and explain a query (add --dry-run to skip mutation)' },
      { flags: ['show-route'], description: 'Show the most recent episode + route' },
      { flags: ['show-node'], valueName: '<id>', description: 'Show details for a node' },
      { flags: ['show-edges'], valueName: '<id>', description: 'Show incoming/outgoing edges for a node' },
      { flags: ['decay'], description: 'Apply one decay cycle' },
      { flags: ['prune'], description: 'Archive weak edges' },
      { flags: ['export'], valueName: '<path>', description: 'Export graph as JSON' },
      { flags: ['classify', '--query'], valueName: '"..."', description: 'Print task classifier verdict' },
    ],
  },
  {
    name: 'tui',
    description: 'Open a terminal chat client that shares the running daemon session',
    aliases: [],
    usage: 'harness tui [--base-url <url>] [--model <name>]',
    options: [
      { flags: ['--base-url'], valueName: '<url>', description: 'Daemon base URL (default: http://127.0.0.1:4300)' },
      { flags: ['--model'], valueName: '<name>', description: 'Model id to send with chat requests (defaults to daemon current)' },
    ],
  },
  {
    name: 'simulate',
    description: 'Run scripted adversarial probes against a running daemon and report pass/fail',
    aliases: [],
    usage: 'harness simulate [--base-url <url>] [--model <name>] [--probe <id>] [--category <name>]',
    options: [
      { flags: ['--base-url'], valueName: '<url>', description: 'Daemon base URL (default: http://127.0.0.1:4300)' },
      { flags: ['--model'], valueName: '<name>', description: 'Model id to send with chat requests' },
      { flags: ['--probe'], valueName: '<id>', description: 'Run a single probe by id (repeatable)' },
      { flags: ['--category'], valueName: '<name>', description: 'Restrict to one category: prompt-injection, secret-exfil, tool-misuse, safety-refusal, baseline (repeatable)' },
      { flags: ['--probe-timeout'], valueName: '<ms>', description: 'Per-probe wall-clock cap in ms (default: 60000)' },
      { flags: ['--persist'], description: 'Persist the run as an EvalTraceRun under .harness/evals/ so the promotion gate counts it' },
    ],
  },
  {
    name: 'replay',
    description: 'Replay a recorded chat run deterministically against one or more models',
    aliases: [],
    usage: 'harness replay <runId|--last N> --model <name> [--model <name>] [--live] [--json]',
    options: [
      { flags: ['--last'], valueName: '<n>', description: 'Replay/benchmark the last N eligible chat runs' },
      { flags: ['--model'], valueName: '<name>', description: 'Model to replay with (repeatable)' },
      { flags: ['--live'], description: 'Use live read-only tools instead of recorded deterministic tool results' },
      { flags: ['--json'], description: 'Print JSON instead of a text table' },
    ],
  },
  {
    name: 'benchmark-history',
    description: 'Replay recent completed tool-using chat history across model candidates',
    aliases: [],
    usage: 'harness benchmark-history --models a,b [--last 10] [--json]',
    options: [
      { flags: ['--models'], valueName: '<a,b>', description: 'Comma-separated model list' },
      { flags: ['--last'], valueName: '<n>', description: 'Number of eligible chat runs to replay (default: 10)' },
      { flags: ['--json'], description: 'Print JSON instead of an aggregate table' },
    ],
  },
  {
    name: 'probe',
    description: 'Probe a model and save a capability profile',
    aliases: [],
    usage: 'harness probe <model> [--backend <name>] [--host <url>]',
    options: [
      { flags: ['--backend'], valueName: '<name>', description: 'Chat backend: ollama (default), openai, groq, github, etc.' },
      { flags: ['--host'], valueName: '<url>', description: 'Ollama host (default: http://localhost:11434)' },
      { flags: ['--max-context'], valueName: '<tokens>', description: 'Cap usable-context probe (default: 32000)' },
      { flags: ['--samples'], valueName: '<n>', description: 'Override per-probe sample count' },
    ],
  },
];

export function resolveCliCommand(name: string | undefined): CliCommandDef | undefined {
  if (!name) return undefined;
  const normalized = name.toLowerCase();
  return CLI_COMMAND_REGISTRY.find((command) => command.name === normalized || command.aliases?.includes(normalized));
}

export function formatCliHelp(outputValidationProfiles: string[]): string {
  const commands = CLI_COMMAND_REGISTRY.map((command) => `  ${command.usage.padEnd(32)} ${command.description}`).join('\n');
  const runCommand = resolveCliCommand('run');
  const options = runCommand?.options.map(formatOption).join('\n') ?? '';
  return `
Ollama Agent Harness - local-first agentic coding tool

Usage:
${commands}

Options:
${options}

Output validation profiles: ${outputValidationProfiles.join(', ')}
`;
}

function formatOption(option: CliOptionDef): string {
  const flags = option.flags.join(', ') + (option.valueName ? ` ${option.valueName}` : '');
  return `  ${flags.padEnd(34)} ${option.description}`;
}
