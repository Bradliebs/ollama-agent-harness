import type { OutputValidationResult } from '../core/outputValidation';

export type EvidenceRunKind = 'chat' | 'automation' | 'autonomy';
export type EvidenceMode = 'build' | 'debug' | 'research' | 'review' | 'operate' | 'automate' | 'teach' | 'general';

export interface EvidenceToolSummary {
  name: string;
  success: boolean;
  inputSummary?: string;
  outputSummary?: string;
}

export interface EvidenceFileSummary {
  path: string;
  action: 'read' | 'write' | 'edit' | 'move' | 'delete' | 'unknown';
}

export interface EvidenceCommandSummary {
  command: string;
  success?: boolean;
  outputSummary?: string;
}

export interface EvidenceMyceliumSummary {
  taskType?: string;
  highRisk?: boolean;
  route?: string[];
  protectedEdges?: number;
  selectionReasons?: Record<string, string>;
}

export interface EvidenceRecoverySummary {
  sessionId?: string;
  rollbackState?: string;
  stopReason?: string;
}

export interface EvidenceCard {
  id: string;
  kind: EvidenceRunKind;
  mode: EvidenceMode;
  createdAt: string;
  request: string;
  model?: string;
  backend?: string;
  permissionMode?: string;
  capabilityGrantCount?: number;
  toolSuccessRate?: number;
  tools: EvidenceToolSummary[];
  files: EvidenceFileSummary[];
  commands: EvidenceCommandSummary[];
  validation?: OutputValidationResult;
  mycelium?: EvidenceMyceliumSummary;
  artifacts: Array<{ title: string; kind: string }>;
  recovery?: EvidenceRecoverySummary;
}