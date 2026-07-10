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
  requestedPath?: string;
  redirected?: boolean;
  redirectKind?: 'pattern' | 'agent-outputs';
  action: 'read' | 'write' | 'edit' | 'move' | 'delete' | 'unknown';
}

export interface EvidenceCommandSummary {
  command: string;
  success?: boolean;
  outputSummary?: string;
  // Structured proof parsed from the command's own output. Present only
  // when the command emitted a recognisable test summary (e.g. Jest), so
  // evidence can show "11 passed, 1 failed" rather than a bare boolean.
  testCounts?: { passed: number; failed: number; total: number };
}

export interface EvidenceMyceliumSummary {
  taskType?: string;
  highRisk?: boolean;
  route?: string[];
  protectedEdges?: number;
  selectionReasons?: Record<string, string>;
  /** Stable id of the episode recorded for this turn. Lets the client bind
   * a thumbs vote to the exact route it rated (see /api/mycelium/feedback). */
  episodeId?: string;
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