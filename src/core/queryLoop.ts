import type { Message } from 'ollama';
import { OllamaClient } from './ollamaClient';
import type { Tool, ToolCall, ToolResult, LoopConfig, LoopEvent } from '../types';
import { toolToSchema } from '../types/tool';
import type { HookPipeline } from '../extensibility/hookPipeline';
import { trackToolUsage } from '../learning/engine';

export interface QueryLoopDeps {
  client: OllamaClient;
  tools: Tool[];
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;
  hooks?: HookPipeline;
}

export async function* queryLoop(
  config: LoopConfig,
  deps: QueryLoopDeps,
  initialMessages: Message[] = [],
): AsyncGenerator<LoopEvent> {
  const { maxTurns, abortSignal } = config;
  const { client, tools, permissionCheck, hooks } = deps;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const ollamaTools = tools.map(toolToSchema);

  const messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    ...initialMessages,
  ];

  let turn = 0;

  while (turn < maxTurns) {
    if (abortSignal?.aborted) {
      yield { type: 'done', reason: 'aborted', turns: turn };
      return;
    }

    turn++;

    let assistantMessage: Message;
    try {
      const result = await client.chat(messages, ollamaTools);
      assistantMessage = result.message;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message: `Model call failed: ${msg}`, recoverable: true };
      yield { type: 'done', reason: 'error', turns: turn };
      return;
    }

    messages.push(assistantMessage);

    // Stop condition: text-only response (no tool calls)
    if (!assistantMessage.tool_calls?.length) {
      yield { type: 'text', content: assistantMessage.content };
      yield { type: 'done', reason: 'completed', turns: turn };
      return;
    }

    // Parse tool calls from the assistant message
    const toolCalls: ToolCall[] = assistantMessage.tool_calls.map((tc) => ({
      name: tc.function.name,
      input: (tc.function.arguments ?? {}) as Record<string, unknown>,
    }));

    // Classify tools: read-only can run in parallel, exclusive runs serially
    const readOnlyCalls: ToolCall[] = [];
    const exclusiveCalls: ToolCall[] = [];
    for (const call of toolCalls) {
      const tool = toolMap.get(call.name);
      if (tool?.isReadOnly) {
        readOnlyCalls.push(call);
      } else {
        exclusiveCalls.push(call);
      }
    }

    // Dispatch read-only tools in parallel
    const readOnlyResults = await Promise.all(
      readOnlyCalls.map((call) => executeTool(call, toolMap, permissionCheck, hooks)),
    );
    for (const { call, result } of readOnlyResults) {
      yield { type: 'tool_call', call };
      yield { type: 'tool_result', call, result };
      messages.push({ role: 'tool', content: result.output });
    }

    // Dispatch exclusive tools serially
    for (const call of exclusiveCalls) {
      const { result } = await executeTool(call, toolMap, permissionCheck, hooks);
      yield { type: 'tool_call', call };
      yield { type: 'tool_result', call, result };
      messages.push({ role: 'tool', content: result.output });
    }
  }

  // Max turns reached
  yield { type: 'done', reason: 'max_turns', turns: turn };
}

async function executeTool(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
  hooks?: HookPipeline,
): Promise<{ call: ToolCall; result: ToolResult }> {
  // PreToolUse hook — can block or modify input
  if (hooks) {
    const hookResult = await hooks.execute({
      eventType: 'PreToolUse',
      toolName: call.name,
      toolInput: call.input,
    });
    if (hookResult.action === 'block') {
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

  // Permission check
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

  // Find tool
  const tool = toolMap.get(call.name);
  if (!tool) {
    return {
      call,
      result: {
        success: false,
        output: `Unknown tool: '${call.name}'`,
        error: `Tool '${call.name}' not found`,
      },
    };
  }

  // Execute
  try {
    const startTime = Date.now();
    const result = await tool.execute(call.input);
    const durationMs = Date.now() - startTime;

    // Track tool usage for pattern detection (self-learning)
    trackToolUsage(call.name, call.input, result.success, durationMs).catch(() => {});

    // PostToolUse hook — can modify output or inject context
    if (hooks) {
      const postHook = await hooks.execute({
        eventType: 'PostToolUse',
        toolName: call.name,
        toolInput: call.input,
        toolOutput: result.output,
      });
      if (postHook.modifiedOutput) {
        return { call, result: { ...result, output: postHook.modifiedOutput } };
      }
    }

    return { call, result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Track failure for pattern detection
    trackToolUsage(call.name, call.input, false).catch(() => {});

    // PostToolUseFailure hook
    if (hooks) {
      await hooks.execute({
        eventType: 'PostToolUseFailure',
        toolName: call.name,
        toolInput: call.input,
        error: msg,
      });
    }

    return {
      call,
      result: {
        success: false,
        output: `Tool '${call.name}' failed: ${msg}`,
        error: msg,
      },
    };
  }
}
