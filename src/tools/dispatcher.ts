import type { Tool, ToolCall, ToolResult } from '../types';

export interface DispatchResult {
  call: ToolCall;
  result: ToolResult;
}

export class ToolDispatcher {
  private toolMap: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  async dispatch(
    calls: ToolCall[],
    permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
    onResult?: (result: DispatchResult) => void,
  ): Promise<DispatchResult[]> {
    const readOnly: ToolCall[] = [];
    const exclusive: ToolCall[] = [];

    for (const call of calls) {
      const tool = this.toolMap.get(call.name);
      if (tool?.isReadOnly) {
        readOnly.push(call);
      } else {
        exclusive.push(call);
      }
    }

    const results: DispatchResult[] = [];

    // Read-only tools run in parallel
    if (readOnly.length > 0) {
      const parallel = await Promise.all(
        readOnly.map((call) => this.executeSingle(call, permissionCheck)),
      );
      for (const result of parallel) {
        results.push(result);
        onResult?.(result);
      }
    }

    // Exclusive tools run serially
    for (const call of exclusive) {
      const result = await this.executeSingle(call, permissionCheck);
      results.push(result);
      onResult?.(result);
    }

    return results;
  }

  private async executeSingle(
    call: ToolCall,
    permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
  ): Promise<DispatchResult> {
    // Permission gate
    if (permissionCheck) {
      const perm = await permissionCheck(call);
      if (!perm.allowed) {
        return {
          call,
          result: {
            success: false,
            output: `Permission denied for '${call.name}': ${perm.reason ?? 'no matching allow rule'}`,
            error: perm.reason,
          },
        };
      }
    }

    // Lookup tool
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      return {
        call,
        result: {
          success: false,
          output: `Unknown tool: '${call.name}'`,
          error: `Tool '${call.name}' not found in tool pool`,
        },
      };
    }

    // Execute with error boundary
    try {
      const result = await tool.execute(call.input);
      return { call, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        call,
        result: {
          success: false,
          output: `Tool '${call.name}' threw: ${msg}`,
          error: msg,
        },
      };
    }
  }

  getToolNames(): string[] {
    return Array.from(this.toolMap.keys());
  }

  hasToolWithName(name: string): boolean {
    return this.toolMap.has(name);
  }
}
