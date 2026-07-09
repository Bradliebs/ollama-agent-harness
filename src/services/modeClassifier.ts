// Mode Classifier — maps user intent to one of six operating modes.
//
// Extends the binary build/operate split in agenticServiceMode.ts with
// full mode classification: CHAT, BUILD, OPERATE, AUTOMATE, RESEARCH, MAINTAIN.

export type HarnessMode =
  | 'chat'
  | 'build'
  | 'operate'
  | 'automate'
  | 'research'
  | 'maintain';

export interface ModeClassification {
  mode: HarnessMode;
  confidence: number;
  reason: string;
  matchedPatterns: string[];
  suppressedModes: HarnessMode[];
}

// ─── Pattern tables ─────────────────────────────────────────────────

interface ModeRule {
  mode: HarnessMode;
  pattern: RegExp;
  label: string;
  /** Higher = checked first and wins ties. */
  priority: number;
}

const MODE_RULES: ModeRule[] = [
  // OPERATE — ongoing service behaviour, reminders, task management
  { mode: 'operate', priority: 90, label: 'send me reminders', pattern: /\b(sends? me\b.{0,30}\breminders?|remind me\b.{0,20}\b(daily|every|each)|check in with me|keep track|manage this|monitor this|notify me|add tasks|update tasks|close tasks|add notes|review daily|review weekly|follow up|ask me every morning|keep me honest|keep a log|let me add tasks|let me update tasks|let me close tasks|update for me|telegram reminder)\b/i },
  { mode: 'operate', priority: 85, label: 'bullet journal service', pattern: /\b(bullet journal|bullet proof journal)\b[\s\S]{0,200}\b(service|agent|remind|keep track|manage|update for me|keep me honest)\b/i },
  { mode: 'operate', priority: 80, label: 'recurring check', pattern: /\b(check|scan|visit|look at|watch)\b[\s\S]{0,200}\b(daily|every day|each day|every morning|each morning)\b/i },
  { mode: 'operate', priority: 80, label: 'agentic search', pattern: /\b(look for|find|search for|watch for|monitor for|check for)\b[\s\S]{0,120}\b(book|books|room|rooms|appointment|appointments|slot|slots|availability|stock|tickets?)\b/i },
  { mode: 'operate', priority: 75, label: 'service command', pattern: /^(show status|status|add note|record observation|observed|pause reminders|resume reminders)\b/i },

  // AUTOMATE — recurring workflows, scheduled pipelines
  { mode: 'automate', priority: 70, label: 'automate recurring', pattern: /\b(automate|automation|schedule a workflow|create a workflow|run every|run daily|run weekly|run monthly|recurring job|cron|pipeline|batch process|etl)\b/i },
  { mode: 'automate', priority: 65, label: 'scheduled task', pattern: /\b(scheduled?\s+task|run this\s+(every|at|on)|trigger\s+(every|at|when))\b/i },

  // MAINTAIN — monitoring, maintenance, health checks
  { mode: 'maintain', priority: 60, label: 'maintain/monitor', pattern: /\b(maintain|maintenance|health check|uptime|keep running|keep alive|watch for errors|watch for failures|alert me if|alert when|monitor\s+(this|the|my)|system health|service status|log rotation|cleanup|garbage collect)\b/i },

  // RESEARCH — investigation, comparison, analysis
  { mode: 'research', priority: 50, label: 'research/investigate', pattern: /\b(research|investigate|look up|find out|sources?\s+for|evidence|compare\s+\w+\s+(to|vs|against)|literature|state of the art|latest\s+(on|in|research)|analyse|analyze|pros and cons|trade-?offs?|what are the options|summarise\s+(the|this|these))\b/i },

  // BUILD — create artifacts, apps, code, documents
  { mode: 'build', priority: 40, label: 'build explicit', pattern: /\b(build|create|make|generate|write|implement|scaffold|develop)\b.{0,60}\b(app|application|ui|dashboard|website|site|software|codebase|project|component|page|document|template|artifact|script|function|class|module|api|service|cli|file|tool)\b/i },
  { mode: 'build', priority: 35, label: 'code verbs', pattern: /\b(refactor|port to|add a feature|add an endpoint|add a method|patch|scaffold|implement|write code|write a test|write tests)\b/i },

  // CHAT — questions, explanations, conversational
  { mode: 'chat', priority: 10, label: 'question', pattern: /^(what|why|how|when|where|who|which|is|are|can|could|would|should|do|does|did|will|explain|tell me|describe)\b/i },
  { mode: 'chat', priority: 5, label: 'conversational', pattern: /^(hello|hi|hey|thanks|thank you|ok|okay|yes|no|sure|got it)\b/i },
];

// ─── Explicit build override ────────────────────────────────────────

function explicitlyRequestsBuild(message: string): boolean {
  return /\b(build|code|develop|implement|scaffold|create|make|generate|write)\b.{0,60}\b(app|application|ui|dashboard|website|site|software|codebase|project|component|page|document|template|artifact)\b/i.test(message);
}

// ─── Classifier ─────────────────────────────────────────────────────

export function classifyMode(message: string): ModeClassification {
  const lower = message.toLowerCase();
  const matches: Array<{ rule: ModeRule; match: string }> = [];

  for (const rule of MODE_RULES) {
    const m = lower.match(rule.pattern);
    if (m) matches.push({ rule, match: m[0] });
  }

  if (matches.length === 0) {
    return {
      mode: 'chat',
      confidence: 0.5,
      reason: 'Conversational message — using chat mode.',
      matchedPatterns: [],
      suppressedModes: [],
    };
  }

  // Sort by priority descending
  matches.sort((a, b) => b.rule.priority - a.rule.priority);
  const best = matches[0];
  const suppressed: HarnessMode[] = [];

  // If the best match is operate/automate/maintain/research but the user
  // explicitly asks for software, suppress and use build instead.
  if (best.rule.mode !== 'build' && best.rule.mode !== 'chat' && explicitlyRequestsBuild(lower)) {
    suppressed.push(best.rule.mode);
    return {
      mode: 'build',
      confidence: 0.8,
      reason: `Matched ${best.rule.mode} pattern "${best.rule.label}" but explicit build request overrides.`,
      matchedPatterns: matches.map((m) => m.rule.label),
      suppressedModes: suppressed,
    };
  }

  // Confidence based on how many rules matched the same mode
  const sameModeCount = matches.filter((m) => m.rule.mode === best.rule.mode).length;
  const confidence = Math.min(0.95, 0.6 + sameModeCount * 0.1);

  return {
    mode: best.rule.mode,
    confidence,
    reason: `Matched pattern "${best.rule.label}".`,
    matchedPatterns: matches.map((m) => m.rule.label),
    suppressedModes: suppressed,
  };
}

// ─── Mode descriptions for context assembly ─────────────────────────

export const MODE_DESCRIPTIONS: Record<HarnessMode, string> = {
  chat: 'Answer a question or have a conversation.',
  build: 'Create an artifact, app, script, file, dashboard, document, UI, or code project.',
  operate: 'Create or update an ongoing agentic service with persistent state, reminders, commands, reviews, and scheduled behaviour.',
  automate: 'Create a recurring workflow that runs with tools, files, and a scheduler.',
  research: 'Investigate, compare, gather sources, or analyse information.',
  maintain: 'Monitor or maintain something over time.',
};

export function getModeDescription(mode: HarnessMode): string {
  return MODE_DESCRIPTIONS[mode];
}
