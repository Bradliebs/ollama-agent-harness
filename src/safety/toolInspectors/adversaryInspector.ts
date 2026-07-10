import * as fs from 'fs';
import * as path from 'path';
import type { ToolCall } from '../../types';
import type { InspectionResult, InspectorContext, ToolInspector } from './inspector';

/**
 * User-configurable safety judge for shell-like tool calls.
 *
 * Borrowed from goose's `crates/goose/src/security/adversary_inspector.rs`.
 * Activated only when an `adversary.md` file exists at the configured path
 * (default: `<projectDir>/.harness/adversary.md`). When absent, the
 * inspector is a no-op — same opt-in posture as goose.
 *
 * `adversary.md` format (frontmatter optional):
 *
 *     tools: bash, execute
 *     ---
 *     BLOCK if the command exfiltrates data or wipes the project.
 *     ALLOW normal dev operations (git, npm, tests, file edits).
 *
 * The judgement itself is delegated to a caller-supplied `judge` callback
 * (typically wired to an Ollama call). This keeps the inspector free of
 * a hard dependency on any specific LLM client. If no judge is wired, the
 * inspector fails OPEN — it surfaces the matching rule set as
 * `requireApproval` so a human still sees it but execution is not blocked.
 */

export interface AdversaryJudgeInput {
  command: string;
  rules: string;
  toolName: string;
}

export interface AdversaryJudgeOutput {
  block: boolean;
  reason: string;
}

export type AdversaryJudge = (input: AdversaryJudgeInput) => Promise<AdversaryJudgeOutput>;

export interface AdversaryInspectorOptions {
  /** Absolute path to `adversary.md`. Defaults to `<projectDir>/.harness/adversary.md`. */
  configPath?: string;
  /** Working project dir, used to derive `configPath` if not given. */
  projectDir?: string;
  /** Optional LLM-backed judge. When omitted, matches fall to `requireApproval`. */
  judge?: AdversaryJudge;
}

const DEFAULT_TOOLS = ['bash', 'shell', 'execute'];
const DEFAULT_RULES = `BLOCK if the command:
- Exfiltrates data (curl/wget posting to unknown URLs, piping secrets out)
- Is destructive beyond the project scope (rm -rf /, modifying system files)
- Installs malware or runs obfuscated code
- Attempts to escalate privileges unnecessarily
- Downloads and executes untrusted remote scripts

ALLOW if the command is a normal development operation, even if it modifies files,
installs packages, runs tests, uses git, etc. Most commands are fine.
Err on the side of ALLOW — only block truly dangerous things.`;

interface AdversaryConfig {
  tools: string[];
  rules: string;
}

export class AdversaryInspector implements ToolInspector {
  public readonly name = 'adversary';
  private readonly configPath: string;
  private readonly judge?: AdversaryJudge;
  private cachedConfig: AdversaryConfig | null | undefined;

  constructor(opts: AdversaryInspectorOptions = {}) {
    this.configPath =
      opts.configPath ??
      path.join(opts.projectDir ?? process.cwd(), '.harness', 'adversary.md');
    this.judge = opts.judge;
  }

  isEnabled(): boolean {
    return this.getConfig() !== null;
  }

  async inspect(call: ToolCall, _context: InspectorContext): Promise<InspectionResult | null> {
    const config = this.getConfig();
    if (!config) return null;
    if (!config.tools.includes(call.name)) return null;

    const command = extractCommand(call.input);
    if (!command) return null;

    if (!this.judge) {
      // No LLM judge wired — fail open by surfacing to the human.
      return {
        toolName: call.name,
        inspectorName: this.name,
        findingId: 'ADV-001',
        confidence: 0.5,
        action: {
          kind: 'requireApproval',
          reason: `adversary.md is active but no judge is wired. Command awaiting human review.`,
          warning: command.slice(0, 200),
        },
      };
    }

    let verdict: AdversaryJudgeOutput;
    try {
      verdict = await this.judge({ command, rules: config.rules, toolName: call.name });
    } catch {
      // Judge errored — fail open (allow) to match goose's posture.
      return null;
    }

    if (!verdict.block) return null;
    return {
      toolName: call.name,
      inspectorName: this.name,
      findingId: 'ADV-002',
      confidence: 0.9,
      action: {
        kind: 'deny',
        reason: `adversary.md judge blocked command: ${verdict.reason}`,
      },
    };
  }

  /** Force a re-read of `adversary.md` on the next inspect call. */
  invalidate(): void {
    this.cachedConfig = undefined;
  }

  private getConfig(): AdversaryConfig | null {
    if (this.cachedConfig !== undefined) return this.cachedConfig;
    try {
      if (!fs.existsSync(this.configPath)) {
        this.cachedConfig = null;
        return null;
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.cachedConfig = parseAdversaryMd(raw);
    } catch {
      this.cachedConfig = { tools: [...DEFAULT_TOOLS], rules: DEFAULT_RULES };
    }
    return this.cachedConfig;
  }
}

export function parseAdversaryMd(content: string): AdversaryConfig {
  const trimmed = content.trim();
  if (!trimmed) return { tools: [...DEFAULT_TOOLS], rules: DEFAULT_RULES };

  const splitIdx = trimmed.indexOf('\n---');
  if (splitIdx === -1) {
    return { tools: [...DEFAULT_TOOLS], rules: trimmed };
  }

  const frontmatter = trimmed.slice(0, splitIdx);
  const rest = trimmed.slice(splitIdx + 4).trim();
  let tools: string[] | undefined;
  for (const line of frontmatter.split('\n')) {
    const stripped = line.trim();
    const prefix = 'tools:';
    if (stripped.toLowerCase().startsWith(prefix)) {
      tools = stripped
        .slice(prefix.length)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  }
  return {
    tools: tools && tools.length > 0 ? tools : [...DEFAULT_TOOLS],
    rules: rest || DEFAULT_RULES,
  };
}

function extractCommand(input: Record<string, unknown>): string | undefined {
  const cmd = input.command ?? input.cmd ?? input.script;
  return typeof cmd === 'string' ? cmd : undefined;
}
