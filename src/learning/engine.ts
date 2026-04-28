import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';

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
 */

const BASE_DIR = path.join(process.cwd(), '.harness', 'learning');
const TRACKER_FILE = path.join(BASE_DIR, 'tool-usage.jsonl');
const PATTERNS_FILE = path.join(BASE_DIR, 'detected-patterns.json');
const REFLECTIONS_FILE = path.join(BASE_DIR, 'reflections.jsonl');
const EVOLVED_PROMPT_FILE = path.join(BASE_DIR, 'evolved-prompt.md');

// --- 1. Tool Usage Tracking ---

interface ToolUsageEntry {
  timestamp: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  success: boolean;
  durationMs?: number;
}

let currentSessionId = Date.now().toString(36);
let sessionToolLog: ToolUsageEntry[] = [];

export function startNewSession(): string {
  currentSessionId = Date.now().toString(36);
  sessionToolLog = [];
  return currentSessionId;
}

export async function trackToolUsage(
  tool: string,
  input: Record<string, unknown>,
  success: boolean,
  durationMs?: number,
): Promise<void> {
  const entry: ToolUsageEntry = {
    timestamp: new Date().toISOString(),
    sessionId: currentSessionId,
    tool,
    input,
    success,
    durationMs,
  };
  sessionToolLog.push(entry);

  try {
    await fs.mkdir(BASE_DIR, { recursive: true });
    await fs.appendFile(TRACKER_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Non-critical — don't break the agent loop
  }
}

// --- 2. Pattern Detection ---

interface DetectedPattern {
  id: string;
  toolSequence: string[];
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  suggestedSkillName: string;
  promoted: boolean; // true if a skill was already created from this
}

export async function detectPatterns(): Promise<DetectedPattern[]> {
  try {
    const raw = await fs.readFile(TRACKER_FILE, 'utf-8');
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
    await fs.writeFile(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
    logger.info('Learning', `Detected ${patterns.length} patterns from ${sessions.size} sessions`);

    return patterns;

  } catch {
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

interface Reflection {
  timestamp: string;
  sessionId: string;
  toolsUsed: string[];
  successRate: number;
  insights: string[];
  suggestedImprovements: string[];
}

export async function reflectOnSession(): Promise<Reflection> {
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
    await fs.mkdir(BASE_DIR, { recursive: true });
    await fs.appendFile(REFLECTIONS_FILE, JSON.stringify(reflection) + '\n');
  } catch {
    // Non-critical
  }

  // Write insights to memory if there are any
  if (insights.length > 0 || improvements.length > 0) {
    try {
      const memDir = path.join(process.cwd(), '.harness', 'memory');
      await fs.mkdir(memDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const entry = `\n### ${date}: Session Reflection (${currentSessionId})\n` +
        (insights.length > 0 ? `**Insights:** ${insights.join('; ')}\n` : '') +
        (improvements.length > 0 ? `**Improvements:** ${improvements.join('; ')}\n` : '');

      const notesPath = path.join(memDir, 'notes.md');
      try { await fs.access(notesPath); } catch {
        await fs.writeFile(notesPath, '# Notes\n\nGeneral observations and context.\n');
      }
      await fs.appendFile(notesPath, entry);
    } catch {
      // Non-critical
    }
  }

  logger.info('Learning', `Reflection: ${total} tools, ${Math.round(successRate * 100)}% success, ${insights.length} insights`);
  return reflection;
}

// --- 4. Dreaming / Consolidation ---

export async function consolidateMemory(): Promise<string> {
  const memDir = path.join(process.cwd(), '.harness', 'memory');
  const parts: string[] = [];

  // Read all memory files
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      parts.push(await fs.readFile(path.join(memDir, file), 'utf-8'));
    } catch { /* not yet created */ }
  }

  // Read reflections
  try {
    const raw = await fs.readFile(REFLECTIONS_FILE, 'utf-8');
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
  } catch { /* no reflections yet */ }

  // Read detected patterns
  try {
    const patterns = JSON.parse(await fs.readFile(PATTERNS_FILE, 'utf-8')) as DetectedPattern[];
    if (patterns.length > 0) {
      parts.push(`\n--- Detected Patterns ---\n` +
        patterns.slice(0, 5).map(p =>
          `• ${p.toolSequence.join(' → ')} (seen ${p.occurrences}x, suggested skill: ${p.suggestedSkillName})`
        ).join('\n'));
    }
  } catch { /* no patterns yet */ }

  if (parts.length === 0) {
    return 'No memories to consolidate yet.';
  }

  // Build consolidated summary
  const consolidated = parts.join('\n\n');

  // Write a consolidated digest
  try {
    const digestPath = path.join(BASE_DIR, 'consolidated-digest.md');
    const date = new Date().toISOString().split('T')[0];
    const digest = `# Consolidated Knowledge Digest\n\nLast updated: ${date}\n\n${consolidated}`;
    await fs.writeFile(digestPath, digest);
    logger.info('Learning', 'Memory consolidated into digest');
  } catch { /* non-critical */ }

  return consolidated;
}

// --- 5. System Prompt Evolution ---

export async function getEvolvedPrompt(basePrompt: string): Promise<string> {
  // Layer 1: base prompt
  let prompt = basePrompt;

  // Layer 2: append learned patterns from memory
  try {
    const patternsPath = path.join(process.cwd(), '.harness', 'memory', 'patterns.md');
    const patterns = await fs.readFile(patternsPath, 'utf-8');
    if (patterns.trim().length > 50) {
      prompt += '\n\n--- Learned Patterns ---\n' + patterns.slice(0, 2000);
    }
  } catch { /* no patterns yet */ }

  // Layer 3: append consolidated improvements from reflections
  try {
    const raw = await fs.readFile(REFLECTIONS_FILE, 'utf-8');
    const reflections = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line) as Reflection; } catch { return null; } })
      .filter((r): r is Reflection => r !== null);

    const improvements = [...new Set(reflections.flatMap(r => r.suggestedImprovements))];
    if (improvements.length > 0) {
      prompt += '\n\n--- Self-Improvements (learned from past sessions) ---\n' +
        improvements.slice(0, 10).map(i => `• ${i}`).join('\n');
    }
  } catch { /* no reflections yet */ }

  // Layer 4: append user-evolved prompt additions
  try {
    const evolved = await fs.readFile(EVOLVED_PROMPT_FILE, 'utf-8');
    if (evolved.trim().length > 0) {
      prompt += '\n\n--- Evolved Instructions ---\n' + evolved;
    }
  } catch { /* no evolved prompt yet */ }

  return prompt;
}

export async function evolvePrompt(addition: string): Promise<void> {
  try {
    await fs.mkdir(BASE_DIR, { recursive: true });
    const existing = await fs.readFile(EVOLVED_PROMPT_FILE, 'utf-8').catch(() => '');
    await fs.writeFile(EVOLVED_PROMPT_FILE, existing + '\n' + addition);
    logger.info('Learning', 'System prompt evolved with new instruction');
  } catch { /* non-critical */ }
}

// --- 6. Pattern-to-Skill Promotion ---

export async function getUnpromotedPatterns(): Promise<DetectedPattern[]> {
  try {
    const patterns = JSON.parse(await fs.readFile(PATTERNS_FILE, 'utf-8')) as DetectedPattern[];
    return patterns.filter(p => !p.promoted && p.occurrences >= 3);
  } catch {
    return [];
  }
}

export async function markPatternPromoted(patternId: string): Promise<void> {
  try {
    const patterns = JSON.parse(await fs.readFile(PATTERNS_FILE, 'utf-8')) as DetectedPattern[];
    const pattern = patterns.find(p => p.id === patternId);
    if (pattern) {
      pattern.promoted = true;
      await fs.writeFile(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
    }
  } catch { /* non-critical */ }
}

// --- Public: Session Lifecycle ---

export async function onSessionEnd(): Promise<{
  reflection: Reflection;
  newPatterns: DetectedPattern[];
}> {
  const reflection = await reflectOnSession();
  const newPatterns = await detectPatterns();
  const unpromoted = newPatterns.filter(p => !p.promoted);

  if (unpromoted.length > 0) {
    logger.info('Learning', `${unpromoted.length} patterns ready for skill promotion`);
  }

  return { reflection, newPatterns: unpromoted };
}
