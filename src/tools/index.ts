import { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
import { BashTool } from './bashTool';
import { WebFetchTool } from './webFetchTool';
import { GrepTool } from './grepTool';
import { SkillTool, ListSkillsTool, CreateSkillTool } from './skillTools';
import { MemoryWriteTool, MemoryReadTool } from './memoryTools';
import { ReflectTool, AnalyzePatternsTool, PromotePatternTool, ConsolidateTool, EvolveTool, ImproveSkillTool } from './learningTools';
import { WebSearchTool, WebReadTool } from './webSearchTool';
import { ImageAnalyzeTool, AudioTranscribeTool } from './multimodalTools';
import { PdfReadTool } from './pdfTool';
import type { Tool } from '../types';

export function getBuiltinTools(): Tool[] {
  return [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    ListFilesTool,
    BashTool,
    WebFetchTool,
    GrepTool,
    SkillTool,
    ListSkillsTool,
    CreateSkillTool,
    MemoryWriteTool,
    MemoryReadTool,
    ReflectTool,
    AnalyzePatternsTool,
    PromotePatternTool,
    ConsolidateTool,
    EvolveTool,
    ImproveSkillTool,
    WebSearchTool,
    WebReadTool,
    ImageAnalyzeTool,
    AudioTranscribeTool,
    PdfReadTool,
  ];
}

export { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
export { BashTool } from './bashTool';
export { WebFetchTool } from './webFetchTool';
export { GrepTool } from './grepTool';
export { SkillTool, ListSkillsTool, CreateSkillTool } from './skillTools';
export { MemoryWriteTool, MemoryReadTool } from './memoryTools';
export { ReflectTool, AnalyzePatternsTool, PromotePatternTool, ConsolidateTool, EvolveTool, ImproveSkillTool } from './learningTools';
export { WebSearchTool, WebReadTool } from './webSearchTool';
export { ImageAnalyzeTool, AudioTranscribeTool } from './multimodalTools';
export { PdfReadTool } from './pdfTool';
export { ToolDispatcher } from './dispatcher';
