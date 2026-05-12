import type { Tool, ToolResult } from '../types';
import { listIndexes, search } from '../persistence/ragIndex';

let projectDir = process.cwd();
let ollamaHost = 'http://localhost:11434';

export function setRagRuntime(options: { projectDir?: string; ollamaHost?: string }): void {
  if (options.projectDir) projectDir = options.projectDir;
  if (options.ollamaHost) ollamaHost = options.ollamaHost;
}

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MAX_PREVIEW_CHARS = 800;

export const RagSearchTool: Tool = {
  name: 'rag_search',
  description: 'Search a local RAG index built in the Local RAG tab. Returns ranked text chunks with source paths and cosine scores.',
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'string', description: 'Name of the RAG index to query (build one in the Local RAG tab first)' },
      query: { type: 'string', description: 'Natural-language search query' },
      k: { type: 'number', description: `Maximum results to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})` },
    },
    required: ['index', 'query'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const indexName = typeof input.index === 'string' ? input.index.trim() : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const k = Math.max(1, Math.min(MAX_RESULTS, Number.isFinite(Number(input.k)) ? Number(input.k) : DEFAULT_RESULTS));
    if (!indexName) return { success: false, output: 'index is required', error: 'missing index' };
    if (!query) return { success: false, output: 'query is required', error: 'missing query' };
    try {
      const results = await search(projectDir, indexName, query, { k, ollamaHost });
      if (results.length === 0) {
        return { success: true, output: `No matches for "${query}" in index "${indexName}".` };
      }
      const lines = results.map((row, i) => {
        const preview = row.content.length > MAX_PREVIEW_CHARS ? row.content.slice(0, MAX_PREVIEW_CHARS) + '…' : row.content;
        return `[${i + 1}] score=${row.score.toFixed(3)} ${row.source} (chunk ${row.chunkNo})\n${preview}`;
      });
      return { success: true, output: lines.join('\n\n') };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `RAG search failed: ${msg}`, error: msg };
    }
  },
};

export const RagListIndexesTool: Tool = {
  name: 'rag_list_indexes',
  description: 'List local RAG indexes available for rag_search, with their chunk counts and backends.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    try {
      const indexes = await listIndexes(projectDir);
      if (indexes.length === 0) {
        return { success: true, output: 'No RAG indexes yet. Build one in the Local RAG tab.' };
      }
      const lines = indexes.map((i) => `${i.name}: ${i.chunks} chunks, ${i.files} files, backend=${i.backend} (${i.model})`);
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Could not list indexes: ${msg}`, error: msg };
    }
  },
};
