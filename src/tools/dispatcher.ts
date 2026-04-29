import type { Tool, ToolCall, ToolResult } from '../types';
import type { HookPipeline } from '../extensibility/hookPipeline';
import { trackToolUsage } from '../learning/engine';
import type { RuntimeTracer } from '../core/tracing';

export interface DispatchResult {
  call: ToolCall;
  result: ToolResult;
}

export interface DispatchOptions {
  hooks?: HookPipeline;
  trackUsage?: boolean;
  tracer?: RuntimeTracer;
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
    options: DispatchOptions = {},
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
        readOnly.map((call) => this.executeSingle(call, permissionCheck, options)),
      );
      for (const result of parallel) {
        results.push(result);
        onResult?.(result);
      }
    }

    // Exclusive tools run serially
    for (const call of exclusive) {
      const result = await this.executeSingle(call, permissionCheck, options);
      results.push(result);
      onResult?.(result);
    }

    return results;
  }

  private async executeSingle(
    call: ToolCall,
    permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const dispatchSpan = options.tracer?.startSpan('tool.dispatch', { tool: call.name });
    if (options.hooks) {
      const hookSpan = options.tracer?.startSpan('hook.pre_tool_use', { tool: call.name });
      const hookResult = await options.hooks.execute({
        eventType: 'PreToolUse',
        toolName: call.name,
        toolInput: call.input,
      });
      hookSpan?.end('ok', { action: hookResult.action ?? 'continue' });
      if (hookResult.action === 'block') {
        dispatchSpan?.end('ok', { blockedByHook: true });
        return {
          call,
          result: {
            success: false,
            output: `Blocked by hook: ${hookResult.reason ?? 'no reason given'}`,
            error: hookResult.reason,
          },
        };
      }
      if (hookResult.modifiedInput) {
        call = { ...call, input: hookResult.modifiedInput };
      }
    }

    // Permission gate
    if (permissionCheck) {
      const permissionSpan = options.tracer?.startSpan('permission.check', { tool: call.name });
      const perm = await permissionCheck(call);
      permissionSpan?.end(perm.allowed ? 'ok' : 'error', { allowed: perm.allowed, reason: perm.reason });
      if (!perm.allowed) {
        dispatchSpan?.end('ok', { permissionDenied: true });
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
      dispatchSpan?.end('error', { missingTool: true });
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
      const startTime = Date.now();
      const toolSpan = options.tracer?.startSpan('tool.execute', { tool: call.name });
      const result = await tool.execute(call.input);
      const durationMs = Date.now() - startTime;
      toolSpan?.end(result.success ? 'ok' : 'error', { durationMs, success: result.success });
      if (options.trackUsage) {
        trackToolUsage(call.name, call.input, result.success, durationMs).catch(() => {});
      }
      if (options.hooks) {
        const postHookSpan = options.tracer?.startSpan('hook.post_tool_use', { tool: call.name });
        const postHook = await options.hooks.execute({
          eventType: 'PostToolUse',
          toolName: call.name,
          toolInput: call.input,
          toolOutput: result.output,
        });
        postHookSpan?.end('ok', { modifiedOutput: Boolean(postHook.modifiedOutput) });
        if (postHook.modifiedOutput) {
          dispatchSpan?.end(result.success ? 'ok' : 'error', { outputModified: true, success: result.success });
          return { call, result: { ...result, output: postHook.modifiedOutput } };
        }
      }
      dispatchSpan?.end(result.success ? 'ok' : 'error', { success: result.success });
      return { call, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dispatchSpan?.fail(error);
      if (options.trackUsage) {
        trackToolUsage(call.name, call.input, false).catch(() => {});
      }
      if (options.hooks) {
        const failureHookSpan = options.tracer?.startSpan('hook.post_tool_use_failure', { tool: call.name });
        await options.hooks.execute({
          eventType: 'PostToolUseFailure',
          toolName: call.name,
          toolInput: call.input,
          error: msg,
        });
        failureHookSpan?.end('ok');
      }
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
