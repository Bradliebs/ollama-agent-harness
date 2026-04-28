import { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
import { BashTool } from './bashTool';
import { WebFetchTool } from './webFetchTool';
import { GrepTool } from './grepTool';
import { SkillTool, ListSkillsTool, CreateSkillTool } from './skillTools';
import { MemoryWriteTool, MemoryReadTool } from './memoryTools';
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
  ];
}

export { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
export { BashTool } from './bashTool';
export { WebFetchTool } from './webFetchTool';
export { GrepTool } from './grepTool';
export { SkillTool, ListSkillsTool, CreateSkillTool } from './skillTools';
export { MemoryWriteTool, MemoryReadTool } from './memoryTools';
export { ToolDispatcher } from './dispatcher';
