import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';
import { recordSwallowed } from '../observability/silentFailureSink';

/**
 * Self-Learning Engine — the autonomous learning loop.
 *
 * Inspired by the Claude Code paper:
 * - §7.2 Auto Memory: "contextually relevant memory entries"
 * - §10 OpenClaw Dreaming: "background consolidation, scoring candidates
 *   and promoting only qualified items from short-term recall into long-term memory"
 * - §2.1 Contextual Adaptability: "the relationship improves over time"
 *
 * This module provides:
 * 1. Tool usage tracking — records every tool call with outcome
 * 2. Pattern detection — finds repeated tool sequences and suggests skills
 * 3. Reflection — end-of-conversation self-assessment
 * 4. Dreaming/Consolidation — merges scattered memories into structured knowledge
 * 5. System prompt evolution — adapts the default prompt based on learned patterns
 *
 * State model: each chat / CLI run should construct its own LearningRecorder
 * bound to the project's PROJECT_DIR and a sessionId, so the tool log,
 * auto-continue counter, and active model are scoped per-session. The
 * legacy no-arg exports (`startNewSession()`, `trackToolUsage(...)` etc.)
 * are kept as backward-compat shims that delegate to a process-wide default
 * recorder bound to `process.cwd()` — they remain race-prone under
 * concurrency and should not be used from new code.
 */

interface ToolUsageEntry {
  timestamp: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  success: boolean;
  durationMs?: number;
}

interface Reflection {
  timestamp: string;
  sessionId: string;
  toolsUsed: string[];
  successRate: number;
  insights: string[];
  suggestedImprovements: string[];
}

interface DetectedPattern {
  id: string;
  toolSequence: string[];
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  suggestedSkillName: string;
  promoted: boolean; // true if a skill was already created from this
}

/** Project-scoped, per-session learning state. Replaces the legacy module
 * globals (which races under concurrent chats and writes to whatever the
 * process cwd happens to be). */
export class LearningRecorder {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly baseDir: string;
  readonly trackerFile: string;
  readonly patternsFile: string;
  readonly reflectionsFile: string;
  readonly evolvedPromptFile: string;
  readonly memoryDir: string;
  private toolLog: ToolUsageEntry[] = [];
  private autoContinueCount = 0;
  private model = '';

  constructor(projectDir: string, sessionId?: string) {
    this.projectDir = projectDir;
    this.sessionId = sessionId ?? Date.now().toString(36);
    this.baseDir = path.join(projectDir, '.harness', 'learning');
    this.trackerFile = path.join(this.baseDir, 'tool-usage.jsonl');
    this.patternsFile = path.join(this.baseDir, 'detected-patterns.json');
    this.reflectionsFile = path.join(this.baseDir, 'reflections.jsonl');
    this.evolvedPromptFile = path.join(this.baseDir, 'evolved-prompt.md');
    this.memoryDir = path.join(projectDir, '.harness', 'memory');
  }

  getSessionTools(): ToolUsageEntry[] { return [...this.toolLog]; }
  getAutoContinueCount(): number { return this.autoContinueCount; }
  getModel(): string { return this.model; }

  recordAutoContinue(model: string): void {
    this.autoContinueCount++;
    this.model = model;
  }

  async trackToolUsage(
    tool: string,
    input: Record<string, unknown>,
    success: boolean,
    durationMs?: number,
  ): Promise<void> {
    const entry: ToolUsageEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      tool,
      input,
      success,
      durationMs,
    };
    this.toolLog.push(entry);

    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.appendFile(this.trackerFile, JSON.stringify(entry) + '\n');
    } catch (err) {
      recordSwallowed('learning.trackToolUsage', err);
    }
  }

  async detectPatterns(): Promise<DetectedPattern[]> {
    return detectPatternsImpl(this.trackerFile, this.patternsFile);
  }

  async reflectOnSession(): Promise<Reflection> {
    return reflectOnSessionImpl(this);
  }

  async consolidateMemory(): Promise<string> {
    return consolidateMemoryImpl(this);
  }

  async getEvolvedPrompt(basePrompt: string): Promise<string> {
    return getEvolvedPromptImpl(this, basePrompt);
  }

  async evolvePrompt(addition: string): Promise<void> {
    return evolvePromptImpl(this, addition);
  }

  async getUnpromotedPatterns(): Promise<DetectedPattern[]> {
    return getUnpromotedPatternsImpl(this.patternsFile);
  }

  async markPatternPromoted(patternId: string): Promise<void> {
    return markPatternPromotedImpl(this.patternsFile, patternId);
  }

  async onSessionEnd(): Promise<{ reflection: Reflection; newPatterns: DetectedPattern[]; digest?: string }> {
    const reflection = await this.reflectOnSession();
    const newPatterns = await this.detectPatterns();
    const unpromoted = newPatterns.filter(p => !p.promoted);
    if (unpromoted.length > 0) {
      logger.info('Learning', `${unpromoted.length} patterns ready for skill promotion`);
    }
    // Consolidate the session into a digest so .harness/memory/consolidated-digest.md
    // actually grows over time. Best-effort: a consolidation failure must not
    // wipe the reflection/pattern signal that already succeeded.
    let digest: string | undefined;
    try {
      digest = await this.consolidateMemory();
    } catch (err) {
      recordSwallowed('learning.onSessionEnd.consolidateMemory', err, { sessionId: this.sessionId });
    }
    return { reflection, newPatterns: unpromoted, digest };
  }
}

// --- Default recorder (backward compat for callers that didn't pass a recorder) ---

let defaultRecorder: LearningRecorder = new LearningRecorder(process.cwd());

/** Returns the current default recorder (bound to `process.cwd()` at first
 * use, then rebound by `startNewSession()`). New code should construct its
 * own LearningRecorder rather than relying on this. */
export function getDefaultLearningRecorder(): LearningRecorder {
  return defaultRecorder;
}

// --- Backward-compat free-function API (delegates to default recorder) ---

export function startNewSession(): string {
  defaultRecorder = new LearningRecorder(process.cwd());
  return defaultRecorder.sessionId;
}

export function recordSessionAutoContinue(model: string): void {
  defaultRecorder.recordAutoContinue(model);
}

export async function trackToolUsage(
  tool: string,
  input: Record<string, unknown>,
  success: boolean,
  durationMs?: number,
): Promise<void> {
  return defaultRecorder.trackToolUsage(tool, input, success, durationMs);
}

// --- 2. Pattern Detection ---

export async function detectPatterns(): Promise<DetectedPattern[]> {
  return defaultRecorder.detectPatterns();
}

async function detectPatternsImpl(trackerFile: string, patternsFile: string): Promise<DetectedPattern[]> {
  try {
    const raw = await fs.readFile(trackerFile, 'utf-8');
    const entries = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line) as ToolUsageEntry; } catch { return null; } })
      .filter((e): e is ToolUsageEntry => e !== null);

    // Group by session
    const sessions = new Map<string, ToolUsageEntry[]>();
    for (const entry of entries) {
      const list = sessions.get(entry.sessionId) ?? [];
      list.push(entry);
      sessions.set(entry.sessionId, list);
    }

    // Find repeated tool sequences (2-5 tools long)
    const sequenceCounts = new Map<string, { tools: string[]; sessions: string[]; first: string; last: string }>();

    for (const [sessionId, tools] of sessions) {
      const toolNames = tools.map(t => t.tool);
      for (let len = 2; len <= Math.min(5, toolNames.length); len++) {
        for (let i = 0; i <= toolNames.length - len; i++) {
          const seq = toolNames.slice(i, i + len);
          const key = seq.join(' → ');
          const existing = sequenceCounts.get(key);
          if (existing) {
            if (!existing.sessions.includes(sessionId)) {
              existing.sessions.push(sessionId);
            }
            existing.last = tools[i].timestamp;
          } else {
            sequenceCounts.set(key, {
              tools: seq,
              sessions: [sessionId],
              first: tools[i].timestamp,
              last: tools[i].timestamp,
            });
          }
        }
      }
    }

    // Only keep patterns seen in 3+ different sessions
    const patterns: DetectedPattern[] = [];
    for (const [key, data] of sequenceCounts) {
      if (data.sessions.length >= 3) {
        patterns.push({
          id: key.replace(/[^a-z0-9]/gi, '-').toLowerCase(),
          toolSequence: data.tools,
          occurrences: data.sessions.length,
          firstSeen: data.first,
          lastSeen: data.last,
          suggestedSkillName: suggestSkillName(data.tools),
          promoted: false,
        });
      }
    }

    // Sort by occurrence count (most common first)
    patterns.sort((a, b) => b.occurrences - a.occurrences);

    // Save detected patterns
    await fs.writeFile(patternsFile, JSON.stringify(patterns, null, 2));
    logger.info('Learning', `Detected ${patterns.length} patterns from ${sessions.size} sessions`);

    return patterns;

  } catch (err) {
    recordSwallowed('learning.detectPatterns', err);
    return [];
  }
}

function suggestSkillName(tools: string[]): string {
  const unique = [...new Set(tools)];
  if (unique.length === 1) return `auto-${unique[0]}`;
  if (unique.includes('file_read') && unique.includes('file_write')) return 'auto-read-modify';
  if (unique.includes('grep') && unique.includes('file_edit')) return 'auto-search-and-fix';
  if (unique.includes('bash') && unique.includes('file_read')) return 'auto-diagnose';
  return 'auto-pattern-' + unique.slice(0, 3).join('-');
}

// --- 3. Reflection ---

export async function reflectOnSession(): Promise<Reflection> {
  return defaultRecorder.reflectOnSession();
}

async function reflectOnSessionImpl(recorder: LearningRecorder): Promise<Reflection> {
  const sessionToolLog = recorder.getSessionTools();
  const sessionAutoContinueCount = recorder.getAutoContinueCount();
  const sessionModel = recorder.getModel();
  const currentSessionId = recorder.sessionId;
  const toolsUsed = sessionToolLog.map(t => t.tool);
  const successes = sessionToolLog.filter(t => t.success).length;
  const total = sessionToolLog.length;
  const successRate = total > 0 ? successes / total : 1;

  const insights: string[] = [];
  const improvements: string[] = [];

  // Analyze failure patterns
  const failures = sessionToolLog.filter(t => !t.success);
  if (failures.length > 0) {
    const failedTools = [...new Set(failures.map(f => f.tool))];
    insights.push(`Tools that failed: ${failedTools.join(', ')}`);
    if (failedTools.includes('bash')) {
      improvements.push('Consider checking command validity before execution');
    }
    if (failedTools.includes('file_read')) {
      improvements.push('Verify file paths exist before attempting to read');
    }
  }

  // Detect tool overuse
  const toolCounts = new Map<string, number>();
  for (const t of sessionToolLog) {
    toolCounts.set(t.tool, (toolCounts.get(t.tool) ?? 0) + 1);
  }
  for (const [tool, count] of toolCounts) {
    if (count > 10) {
      insights.push(`High usage of '${tool}' (${count} calls) — consider a more targeted approach`);
    }
  }

  // Detect repeated failures on the same tool
  const failureCounts = new Map<string, number>();
  for (const f of failures) {
    failureCounts.set(f.tool, (failureCounts.get(f.tool) ?? 0) + 1);
  }
  for (const [tool, count] of failureCounts) {
    if (count >= 3) {
      improvements.push(`'${tool}' failed ${count} times — learn to handle this error case`);
    }
  }

  // Success rate insight
  if (successRate < 0.7 && total > 3) {
    insights.push(`Low success rate (${Math.round(successRate * 100)}%) — session had many tool failures`);
  }
  if (successRate === 1 && total > 5) {
    insights.push(`Perfect success rate across ${total} tool calls`);
  }

  // Auto-continue autonomy feedback
  if (sessionAutoContinueCount > 0) {
    insights.push(`Auto-continue fired ${sessionAutoContinueCount} time(s) for model ${sessionModel || 'unknown'} — model needed prompting to complete work autonomously`);
    if (sessionAutoContinueCount >= 3) {
      improvements.push(`Model ${sessionModel || 'unknown'} frequently stops to ask permission — consider a stronger autonomy system prompt or a different model for autonomous tasks`);
    }
  }

  const reflection: Reflection = {
    timestamp: new Date().toISOString(),
    sessionId: currentSessionId,
    toolsUsed: [...new Set(toolsUsed)],
    successRate,
    insights,
    suggestedImprovements: improvements,
  };

  // Persist reflection
  try {
    await fs.mkdir(recorder.baseDir, { recursive: true });
    await fs.appendFile(recorder.reflectionsFile, JSON.stringify(reflection) + '\n');
  } catch (err) {
    recordSwallowed('learning.persistReflection', err);
  }

  // Write insights to memory if there are any
  if (insights.length > 0 || improvements.length > 0) {
    try {
      await fs.mkdir(recorder.memoryDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const entry = `\n### ${date}: Session Reflection (${currentSessionId})\n` +
        (insights.length > 0 ? `**Insights:** ${insights.join('; ')}\n` : '') +
        (improvements.length > 0 ? `**Improvements:** ${improvements.join('; ')}\n` : '');

      const notesPath = path.join(recorder.memoryDir, 'notes.md');
      try { await fs.access(notesPath); } catch {
        await fs.writeFile(notesPath, '# Notes\n\nGeneral observations and context.\n');
      }
      await fs.appendFile(notesPath, entry);
    } catch (err) {
      recordSwallowed('learning.writeReflectionMemory', err);
    }
  }

  logger.info('Learning', `Reflection: ${total} tools, ${Math.round(successRate * 100)}% success, ${insights.length} insights`);
  return reflection;
}

// --- 4. Dreaming / Consolidation ---

export async function consolidateMemory(): Promise<string> {
  return defaultRecorder.consolidateMemory();
}

async function consolidateMemoryImpl(recorder: LearningRecorder): Promise<string> {
  const parts: string[] = [];

  // Read all memory files
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      parts.push(await fs.readFile(path.join(recorder.memoryDir, file), 'utf-8'));
    } catch (err) { recordSwallowed('learning.readMemoryFile', err); }
  }

  // Read reflections
  try {
    const raw = await fs.readFile(recorder.reflectionsFile, 'utf-8');
    const reflections = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line) as Reflection; } catch { return null; } })
      .filter((r): r is Reflection => r !== null);

    if (reflections.length > 0) {
      const allInsights = reflections.flatMap(r => r.insights);
      const allImprovements = reflections.flatMap(r => r.suggestedImprovements);
      const avgSuccess = reflections.reduce((s, r) => s + r.successRate, 0) / reflections.length;

      parts.push(`\n--- Reflection Summary (${reflections.length} sessions) ---\n` +
        `Average success rate: ${Math.round(avgSuccess * 100)}%\n` +
        `Common insights: ${[...new Set(allInsights)].slice(0, 10).join('; ')}\n` +
        `Improvements: ${[...new Set(allImprovements)].slice(0, 10).join('; ')}`);
    }
  } catch (err) { recordSwallowed('learning.readReflections', err); }

  // Read detected patterns
  try {
    const patterns = JSON.parse(await fs.readFile(recorder.patternsFile, 'utf-8')) as DetectedPattern[];
    if (patterns.length > 0) {
      parts.push(`\n--- Detected Patterns ---\n` +
        patterns.slice(0, 5).map(p =>
          `• ${p.toolSequence.join(' → ')} (seen ${p.occurrences}x, suggested skill: ${p.suggestedSkillName})`
        ).join('\n'));
    }
  } catch (err) { recordSwallowed('learning.readPatterns', err); }

  if (parts.length === 0) {
    return 'No memories to consolidate yet.';
  }

  // Build consolidated summary
  const consolidated = parts.join('\n\n');

  // Write a consolidated digest
  try {
    const digestPath = path.join(recorder.baseDir, 'consolidated-digest.md');
    const date = new Date().toISOString().split('T')[0];
    const digest = `# Consolidated Knowledge Digest\n\nLast updated: ${date}\n\n${consolidated}`;
    await fs.writeFile(digestPath, digest);
    logger.info('Learning', 'Memory consolidated into digest');
  } catch (err) { recordSwallowed('learning.writeConsolidatedDigest', err); }

  return consolidated;
}

// --- 5. System Prompt Evolution ---

export async function getEvolvedPrompt(basePrompt: string): Promise<string> {
  return defaultRecorder.getEvolvedPrompt(basePrompt);
}

async function getEvolvedPromptImpl(recorder: LearningRecorder, basePrompt: string): Promise<string> {
  // Layer 1: base prompt
  let prompt = basePrompt;

  // Layer 2: append learned patterns from memory
  try {
    const patternsPath = path.join(recorder.memoryDir, 'patterns.md');
    const patterns = await fs.readFile(patternsPath, 'utf-8');
    if (patterns.trim().length > 50) {
      prompt += '\n\n--- Learned Patterns ---\n' + patterns.slice(0, 2000);
    }
  } catch (err) { recordSwallowed('learning.readLearnedPatterns', err); }

  // Layer 3: append consolidated improvements from reflections
  try {
    const raw = await fs.readFile(recorder.reflectionsFile, 'utf-8');
    const reflections = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line) as Reflection; } catch { return null; } })
      .filter((r): r is Reflection => r !== null);

    const improvements = [...new Set(reflections.flatMap(r => r.suggestedImprovements))];
    if (improvements.length > 0) {
      prompt += '\n\n--- Self-Improvements (learned from past sessions) ---\n' +
        improvements.slice(0, 10).map(i => `• ${i}`).join('\n');
    }
  } catch (err) { recordSwallowed('learning.readReflectionsForPrompt', err); }

  // Layer 4: append user-evolved prompt additions
  try {
    const evolved = await fs.readFile(recorder.evolvedPromptFile, 'utf-8');
    if (evolved.trim().length > 0) {
      prompt += '\n\n--- Evolved Instructions ---\n' + evolved;
    }
  } catch (err) { recordSwallowed('learning.readEvolvedPrompt', err); }

  return prompt;
}

export async function evolvePrompt(addition: string): Promise<void> {
  return defaultRecorder.evolvePrompt(addition);
}

async function evolvePromptImpl(recorder: LearningRecorder, addition: string): Promise<void> {
  try {
    await fs.mkdir(recorder.baseDir, { recursive: true });
    const existing = await fs.readFile(recorder.evolvedPromptFile, 'utf-8').catch(() => '');
    await fs.writeFile(recorder.evolvedPromptFile, existing + '\n' + addition);
    logger.info('Learning', 'System prompt evolved with new instruction');
  } catch (err) { recordSwallowed('learning.evolvePrompt', err); }
}

// --- 6. Pattern-to-Skill Promotion ---

export async function getUnpromotedPatterns(): Promise<DetectedPattern[]> {
  return defaultRecorder.getUnpromotedPatterns();
}

async function getUnpromotedPatternsImpl(patternsFile: string): Promise<DetectedPattern[]> {
  try {
    const patterns = JSON.parse(await fs.readFile(patternsFile, 'utf-8')) as DetectedPattern[];
    return patterns.filter(p => !p.promoted && p.occurrences >= 3);
  } catch (err) {
    recordSwallowed('learning.getUnpromotedPatterns', err);
    return [];
  }
}

export async function markPatternPromoted(patternId: string): Promise<void> {
  return defaultRecorder.markPatternPromoted(patternId);
}

async function markPatternPromotedImpl(patternsFile: string, patternId: string): Promise<void> {
  try {
    const patterns = JSON.parse(await fs.readFile(patternsFile, 'utf-8')) as DetectedPattern[];
    const pattern = patterns.find(p => p.id === patternId);
    if (pattern) {
      pattern.promoted = true;
      await fs.writeFile(patternsFile, JSON.stringify(patterns, null, 2));
    }
  } catch (err) { recordSwallowed('learning.markPatternPromoted', err); }
}

// --- Public: Session Lifecycle ---

export async function onSessionEnd(): Promise<{
  reflection: Reflection;
  newPatterns: DetectedPattern[];
}> {
  return defaultRecorder.onSessionEnd();
}
