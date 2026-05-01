import type { Message } from 'ollama';

/** Coarse risk classification used by the dashboard, permission UI, and workflow runner. */
export type ToolRiskLevel = 'low' | 'medium' | 'high';

/** Coarse permission category. Used to render the permission matrix and group tools. */
export type ToolPermissionCategory = 'read' | 'write' | 'shell' | 'network' | 'media' | 'memory' | 'learning' | 'skills' | 'rag';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isReadOnly: boolean;
  /** Optional risk level for UI/workflow surfaces. Defaults to 'low' when isReadOnly, else 'medium'. */
  riskLevel?: ToolRiskLevel;
  /** Optional permission category. */
  permissionCategory?: ToolPermissionCategory;
  /** When true, the tool implements a meaningful dry-run mode via `dryRun: true` in input. */
  canDryRun?: boolean;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toolToSchema(tool: Tool): OllamaToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export { Message };
