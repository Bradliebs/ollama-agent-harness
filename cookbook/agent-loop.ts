/**
 * Ollama Agent Harness — Agent Loop Recipe
 *
 * The core agentic loop pattern from the Claude Code paper:
 * A simple while-loop that calls the model, dispatches tools, and repeats.
 *
 * This recipe demonstrates:
 * - The ReAct pattern (Reason → Act → Observe → Repeat)
 * - Tool dispatch with permission checking
 * - Streaming events via async generator
 * - Stop conditions (text-only response, max turns, abort)
 */

import type { Message, Tool } from 'ollama';

// --- Types ---

export interface LoopConfig {
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
  abortSignal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isReadOnly: boolean;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export type LoopEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string; success: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: string; turns: number };

// --- Permission Check (simplified) ---

interface PermissionRule {
  type: 'allow' | 'deny';
  tool: string;
  pattern?: string;
}

function checkPermission(
  rules: PermissionRule[],
  toolName: string,
  _input: Record<string, unknown>,
): { allowed: boolean; reason?: string } {
  // Deny-first: deny rules always override allow rules
  for (const rule of rules) {
    if (rule.type === 'deny' && (rule.tool === toolName || rule.tool === '*')) {
      return { allowed: false, reason: `Denied by rule: ${rule.tool}` };
    }
  }
  for (const rule of rules) {
    if (rule.type === 'allow' && (rule.tool === toolName || rule.tool === '*')) {
      return { allowed: true };
    }
  }
  // Default: deny unrecognized
  return { allowed: false, reason: 'No matching rule — denied by default' };
}

// --- Tool Dispatch ---

async function dispatchTools(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
  toolMap: Map<string, ToolDefinition>,
  permissionRules: PermissionRule[],
): Promise<Array<{ name: string; result: string; success: boolean }>> {
  // Classify tools as read-only (concurrent) or exclusive (serial)
  const readOnly: typeof toolCalls = [];
  const exclusive: typeof toolCalls = [];

  for (const call of toolCalls) {
    const tool = toolMap.get(call.name);
    if (tool?.isReadOnly) {
      readOnly.push(call);
    } else {
      exclusive.push(call);
    }
  }

  const results: Array<{ name: string; result: string; success: boolean }> = [];

  // Run read-only tools in parallel
  if (readOnly.length > 0) {
    const parallel = await Promise.all(
      readOnly.map(async (call) => {
        const perm = checkPermission(permissionRules, call.name, call.input);
        if (!perm.allowed) {
          return { name: call.name, result: `Permission denied: ${perm.reason}`, success: false };
        }
        try {
          const tool = toolMap.get(call.name)!;
          const output = await tool.execute(call.input);
          return { name: call.name, result: output, success: true };
        } catch (error) {
          return { name: call.name, result: `Error: ${error instanceof Error ? error.message : String(error)}`, success: false };
        }
      }),
    );
    results.push(...parallel);
  }

  // Run exclusive tools serially
  for (const call of exclusive) {
    const perm = checkPermission(permissionRules, call.name, call.input);
    if (!perm.allowed) {
      results.push({ name: call.name, result: `Permission denied: ${perm.reason}`, success: false });
      continue;
    }
    try {
      const tool = toolMap.get(call.name)!;
      const output = await tool.execute(call.input);
      results.push({ name: call.name, result: output, success: true });
    } catch (error) {
      results.push({
        name: call.name,
        result: `Error: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      });
    }
  }

  return results;
}

// --- The Agent Loop ---

export async function* agentLoop(
  config: LoopConfig,
  userMessage: string,
  permissionRules: PermissionRule[] = [{ type: 'allow', tool: '*' }],
): AsyncGenerator<LoopEvent> {
  const { maxTurns, abortSignal } = config;
  const toolMap = new Map(config.tools.map((t) => [t.name, t]));

  // Build Ollama tool definitions
  const ollamaTools: Tool[] = config.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  // Message history
  const messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let turn = 0;

  while (turn < maxTurns) {
    // Check abort
    if (abortSignal?.aborted) {
      yield { type: 'done', reason: 'aborted', turns: turn };
      return;
    }

    turn++;

    // Call model (simplified — use OllamaHarnessClient in production)
    const { Ollama } = await import('ollama');
    const client = new Ollama();
    const response = await client.chat({
      model: config.model,
      messages,
      tools: ollamaTools,
      stream: false,
    });

    const assistantMessage = response.message;
    messages.push(assistantMessage);

    // Stop condition: text-only response (no tool calls)
    if (!assistantMessage.tool_calls?.length) {
      yield { type: 'text', content: assistantMessage.content };
      yield { type: 'done', reason: 'completed', turns: turn };
      return;
    }

    // Parse tool calls
    const toolCalls = assistantMessage.tool_calls.map((tc) => ({
      name: tc.function.name,
      input: (tc.function.arguments ?? {}) as Record<string, unknown>,
    }));

    // Emit tool call events
    for (const call of toolCalls) {
      yield { type: 'tool_call', name: call.name, input: call.input };
    }

    // Dispatch tools with permission checking and concurrency classification
    const results = await dispatchTools(toolCalls, toolMap, permissionRules);

    // Emit results and add to message history
    for (const result of results) {
      yield { type: 'tool_result', name: result.name, result: result.result, success: result.success };
      messages.push({ role: 'tool', content: result.result });
    }
  }

  // Max turns reached
  yield { type: 'done', reason: 'max_turns', turns: turn };
}

// --- Usage Example ---

async function example() {
  const tools: ToolDefinition[] = [
    {
      name: 'list_files',
      description: 'List files in a directory',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path' } },
        required: ['path'],
      },
      isReadOnly: true,
      execute: async (input) => {
        const fs = await import('fs/promises');
        const files = await fs.readdir(input.path as string);
        return files.join('\n');
      },
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
      isReadOnly: true,
      execute: async (input) => {
        const fs = await import('fs/promises');
        return await fs.readFile(input.path as string, 'utf-8');
      },
    },
  ];

  const config: LoopConfig = {
    model: 'qwen2.5-coder:7b',
    systemPrompt: 'You are a helpful coding assistant. Use tools when needed.',
    tools,
    maxTurns: 10,
  };

  for await (const event of agentLoop(config, 'List the files in the current directory')) {
    switch (event.type) {
      case 'text':
        console.log(`\nAssistant: ${event.content}`);
        break;
      case 'tool_call':
        console.log(`\n🔧 Calling: ${event.name}(${JSON.stringify(event.input)})`);
        break;
      case 'tool_result':
        console.log(`  → ${event.success ? '✅' : '❌'} ${event.result.slice(0, 200)}`);
        break;
      case 'done':
        console.log(`\n--- Done (${event.reason}, ${event.turns} turns) ---`);
        break;
    }
  }
}

example().catch(console.error);
