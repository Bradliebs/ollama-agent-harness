import { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
import { BashTool } from './bashTool';
import { WebFetchTool } from './webFetchTool';
import type { Tool } from '../types';

export function getBuiltinTools(): Tool[] {
  return [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    ListFilesTool,
    BashTool,
    WebFetchTool,
  ];
}

export { FileReadTool, FileWriteTool, FileEditTool, ListFilesTool } from './fileTools';
export { BashTool } from './bashTool';
export { WebFetchTool } from './webFetchTool';
export { ToolDispatcher } from './dispatcher';
