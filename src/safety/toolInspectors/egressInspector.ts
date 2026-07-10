import type { ToolCall } from '../../types';
import type { InspectionResult, InspectorContext, ToolInspector } from './inspector';

/**
 * Pure regex-based data-exfiltration detector for shell commands.
 *
 * Borrowed from goose's `crates/goose/src/security/egress_inspector.rs`.
 * Extracts outbound destinations from common command shapes:
 *   URLs (http/https/ftp), git@host:path, s3://, gs://,
 *   scp/rsync remote, ssh remote, docker push/login,
 *   generic network tools (nc, ncat, netcat, ftp, sftp, socat, httpie, xh, fetch).
 *
 * Default action: `requireApproval` — surfaces "this command will send data
 * to X" without hard-blocking, so legitimate `git push` / `curl api.foo`
 * still flow once the human confirms.
 *
 * Configure `allowDomains` for hosts that should pass silently
 * (e.g. `["github.com", "registry.npmjs.org"]`).
 */

export interface EgressInspectorOptions {
  /** Tool names this inspector reviews. Defaults to bash-like tools. */
  shellToolNames?: string[];
  /** Substring-match allow list for destination domains. */
  allowDomains?: string[];
  /** When true, raise to `deny` instead of `requireApproval`. */
  blockInsteadOfApprove?: boolean;
}

const DEFAULT_SHELL_TOOLS = ['bash', 'shell', 'execute'];

interface EgressDestination {
  kind: string;
  destination: string;
  domain: string;
}

export class EgressInspector implements ToolInspector {
  public readonly name = 'egress';
  private readonly shellTools: Set<string>;
  private readonly allowDomains: string[];
  private readonly blockInsteadOfApprove: boolean;

  constructor(opts: EgressInspectorOptions = {}) {
    this.shellTools = new Set(opts.shellToolNames ?? DEFAULT_SHELL_TOOLS);
    this.allowDomains = (opts.allowDomains ?? []).map((d) => d.toLowerCase());
    this.blockInsteadOfApprove = opts.blockInsteadOfApprove ?? false;
  }

  isEnabled(): boolean {
    return true;
  }

  async inspect(call: ToolCall, _context: InspectorContext): Promise<InspectionResult | null> {
    if (!this.shellTools.has(call.name)) return null;
    const command = extractCommand(call.input);
    if (!command) return null;

    const destinations = extractDestinations(command).filter(
      (d) => !this.isAllowed(d.domain),
    );
    if (destinations.length === 0) return null;

    const summary = destinations
      .slice(0, 5)
      .map((d) => `${d.kind}:${d.domain}`)
      .join(', ');
    const reason = `Command contacts external destination(s): ${summary}`;
    return {
      toolName: call.name,
      inspectorName: this.name,
      findingId: 'EGR-001',
      confidence: 0.7,
      action: this.blockInsteadOfApprove
        ? { kind: 'deny', reason }
        : { kind: 'requireApproval', reason, warning: reason },
    };
  }

  private isAllowed(domain: string): boolean {
    const d = domain.toLowerCase();
    return this.allowDomains.some((allow) => d === allow || d.endsWith(`.${allow}`));
  }
}

function extractCommand(input: Record<string, unknown>): string | undefined {
  const cmd = input.command ?? input.cmd ?? input.script;
  return typeof cmd === 'string' ? cmd : undefined;
}

const URL_RE = /(https?|ftp):\/\/[^\s'"<>|;&)]+/gi;
const GIT_SSH_RE = /git@([^:\s]+):([^\s'"]+)/g;
const S3_RE = /s3:\/\/([^/\s'"]+)(\/[^\s'"]*)?/g;
const GCS_RE = /gs:\/\/([^/\s'"]+)(\/[^\s'"]*)?/g;
const SCP_RSYNC_RE = /(?:scp|rsync)\s+.*?(?:\S+@)?([a-zA-Z0-9][\w.-]+):/g;
const SSH_RE = /\bssh\s+(?:-\w+\s+\S+\s+)*(?:\S+@)?([a-zA-Z0-9][\w.-]+)/g;
const DOCKER_RE = /\bdocker\s+(?:push|login)\s+(?:--\S+\s+)*([^\s'"]+)/g;
const GENERIC_NET_RE =
  /\b(fetch|nc|ncat|netcat|ftp|sftp|socat|httpie|xh)\b[^\n]*?\b((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,})\b/gi;

function extractDestinations(command: string): EgressDestination[] {
  const dests: EgressDestination[] = [];
  const seenKeys = new Set<string>();

  const push = (d: EgressDestination): void => {
    const key = `${d.kind}|${d.destination}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    dests.push(d);
  };

  for (const m of command.matchAll(URL_RE)) {
    const url = m[0];
    const domain = domainFromUrl(url);
    if (domain) push({ kind: 'url', destination: url, domain });
  }
  for (const m of command.matchAll(GIT_SSH_RE)) {
    push({ kind: 'git_remote', destination: `git@${m[1]}:${m[2]}`, domain: m[1] });
  }
  for (const m of command.matchAll(S3_RE)) {
    push({
      kind: 's3_bucket',
      destination: m[0],
      domain: `${m[1]}.s3.amazonaws.com`,
    });
  }
  for (const m of command.matchAll(GCS_RE)) {
    push({
      kind: 'gcs_bucket',
      destination: m[0],
      domain: `${m[1]}.storage.googleapis.com`,
    });
  }
  for (const m of command.matchAll(SCP_RSYNC_RE)) {
    push({ kind: 'scp_target', destination: m[0], domain: m[1] });
  }
  for (const m of command.matchAll(SSH_RE)) {
    if (!m[1].startsWith('-')) {
      push({ kind: 'ssh_target', destination: m[0], domain: m[1] });
    }
  }
  for (const m of command.matchAll(DOCKER_RE)) {
    const target = m[1];
    const domain = target.split('/')[0] ?? target;
    push({ kind: 'docker_registry', destination: target, domain });
  }
  const alreadyDomains = new Set(dests.map((d) => d.domain.toLowerCase()));
  for (const m of command.matchAll(GENERIC_NET_RE)) {
    const domain = m[2];
    if (!alreadyDomains.has(domain.toLowerCase())) {
      push({ kind: 'generic_network', destination: m[0], domain });
    }
  }
  return dests;
}

function domainFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.hostname || undefined;
  } catch {
    return undefined;
  }
}
