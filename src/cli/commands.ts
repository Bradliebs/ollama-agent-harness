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
