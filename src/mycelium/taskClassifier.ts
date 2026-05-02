// Mycelial Context Router — task classifier
//
// Rule-based classifier for v1. Maps a user query to a task type with an
// associated exploration rate, node/edge limits, and high-risk flag.
// Conservative on the safety side: ambiguous high-risk verbs route to the
// stricter category.

export type MyceliumTaskType =
  | 'coding'
  | 'debugging'
  | 'research'
  | 'planning'
  | 'writing'
  | 'creative'
  | 'general'
  | 'financial_analysis'
  | 'financial_execution'
  | 'medical'
  | 'legal'
  | 'safety_critical';

export interface MyceliumTaskClassification {
  type: MyceliumTaskType;
  highRisk: boolean;
  explorationRate: number;
  maxSelectedNodes: number;
  maxSelectedEdges: number;
  maxDepth: number;
  matchedKeywords: string[];
  reason: string;
}

// Per Network.md spec defaults.
const EXPLORATION_RATE: Record<MyceliumTaskType, number> = {
  safety_critical: 0.02,
  financial_execution: 0.02,
  medical: 0.02,
  legal: 0.02,
  debugging: 0.08,
  coding: 0.10,
  planning: 0.15,
  general: 0.15,
  writing: 0.18,
  financial_analysis: 0.20,
  creative: 0.25,
  research: 0.30,
};

const NODE_LIMIT: Record<MyceliumTaskType, number> = {
  safety_critical: 8,
  medical: 8,
  legal: 8,
  financial_execution: 8,
  debugging: 14,
  coding: 14,
  planning: 12,
  writing: 12,
  general: 10,
  creative: 16,
  research: 18,
  financial_analysis: 12,
};

const HIGH_RISK: ReadonlySet<MyceliumTaskType> = new Set([
  'safety_critical',
  'financial_execution',
  'medical',
  'legal',
]);

// Keyword tables. Order matters when categories overlap: high-risk wins.
// Each entry pairs a regex with the task type it implies.
const RULES: Array<{ type: MyceliumTaskType; pattern: RegExp }> = [
  // safety-critical first — catches destructive, irreversible, security-sensitive verbs
  { type: 'safety_critical', pattern: /\b(delete\s+production|drop\s+(table|database)|rm\s+-rf|deploy\s+to\s+production|irreversible|wipe|format\s+disk|exploit|bypass|escalate\s+privilege|leak\s+credentials?|exfiltrate|backdoor|live\s+system|production\s+(secrets?|credentials?))\b/i },
  // financial execution
  { type: 'financial_execution', pattern: /\b(place\s+(an?\s+)?order|execute\s+trade|buy\s+\d|sell\s+\d|transfer\s+(funds|money)|wire\s+(funds|money)|rebalance\s+now|broker\s+(submit|execute)|liquidate)\b/i },
  // medical
  { type: 'medical', pattern: /\b(diagnos(e|is)|prescribe|medication|dosage|symptoms?|disease|treatment\s+plan|drug\s+interaction|medical\s+advice)\b/i },
  // legal
  { type: 'legal', pattern: /\b(legal\s+advice|lawsuit|sue\s+|contract\s+(review|draft)|court\s+filing|attorney|legal\s+rights|liability\s+for)\b/i },
  // debugging
  { type: 'debugging', pattern: /\b(bug|stack\s*trace|traceback|exception|error\s+(message|log)|failing\s+test|broken|not\s+working|crash(es|ed|ing)?|regression|reproduce)\b/i },
  // planning — checked before coding so "build a roadmap" classifies as planning
  { type: 'planning', pattern: /\b(roadmap|architect(ure)?|blueprint|strategy|workflow|design\s+(a\s+)?system|phase\s+\d|milestones?|build\s+a\s+(plan|roadmap|strategy)|make\s+a\s+plan|plan\s+(out|for|the))\b/i },
  // coding — broad code-related verbs, with code-y direct objects required for ambiguous verbs
  { type: 'coding', pattern: /\b(implement|refactor|build\s+(a\s+)?(\w+\s+)?(function|class|module|component|api|service|cli)|write\s+(a\s+)?(\w+\s+){0,2}(function|class|module|component|api|service|cli|test|script)|add\s+(a\s+)?(feature|endpoint|method)|patch|scaffold|port\s+to)\b/i },
  // research
  { type: 'research', pattern: /\b(research|investigate|look\s+up|find\s+out|sources?\s+for|evidence|compare\s+\w+\s+(to|vs|against)|literature|state\s+of\s+the\s+art|latest\s+(on|in|research))\b/i },
  // writing
  { type: 'writing', pattern: /\b(write\s+(an?\s+)?(email|article|post|summary|description|copy)|rewrite|draft\s+(an?\s+)?(message|email|note)|proofread|edit\s+the)\b/i },
  // creative
  { type: 'creative', pattern: /\b(brainstorm|moodboard|story\s+idea|brand\s+(voice|name)|aesthetic|visual\s+design|tagline|slogan|concept\s+art)\b/i },
  // financial analysis (analysis-only, not execution)
  { type: 'financial_analysis', pattern: /\b(portfolio\s+analysis|backtest|valuation|fundamentals|technical\s+analysis|risk\s+model|sharpe\s+ratio)\b/i },
];

export function classifyTask(query: string): MyceliumTaskClassification {
  const matched: Array<{ type: MyceliumTaskType; keyword: string }> = [];
  for (const rule of RULES) {
    const m = query.match(rule.pattern);
    if (m) matched.push({ type: rule.type, keyword: m[0] });
  }

  // High-risk wins over everything else, regardless of order.
  const highRiskMatch = matched.find((m) => HIGH_RISK.has(m.type));
  const winner = highRiskMatch ?? matched[0];
  const type: MyceliumTaskType = winner?.type ?? 'general';

  const matchedKeywords = matched.map((m) => m.keyword);
  const reason = winner
    ? `matched ${type} keyword "${winner.keyword}"${highRiskMatch && winner !== matched[0] ? ' (high-risk override)' : ''}`
    : 'no specific keywords matched; defaulted to general';

  return {
    type,
    highRisk: HIGH_RISK.has(type),
    explorationRate: EXPLORATION_RATE[type],
    maxSelectedNodes: NODE_LIMIT[type],
    maxSelectedEdges: NODE_LIMIT[type] * 2,
    maxDepth: 3,
    matchedKeywords,
    reason,
  };
}

export function getExplorationRate(type: MyceliumTaskType): number {
  return EXPLORATION_RATE[type];
}

export function getNodeLimit(type: MyceliumTaskType): number {
  return NODE_LIMIT[type];
}

export function isHighRiskTaskType(type: MyceliumTaskType): boolean {
  return HIGH_RISK.has(type);
}
