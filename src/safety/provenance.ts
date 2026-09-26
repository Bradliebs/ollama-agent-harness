// Provenance tracking for side effects.
//
// Tool output from the web, a browser page or an inbound email is untrusted:
// it can inform the model's decisions, but it must never be what authorises a
// side effect. This module keeps a per-run index of values that appeared in
// untrusted content (URLs, email addresses, commands) and in trusted content
// (the user's messages and the system prompt, which includes the user's own
// identity notes). Before a side-effecting tool runs, its sensitive arguments
// are checked: a value that appears ONLY in untrusted content means the model
// is acting on something a web page (or email) told it, so the call needs the
// user's approval, even in dontAsk mode.
//
// It is a heuristic tripwire, not a proof: a value the model invents is not
// flagged, and a value the user typed is always trusted.

import { EXTERNAL_CONTENT_TAG } from './untrustedWrap';

export type ProvenanceLabel = 'user' | 'system' | 'web' | 'browser' | 'email' | 'workspace-file' | 'tool';

export interface ProvenanceSource {
  tool: string;
  label: ProvenanceLabel;
  /** Where the content came from, e.g. the URL a page was read from. */
  origin?: string;
}

export interface ProvenanceFinding {
  tool: string;
  arg: string;
  kind: 'url' | 'email' | 'command';
  value: string;
  sources: ProvenanceSource[];
}

export interface ProvenanceVerdict {
  findings: ProvenanceFinding[];
  reason: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]\\]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MIN_COMMAND_CHARS = 12;
const EXTERNAL_BLOCK = new RegExp(`<${EXTERNAL_CONTENT_TAG}\\b([^>]*)>([\\s\\S]*?)</${EXTERNAL_CONTENT_TAG}>`, 'gi');

const UNTRUSTED_TOOLS: Array<[RegExp, ProvenanceLabel]> = [
  [/^web_/, 'web'],
  [/^browser_/, 'browser'],
  [/^(email_(read|list|search|inbox|fetch)|gmail_|outlook_)/, 'email'],
  [/^(rss_|fetch_url|http_)/, 'web'],
];

export function labelForTool(toolName: string): ProvenanceLabel {
  for (const [pattern, label] of UNTRUSTED_TOOLS) if (pattern.test(toolName)) return label;
  if (/^(file_read|list_files|grep|pdf_read)$/.test(toolName)) return 'workspace-file';
  return 'tool';
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?]+$/, '');
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeCommand(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_PATTERN) ?? []).map(normalizeUrl).filter((url): url is string => Boolean(url)))];
}

export function extractEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL_PATTERN) ?? []).map((email) => email.toLowerCase()))];
}

interface SinkArg {
  arg: string;
  kinds: Array<'url' | 'email' | 'command'>;
}

/** Side-effecting tools and which arguments could carry an injected value. */
const SINKS: Record<string, SinkArg[]> = {
  email_send: [{ arg: 'to', kinds: ['email'] }, { arg: 'cc', kinds: ['email'] }, { arg: 'bcc', kinds: ['email'] }, { arg: 'attachments', kinds: ['url'] }],
  email_draft: [{ arg: 'to', kinds: ['email'] }, { arg: 'cc', kinds: ['email'] }],
  bash: [{ arg: 'command', kinds: ['url', 'email', 'command'] }],
  docker_exec: [{ arg: 'command', kinds: ['url', 'email', 'command'] }],
  browser_fill: [{ arg: 'value', kinds: ['url', 'email'] }],
};

export function isSideEffectSink(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'web_fetch') {
    const method = typeof input?.method === 'string' ? input.method.toUpperCase() : 'GET';
    return method !== 'GET' && method !== 'HEAD';
  }
  return toolName in SINKS;
}

export class ProvenanceLedger {
  private readonly trustedText: string[] = [];
  private readonly trustedUrls = new Set<string>();
  private readonly trustedEmails = new Set<string>();
  private readonly untrustedUrls = new Map<string, ProvenanceSource[]>();
  private readonly untrustedEmails = new Map<string, ProvenanceSource[]>();
  private readonly untrustedTexts: Array<{ text: string; source: ProvenanceSource }> = [];

  /** Record content the user (or the user's own configuration) supplied. */
  recordTrusted(text: string): void {
    if (!text) return;
    this.trustedText.push(normalizeCommand(text));
    for (const url of extractUrls(text)) this.trustedUrls.add(url);
    for (const email of extractEmails(text)) this.trustedEmails.add(email);
  }

  /** Record a tool result; untrusted tools and wrapped external content are indexed. */
  recordToolResult(toolName: string, input: Record<string, unknown>, output: unknown): ProvenanceLabel {
    const text = typeof output === 'string' ? output : '';
    const label = labelForTool(toolName);
    if (!text) return label;
    const origin = typeof input?.url === 'string' ? input.url : typeof input?.query === 'string' ? `search: ${input.query}` : undefined;
    if (label === 'web' || label === 'browser' || label === 'email') {
      this.indexUntrusted(text, { tool: toolName, label, ...(origin ? { origin } : {}) });
      return label;
    }
    // Other tools can still relay external content (e.g. a PDF of a web page);
    // wrapUntrusted marks those segments explicitly.
    for (const match of text.matchAll(EXTERNAL_BLOCK)) {
      const labelAttr = /label="([^"]*)"/.exec(match[1] ?? '')?.[1];
      this.indexUntrusted(match[2] ?? '', { tool: toolName, label: 'web', ...(labelAttr ? { origin: labelAttr } : origin ? { origin } : {}) });
    }
    return label;
  }

  private indexUntrusted(text: string, source: ProvenanceSource): void {
    this.untrustedTexts.push({ text: normalizeCommand(text), source });
    if (this.untrustedTexts.length > 200) this.untrustedTexts.shift();
    for (const url of extractUrls(text)) this.untrustedUrls.set(url, [...(this.untrustedUrls.get(url) ?? []), source].slice(-3));
    for (const email of extractEmails(text)) this.untrustedEmails.set(email, [...(this.untrustedEmails.get(email) ?? []), source].slice(-3));
  }

  /**
   * Check a side-effecting call. Returns a verdict when any sensitive argument
   * carries a value found only in untrusted content; null when the call is safe
   * to run without asking.
   */
  checkCall(toolName: string, input: Record<string, unknown>): ProvenanceVerdict | null {
    if (!isSideEffectSink(toolName, input)) return null;
    const sinkArgs = toolName === 'web_fetch' ? [{ arg: 'url', kinds: ['url' as const] }] : SINKS[toolName] ?? [];
    const findings: ProvenanceFinding[] = [];
    for (const sink of sinkArgs) {
      const raw = input?.[sink.arg];
      const values = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : typeof raw === 'string' ? [raw] : [];
      for (const value of values) {
        if (sink.kinds.includes('email')) {
          for (const email of extractEmails(value)) {
            const sources = this.untrustedEmails.get(email);
            if (sources && !this.trustedEmails.has(email)) findings.push({ tool: toolName, arg: sink.arg, kind: 'email', value: email, sources });
          }
        }
        if (sink.kinds.includes('url')) {
          for (const url of extractUrls(value)) {
            const sources = this.untrustedUrls.get(url);
            if (sources && !this.trustedUrls.has(url)) findings.push({ tool: toolName, arg: sink.arg, kind: 'url', value: url, sources });
          }
        }
        if (sink.kinds.includes('command')) {
          const command = normalizeCommand(value);
          if (command.length >= MIN_COMMAND_CHARS && !this.trustedText.some((text) => text.includes(command))) {
            const hits = this.untrustedTexts.filter((entry) => entry.text.includes(command)).map((entry) => entry.source);
            if (hits.length > 0) findings.push({ tool: toolName, arg: sink.arg, kind: 'command', value: value.trim().slice(0, 200), sources: hits.slice(-3) });
          }
        }
      }
    }
    if (findings.length === 0) return null;
    return { findings, reason: describeFindings(findings) };
  }
}

function describeSource(source: ProvenanceSource): string {
  return source.origin ? `${source.tool} (${source.origin})` : source.tool;
}

export function describeFindings(findings: ProvenanceFinding[]): string {
  const parts = findings.slice(0, 3).map((finding) => {
    const what = finding.kind === 'command' ? `the command "${finding.value}"` : `${finding.kind === 'email' ? 'the address' : 'the URL'} ${finding.value}`;
    const from = [...new Set(finding.sources.map(describeSource))].join(', ');
    return `${what} in "${finding.arg}" came only from untrusted content (${from}), not from you`;
  });
  return `Provenance check: ${parts.join('; ')}. Approve only if you asked for this.`;
}

/** HARNESS_PROVENANCE=0 disables the check (default on). */
export function resolveProvenanceEnabled(): boolean {
  const env = process.env.HARNESS_PROVENANCE?.toLowerCase();
  return !(env === '0' || env === 'off' || env === 'false');
}
