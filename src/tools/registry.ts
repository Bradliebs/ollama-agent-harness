import type { Tool, ToolPermissionCategory, ToolRiskLevel } from '../types';
import { BashTool } from './bashTool';
import { FileEditTool, FileReadTool, FileWriteTool, FileMoveTool, FileDeleteTool, ListFilesTool, ListUploadsTool } from './fileTools';
import { GrepTool } from './grepTool';
import { AnalyzePatternsTool, ConsolidateTool, EvolveTool, ImproveSkillTool, PromotePatternTool, ReflectTool } from './learningTools';
import { MemoryReadTool, MemoryWriteTool } from './memoryTools';
import { AudioTranscribeTool, ImageAnalyzeTool } from './multimodalTools';
import { PdfExtractTablesTool, PdfMetadataTool, PdfReadTool, PdfRenderPageTool } from './pdfTool';
import { CuratorPreviewTool } from './curatorTools';
import { DocumentExportTool } from './documentTools';
import { RagListIndexesTool, RagSearchTool } from './ragTools';
import { CreateSkillTool, ListSkillsTool, SkillTool } from './skillTools';
import { WebFetchTool } from './webFetchTool';
import { WebReadTool, WebSearchTool } from './webSearchTool';
import { DesktopScreenshotTool } from './desktopTools';
import { BrowserBookmarksTool } from './browserTools';
import { InstallSkillTool } from './skillInstallTool';
import { EmailDraftTool, EmailSendTool } from './emailTools';
import { TelegramNotifyTool } from './telegramTools';
import { CalendarReadTool } from './calendarTools';

export interface ToolRegistryEntry {
  tool: Tool;
  toolset: string;
  source: 'builtin' | 'runtime';
  enabledByDefault: boolean;
  /** Coarse risk used by the dashboard, permission UI, and workflow runner. */
  riskLevel: ToolRiskLevel;
  /** Coarse permission category for grouping. */
  permissionCategory: ToolPermissionCategory;
  /** True when the tool implements a meaningful dry-run mode. */
  canDryRun: boolean;
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
  { tool: FileReadTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: FileWriteTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'high', permissionCategory: 'write', canDryRun: false },
  { tool: FileEditTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'high', permissionCategory: 'write', canDryRun: false },
  { tool: FileMoveTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'high', permissionCategory: 'write', canDryRun: false },
  { tool: FileDeleteTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'high', permissionCategory: 'write', canDryRun: false },
  { tool: ListFilesTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: ListUploadsTool, toolset: 'files', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: BashTool, toolset: 'shell', source: 'builtin', enabledByDefault: true, riskLevel: 'high', permissionCategory: 'shell', canDryRun: false },
  { tool: WebFetchTool, toolset: 'web', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'network', canDryRun: false },
  { tool: WebSearchTool, toolset: 'web', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'network', canDryRun: false },
  { tool: WebReadTool, toolset: 'web', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'network', canDryRun: false },
  { tool: GrepTool, toolset: 'search', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: SkillTool, toolset: 'skills', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'skills', canDryRun: false },
  { tool: ListSkillsTool, toolset: 'skills', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'skills', canDryRun: false },
  { tool: CreateSkillTool, toolset: 'skills', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'skills', canDryRun: false },
  { tool: MemoryWriteTool, toolset: 'memory', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'memory', canDryRun: false },
  { tool: MemoryReadTool, toolset: 'memory', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'memory', canDryRun: false },
  { tool: ReflectTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'learning', canDryRun: false },
  { tool: AnalyzePatternsTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'learning', canDryRun: false },
  { tool: PromotePatternTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'learning', canDryRun: false },
  { tool: ConsolidateTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'learning', canDryRun: false },
  { tool: EvolveTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'learning', canDryRun: false },
  { tool: ImproveSkillTool, toolset: 'learning', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'learning', canDryRun: false },
  { tool: ImageAnalyzeTool, toolset: 'media', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'media', canDryRun: false },
  { tool: AudioTranscribeTool, toolset: 'media', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'media', canDryRun: false },
  { tool: PdfReadTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: PdfMetadataTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: PdfRenderPageTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: PdfExtractTablesTool, toolset: 'pdf', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: RagSearchTool, toolset: 'rag', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'rag', canDryRun: false },
  { tool: RagListIndexesTool, toolset: 'rag', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'rag', canDryRun: false },
  { tool: CuratorPreviewTool, toolset: 'curator', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: DesktopScreenshotTool, toolset: 'desktop', source: 'builtin', enabledByDefault: false, riskLevel: 'medium', permissionCategory: 'desktop', canDryRun: false },
  { tool: BrowserBookmarksTool, toolset: 'browser', source: 'builtin', enabledByDefault: false, riskLevel: 'medium', permissionCategory: 'browser', canDryRun: false },
  { tool: InstallSkillTool, toolset: 'skills', source: 'builtin', enabledByDefault: false, riskLevel: 'medium', permissionCategory: 'skills', canDryRun: false },
  { tool: EmailDraftTool, toolset: 'communications', source: 'builtin', enabledByDefault: false, riskLevel: 'medium', permissionCategory: 'write', canDryRun: false },
  { tool: EmailSendTool, toolset: 'communications', source: 'builtin', enabledByDefault: false, riskLevel: 'high', permissionCategory: 'network', canDryRun: false },
  { tool: TelegramNotifyTool, toolset: 'communications', source: 'builtin', enabledByDefault: false, riskLevel: 'high', permissionCategory: 'network', canDryRun: false },
  { tool: CalendarReadTool, toolset: 'communications', source: 'builtin', enabledByDefault: true, riskLevel: 'low', permissionCategory: 'read', canDryRun: false },
  { tool: DocumentExportTool, toolset: 'documents', source: 'builtin', enabledByDefault: true, riskLevel: 'medium', permissionCategory: 'write', canDryRun: false },
];
