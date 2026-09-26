import type { Message } from 'ollama';
import type { ChatOptions } from '../core/chatClient';
import { toolToSchema, type Tool } from '../types/tool';
import type { CapabilityProfile, PromptTierRecommendation, ScaffoldLevelRecommendation, ToolModeRecommendation } from './capabilityProfile';

export interface ModelAdapterInput {
  tools: Tool[];
  systemPrompt: string;
  profile?: CapabilityProfile;
  relevanceScores?: Map<string, number>;
}

export interface ModelRequestPlan {
  tools: Tool[];
  systemPrompt: string;
  toolMode: ToolModeRecommendation;
  promptTier: PromptTierRecommendation;
  scaffoldLevel: ScaffoldLevelRecommendation;
  format?: ChatOptions['format'];
  contextBudgetTokens?: number;
}

export function compileModelRequestPlan(input: ModelAdapterInput): ModelRequestPlan {
  if (!input.profile) {
    return {
      tools: input.tools,
      systemPrompt: input.systemPrompt,
      toolMode: 'native',
      promptTier: 'full',
      scaffoldLevel: 'medium',
    };
  }

  const recommended = input.profile.recommended;
  const tools = selectTools(input.tools, recommended.maxToolsPerStep, input.relevanceScores);
  const format = recommended.toolMode === 'constrained-json' ? constrainedToolCallSchema(tools) : undefined;
  return {
    tools,
    systemPrompt: needsPromptToolMode(recommended.toolMode)
      ? appendToolInstructionBlock(input.systemPrompt, tools, recommended.toolMode)
      : input.systemPrompt,
    toolMode: recommended.toolMode,
    promptTier: recommended.promptTier,
    scaffoldLevel: recommended.scaffoldLevel,
    format,
    contextBudgetTokens: recommended.contextBudgetTokens,
  };
}

export function parseConstrainedToolCall(text: string): Message['tool_calls'] {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const calls = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls
    : Array.isArray(parsed.calls)
      ? parsed.calls
      : parsed.tool_call
        ? [parsed.tool_call]
        : [];
  const normalized = calls.flatMap((call) => normalizeCall(call));
  return normalized.length > 0 ? normalized : undefined;
}

function selectTools(tools: Tool[], maxToolsPerStep: number, relevanceScores?: Map<string, number>): Tool[] {
  const required = tools.filter((tool) => tool.required);
  const requiredNames = new Set(required.map((tool) => tool.name));
  const optional = tools
    .filter((tool) => !requiredNames.has(tool.name))
    .map((tool, index) => ({ tool, index, score: relevanceScores?.get(tool.name) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, maxToolsPerStep - required.length))
    .map((entry) => entry.tool);
  return [...required, ...optional];
}

function needsPromptToolMode(toolMode: ToolModeRecommendation): boolean {
  return toolMode === 'json-in-text' || toolMode === 'constrained-json';
}

function appendToolInstructionBlock(systemPrompt: string, tools: Tool[], toolMode: ToolModeRecommendation): string {
  const schemas = tools.map(toolToSchema).map((schema) => ({
    name: schema.function.name,
    description: schema.function.description,
    parameters: schema.function.parameters,
  }));
  const block = [
    '',
    'Tool-call compatibility mode:',
    'When you need a tool, reply with JSON only and no prose.',
    'Use exactly this shape:',
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    toolMode === 'constrained-json'
      ? 'Your reply is constrained by a JSON schema; still choose exactly one listed tool.'
      : 'Do not wrap the JSON in Markdown fences.',
    `Available tools: ${JSON.stringify(schemas)}`,
  ].join('\n');
  return `${systemPrompt}${block}`;
}

function constrainedToolCallSchema(tools: Tool[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tool_call: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: tools.map((tool) => tool.name) },
          arguments: { type: 'object' },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    required: ['tool_call'],
    additionalProperties: false,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

type OllamaToolCall = NonNullable<Message['tool_calls']>[number];

function normalizeCall(value: unknown): OllamaToolCall[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const obj = value as Record<string, unknown>;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function as Record<string, unknown> : undefined;
  const name = obj.name ?? obj.tool ?? obj.tool_name ?? fn?.name;
  const args = obj.arguments ?? obj.parameters ?? fn?.arguments ?? {};
  if (typeof name !== 'string' || !name.trim()) return [];
  const parsedArgs = typeof args === 'string' ? parseJsonObject(args) ?? {} : args;
  return [{
    function: {
      name,
      arguments: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
        ? parsedArgs as Record<string, unknown>
        : {},
    },
  }] as OllamaToolCall[];
}
