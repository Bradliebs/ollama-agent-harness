import { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
import { BashTool } from './bashTool';
import { WebFetchTool } from './webFetchTool';
import { GrepTool } from './grepTool';
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
  ];
}

export { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
export { BashTool } from './bashTool';
export { WebFetchTool } from './webFetchTool';
export { GrepTool } from './grepTool';
export { ToolDispatcher } from './dispatcher';
