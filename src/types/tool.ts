import type { Message } from 'ollama';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isReadOnly: boolean;
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
