import type { Tool, ToolResult } from '../types';

const MAX_RESULTS = 8;
const MAX_CONTENT = 50_000;
const SPARSE_TEXT_MIN_CHARS = 600;

/**
 * WebSearchTool — searches the web using DuckDuckGo's HTML interface.
 * No API key required. Works locally and privately.
 */
export const WebSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web and return a list of results with titles, URLs, and snippets. Uses DuckDuckGo (no API key needed).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'number', description: 'Max results to return (default: 8)' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const maxResults = Math.min((input.max_results as number) ?? MAX_RESULTS, 20);

    try {
      const encoded = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OllamaHarness/1.0)',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return { success: false, output: `Search failed: HTTP ${response.status}`, error: `HTTP ${response.status}` };
      }

      const html = await response.text();
      const results = parseDuckDuckGoResults(html, maxResults);

      if (results.length === 0) {
        return { success: true, output: `No results found for "${query}"` };
      }

      const output = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return { success: true, output: `Search results for "${query}":\n\n${output}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Search failed: ${msg}`, error: msg };
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results have class="result__a" for links and class="result__snippet" for snippets
  const resultBlocks = html.split(/class="result\s/);

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];

    // Extract title and URL
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)</);
    if (!linkMatch) continue;

    let url = linkMatch[1];
    const title = decodeHtmlEntities(linkMatch[2].trim());

    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const uddgMatch = url.match(/uddg=([^&]*)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
    const snippet = snippetMatch
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]*>/g, '').trim())
      : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/**
 * WebReadTool — fetches a URL and extracts readable text content,
 * stripping HTML tags, scripts, styles, and navigation.
 * Returns clean, readable text instead of raw HTML.
 */
export const WebReadTool: Tool = {
  name: 'web_read',
  description: 'Fetch a web page and extract its readable text content (strips HTML, scripts, styles, nav). Better than web_fetch for reading articles, docs, and pages.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to read' },
    },
    required: ['url'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OllamaHarness/1.0)',
          'Accept': 'text/html,application/xhtml+xml,text/plain',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        return { success: false, output: `HTTP ${response.status} ${response.statusText}`, error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();

      // If it's plain text or JSON, return as-is
      if (!contentType.includes('html')) {
        const truncated = body.length > MAX_CONTENT ? body.slice(0, MAX_CONTENT) + '\n...(truncated)' : body;
        return { success: true, output: truncated };
      }

      // Extract readable content from HTML
      const text = extractReadableText(body);
      const fallback = isSparseReadableText(text) && isWeatherPage(url, text)
        ? await buildWeatherFallback(url, body)
        : '';
      const combined = fallback ? `${text}\n\n${fallback}` : text;
      const truncated = combined.length > MAX_CONTENT ? combined.slice(0, MAX_CONTENT) + '\n...(truncated)' : combined;

      return { success: true, output: `Content from ${url}:\n\n${truncated}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read: ${msg}`, error: msg };
    }
  },
};

function extractReadableText(html: string): string {
  let text = html;

  // Remove scripts, styles, and head
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert common elements to text equivalents
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<h[1-6][^>]*>/gi, '\n## ');
  text = text.replace(/<li[^>]*>/gi, '• ');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

function isSparseReadableText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (normalized.length < SPARSE_TEXT_MIN_CHARS) return true;
  if (lines.length <= 8 && /maps? & charts|climate|specialist forecasts/i.test(normalized)) return true;
  return false;
}

function isWeatherPage(url: string, text: string): boolean {
  return /weather|forecast|metoffice|accuweather|weather\.com/i.test(url + ' ' + text);
}

async function buildWeatherFallback(url: string, html: string): Promise<string> {
  const query = buildWeatherFallbackQuery(url, html);
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OllamaHarness/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return sparseWeatherFallbackNotice(query);
    }
    const results = rankWeatherResults(parseDuckDuckGoResults(await response.text(), 8)).slice(0, 5);
    if (results.length === 0) {
      return sparseWeatherFallbackNotice(query);
    }
    const rendered = results.map((result, index) => `${index + 1}. ${result.title} [${weatherSourceLabel(result.url)}]\n   ${result.url}\n   ${result.snippet}`).join('\n\n');
    return `[Weather fallback]\nThe primary forecast page exposed sparse text, likely because forecast details are rendered dynamically. Use these search-derived forecast snippets as fallback context for the answer.\nQuery: ${query}\n\n${rendered}`;
  } catch {
    return sparseWeatherFallbackNotice(query);
  }
}

function buildWeatherFallbackQuery(url: string, html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const seed = decodeHtmlEntities((heading ?? title ?? new URL(url).hostname).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const cleaned = seed.replace(/\|.*$/, '').replace(/- Met Office.*$/i, '').trim();
  return `${cleaned || 'local'} weather forecast today`;
}

function sparseWeatherFallbackNotice(query: string): string {
  return `[Weather fallback]\nThe primary forecast page exposed sparse text, likely because forecast details are rendered dynamically. Search fallback query attempted: ${query}`;
}

function rankWeatherResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((left, right) => weatherResultScore(right) - weatherResultScore(left));
}

function weatherResultScore(result: SearchResult): number {
  const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
  let score = 0;
  if (/metoffice\.gov\.uk|weather\.metoffice\.gov\.uk/.test(haystack)) score += 50;
  if (/bbc\.co\.uk\/weather|weather\.com|accuweather\.com/.test(haystack)) score += 35;
  if (/forecast|weather|temperature|wind|rain/.test(haystack)) score += 12;
  if (/today|hourly|latest|now/.test(haystack)) score += 8;
  if (/advert|shopping|map/.test(haystack)) score -= 10;
  return score;
}

function weatherSourceLabel(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('metoffice.gov.uk')) return 'official forecast';
  if (lower.includes('bbc.co.uk/weather')) return 'public forecast';
  if (lower.includes('weather.com') || lower.includes('accuweather.com')) return 'forecast provider';
  return 'search result';
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
