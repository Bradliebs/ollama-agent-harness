import type { Tool } from '../types';
import { BashTool } from './bashTool';
import { FileEditTool, FileReadTool, FileWriteTool, ListFilesTool, ListUploadsTool } from './fileTools';
import { GrepTool } from './grepTool';
import { AnalyzePatternsTool, ConsolidateTool, EvolveTool, ImproveSkillTool, PromotePatternTool, ReflectTool } from './learningTools';
import { MemoryReadTool, MemoryWriteTool } from './memoryTools';
import { AudioTranscribeTool, ImageAnalyzeTool } from './multimodalTools';
import { PdfExtractTablesTool, PdfMetadataTool, PdfReadTool, PdfRenderPageTool } from './pdfTool';
import { CreateSkillTool, ListSkillsTool, SkillTool } from './skillTools';
import { WebFetchTool } from './webFetchTool';
import { WebReadTool, WebSearchTool } from './webSearchTool';

export interface ToolRegistryEntry {
  tool: Tool;
  toolset: string;
  source: 'builtin' | 'runtime';
  enabledByDefault: boolean;
}

export class ToolRegistry {
  private entries = new Map<string, ToolRegistryEntry>();

  register(entry: ToolRegistryEntry): void {
    if (this.entries.has(entry.tool.name)) {
      throw new Error(`Tool already registered: ${entry.tool.name}`);
    }
    this.entries.set(entry.tool.name, entry);
  }

  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name);
  }

  listEntries(): ToolRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  listTools(): Tool[] {
    return this.listEntries().map((entry) => entry.tool);
  }

  listToolsets(): string[] {
    return Array.from(new Set(this.listEntries().map((entry) => entry.toolset))).sort();
  }

  listToolsForToolset(toolset: string): Tool[] {
    return this.listEntries().filter((entry) => entry.toolset === toolset).map((entry) => entry.tool);
  }
}

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of BUILTIN_TOOL_ENTRIES) registry.register(entry);
  return registry;
}

export const BUILTIN_TOOL_ENTRIES: ToolRegistryEntry[] = [
  { tool: FileReadTool, toolset: 'files', source: 'builtin', enabledByDefault: true },
  { tool: FileWriteTool, toolset: 'files', source: 'builtin', enabledByDefault: true },
  { tool: FileEditTool, toolset: 'files', source: 'builtin', enabledByDefault: true },
  { tool: ListFilesTool, toolset: 'files', source: 'builtin', enabledByDefault: true },
  { tool: ListUploadsTool, toolset: 'files', source: 'builtin', enabledByDefault: true },
  { tool: BashTool, toolset: 'shell', source: 'builtin', enabledByDefault: true },
  { tool: WebFetchTool, toolset: 'web', source: 'builtin', enabledByDefault: true },
  { tool: WebSearchTool, toolset: 'web', source: 'builtin', enabledByDefault: true },
  { tool: WebReadTool, toolset: 'web', source: 'builtin', enabledByDefault: true },
  { tool: GrepTool, toolset: 'search', source: 'builtin', enabledByDefault: true },
  { tool: SkillTool, toolset: 'skills', source: 'builtin', enabledByDefault: true },
  { tool: ListSkillsTool, toolset: 'skills', source: 'builtin', enabledByDefault: true },
  { tool: CreateSkillTool, toolset: 'skills', source: 'builtin', enabledByDefault: true },
  { tool: MemoryWriteTool, toolset: 'memory', source: 'builtin', enabledByDefault: true },
  { tool: MemoryReadTool, toolset: 'memory', source: 'builtin', enabledByDefault: true },
  { tool: ReflectTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: AnalyzePatternsTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: PromotePatternTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: ConsolidateTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: EvolveTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: ImproveSkillTool, toolset: 'learning', source: 'builtin', enabledByDefault: true },
  { tool: ImageAnalyzeTool, toolset: 'media', source: 'builtin', enabledByDefault: true },
  { tool: AudioTranscribeTool, toolset: 'media', source: 'builtin', enabledByDefault: true },
  { tool: PdfReadTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true },
  { tool: PdfMetadataTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true },
  { tool: PdfRenderPageTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true },
  { tool: PdfExtractTablesTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true },
];
