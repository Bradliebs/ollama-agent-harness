// Recall tool — exposes the personal knowledge graph to the agent.
//
// Lets the model ask "what do you know about X" without scanning sessions
// linearly. Read-only, low risk, no permission grant required.

import type { Tool, ToolResult } from '../types';
import { recall } from '../jarvis/knowledgeGraph';

export function createRecallTool(projectDir: string): Tool {
  return {
    name: 'kg_recall',
    description: 'Search the personal knowledge graph (entities, edges, facts ingested from past evidence cards) for anything matching the query. Returns the top entries.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query, e.g. "who edited payment.ts last".' },
        limit: { type: 'number', description: 'Max entries to return (default 10).' },
      },
      required: ['query'],
    },
    isReadOnly: true,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      if (!query.trim()) return { success: false, output: 'kg_recall: query is required', error: 'missing query' };
      const result = await recall(projectDir, query, limit);
      const lines: string[] = [];
      lines.push(`kg_recall: ${query}`);
      if (result.entities.length === 0 && result.edges.length === 0 && result.facts.length === 0) {
        lines.push('No matches.');
      }
      for (const e of result.entities) lines.push(`entity ${e.type}: ${e.name}${e.attributes ? ` ${JSON.stringify(e.attributes)}` : ''}`);
      for (const f of result.facts) lines.push(`fact: ${f.subject} ${f.predicate} ${f.object} (conf=${f.confidence})`);
      for (const ed of result.edges) lines.push(`edge: ${ed.from} --${ed.relation}--> ${ed.to}`);
      return { success: true, output: lines.join('\n') };
    },
  };
}

/** Static export for the registry default. Real projectDir is injected at runtime. */
export const RecallTool: Tool = createRecallTool(process.cwd());
