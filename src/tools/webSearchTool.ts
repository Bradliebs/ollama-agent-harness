import type { Tool, ToolResult } from '../types';

const MAX_RESULTS = 8;
const MAX_CONTENT = 50_000;

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
      const truncated = text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) + '\n...(truncated)' : text;

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
