import type { ToolCall, ToolResult } from '../types';

// Per-run ledger of web sources. Research answers from real sessions almost
// never linked the pages they were built from (1 of 34 web-research sessions
// had a URL in its final answer), so the loop records successful web reads and
// appends a Sources list when the answer itself carries no links. It also
// remembers which URLs web_search actually returned, so a 404 on a URL the
// model invented can be called out as a guess.

export interface WebSource {
  url: string;
  title: string;
}

const READ_TOOLS = new Set(['web_read', 'web_fetch']);
const MAX_FOOTER_SOURCES = 8;
const MAX_TITLE_CHARS = 100;
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
export const SOURCES_FOOTER_HEADING = '**Sources**';

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,;:]+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Loose key so http/https, www., and trailing-slash variants match. */
function comparisonKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Strip characters that could break or inject markdown from page-controlled text. */
function sanitizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]()<>`*_|#\\!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_TITLE_CHARS ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : cleaned;
}

function extractTitle(output: string, url: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('Content from ') || line.startsWith('<')) continue;
    const candidate = sanitizeTitle(line.replace(/^#+\s*/, ''));
    if (candidate.length >= 8) return candidate;
  }
  return hostnameOf(url);
}

export class SourceLedger {
  private readonly sources = new Map<string, WebSource>();
  private readonly searchResultKeys = new Set<string>();

  /** Record URLs surfaced by a successful web_search. */
  recordSearchResults(call: ToolCall, result: ToolResult): void {
    if (call.name !== 'web_search' || !result.success || typeof result.output !== 'string') return;
    for (const match of result.output.match(URL_PATTERN) ?? []) {
      const url = normalizeUrl(match);
      if (url) this.searchResultKeys.add(comparisonKey(url));
    }
  }

  /** Record a successful web_read/web_fetch as a source. */
  recordRead(call: ToolCall, result: ToolResult): void {
    if (!READ_TOOLS.has(call.name) || !result.success) return;
    const raw = call.input?.url;
    if (typeof raw !== 'string') return;
    const url = normalizeUrl(raw);
    if (!url) return;
    const key = comparisonKey(url);
    if (this.sources.has(key)) return;
    const output = typeof result.output === 'string' ? result.output : '';
    this.sources.set(key, { url, title: extractTitle(output, url) });
  }

  /** True when web_search returned this URL earlier in the run. */
  cameFromSearch(rawUrl: string): boolean {
    const url = normalizeUrl(rawUrl);
    return url ? this.searchResultKeys.has(comparisonKey(url)) : false;
  }

  hasSearchResults(): boolean {
    return this.searchResultKeys.size > 0;
  }

  list(): WebSource[] {
    return Array.from(this.sources.values());
  }
}

/**
 * Hint appended to a 404/410 from web_read/web_fetch when the URL never came
 * from web_search, which in practice means the model guessed the path.
 */
export function guessedUrlHint(call: ToolCall, result: ToolResult, ledger: SourceLedger): string | null {
  if (!READ_TOOLS.has(call.name) || result.success) return null;
  const raw = call.input?.url;
  if (typeof raw !== 'string') return null;
  if (!/HTTP\s+(404|410)\b/.test(`${result.error ?? ''} ${result.output ?? ''}`)) return null;
  if (ledger.cameFromSearch(raw)) return null;
  return 'This URL did not come from web_search results, so it was probably guessed. Run web_search and read one of the returned result URLs instead of constructing URLs.';
}

/** Append a numbered Sources list when web sources were read and the answer has no links. */
export function appendSourcesFooter(text: string, sources: WebSource[]): string {
  if (!text || !text.trim() || sources.length === 0) return text;
  if (/https?:\/\//i.test(text)) return text;
  const lines = sources
    .slice(0, MAX_FOOTER_SOURCES)
    .map((source, index) => `${index + 1}. [${source.title}](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
  return `${text.trimEnd()}\n\n${SOURCES_FOOTER_HEADING}\n${lines.join('\n')}`;
}
