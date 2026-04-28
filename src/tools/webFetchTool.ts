import type { Tool, ToolResult } from '../types';

const MAX_RESPONSE_SIZE = 50_000;

export const WebFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch the content of a URL and return the response body as text',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
    },
    required: ['url'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const method = (input.method as string) ?? 'GET';

    try {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      const truncated = body.length > MAX_RESPONSE_SIZE
        ? body.slice(0, MAX_RESPONSE_SIZE) + '\n...(truncated)'
        : body;

      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText}\n${truncated}`,
          error: `HTTP ${response.status}`,
        };
      }

      return { success: true, output: truncated };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Fetch failed: ${msg}`, error: msg };
    }
  },
};
