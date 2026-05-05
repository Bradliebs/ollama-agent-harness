import type { Tool, ToolResult } from '../types';
import { invokeMcpServerTool, readMcpServerDefinitionsSync, type McpServerDefinition } from '../extensibility/mcpRuntime';
import type { ToolRegistryEntry } from './registry';

export function createMcpToolEntries(projectDir: string, definitions: McpServerDefinition[] = readMcpServerDefinitionsSync(projectDir)): ToolRegistryEntry[] {
  const entries: ToolRegistryEntry[] = [];
  for (const server of definitions) {
    if (!server.enabled) continue;
    for (const remoteTool of server.tools) {
      const toolName = createMcpHarnessToolName(server.id, remoteTool.name);
      const tool: Tool = {
        name: toolName,
        description: remoteTool.description || `Invoke MCP tool ${remoteTool.name} on ${server.id}.`,
        parameters: remoteTool.inputSchema && Object.keys(remoteTool.inputSchema).length > 0
          ? remoteTool.inputSchema
          : { type: 'object', additionalProperties: true },
        isReadOnly: false,
        riskLevel: 'high',
        permissionCategory: 'shell',
        execute: async (input) => formatMcpToolResult(await invokeMcpServerTool(projectDir, server.id, remoteTool.name, input)),
      };
      entries.push({
        tool,
        toolset: `mcp:${server.id}`,
        source: 'runtime',
        enabledByDefault: false,
        riskLevel: 'high',
        permissionCategory: 'shell',
        canDryRun: false,
      });
    }
  }
  return entries;
}

export function createMcpHarnessToolName(serverId: string, toolName: string): string {
  const normalizedServer = serverId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const normalizedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp_${normalizedServer}__${normalizedTool}`.slice(0, 120);
}

function formatMcpToolResult(result: { content?: Array<Record<string, unknown>>; isError?: boolean }): ToolResult {
  const output = Array.isArray(result.content) && result.content.length > 0
    ? result.content.map(formatMcpContentBlock).filter(Boolean).join('\n')
    : JSON.stringify(result);
  return {
    success: result.isError !== true,
    output,
    error: result.isError === true ? output : undefined,
  };
}

function formatMcpContentBlock(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.type === 'string') return JSON.stringify(block);
  return JSON.stringify(block);
}