import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';
import { invalidateSkillsCache } from './skillTools';
import {
  detectPatterns,
  consolidateMemory,
  evolvePrompt,
  getUnpromotedPatterns,
  markPatternPromoted,
} from '../learning/engine';

// Mirror web/server.ts PROJECT_DIR resolution so learning tools write to
// the same `.harness/` folder that context assembly reads from.
function learningProjectDir(): string {
  return process.env.HARNESS_PROJECT_DIR && process.env.HARNESS_PROJECT_DIR.trim()
    ? process.env.HARNESS_PROJECT_DIR
    : process.cwd();
}

/**
 * ReflectTool — the agent explicitly reflects on its approach and saves insights.
 * Different from auto-reflection (which happens at session end) — this is
 * deliberate mid-conversation introspection.
 */
export const ReflectTool: Tool = {
  name: 'reflect',
  description: 'Pause and reflect on your current approach. Analyze what is working and what could be improved, then save the insight to memory. Use this when you notice a pattern, make a mistake, or discover something useful.',
  parameters: {
    type: 'object',
    properties: {
      observation: { type: 'string', description: 'What you observed or learned' },
      category: { type: 'string', description: '"insight" (something learned), "mistake" (what went wrong), or "pattern" (a reusable approach)' },
    },
    required: ['observation'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    // Some models call reflect with a synonym key (issue/reason/message/details/note)
    // or with a non-string body. Coerce defensively so we never throw on input.slice().
    const rawObservation =
      (input.observation as unknown) ??
      (input.issue as unknown) ??
      (input.reason as unknown) ??
      (input.message as unknown) ??
      (input.details as unknown) ??
      (input.note as unknown) ??
      (input.text as unknown);

    if (rawObservation === undefined || rawObservation === null) {
      return {
        success: false,
        output: 'reflect requires an "observation" string (also accepts issue, reason, message, details, note, or text).',
        error: 'missing observation',
      };
    }

    const observation = typeof rawObservation === 'string' ? rawObservation : JSON.stringify(rawObservation);
    if (!observation.trim()) {
      return { success: false, output: 'reflect observation is empty.', error: 'empty observation' };
    }

    const category = typeof input.category === 'string' && input.category ? input.category : 'insight';

    const memDir = path.join(learningProjectDir(), '.harness', 'memory');
    await fs.mkdir(memDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const entry = `\n### ${date}: ${category.toUpperCase()} — ${observation.slice(0, 60)}\n${observation}\n`;

    const targetFile = category === 'pattern'
      ? path.join(memDir, 'patterns.md')
      : path.join(memDir, 'notes.md');

    try {
      try { await fs.access(targetFile); } catch {
        const header = category === 'pattern'
          ? '# Patterns\n\nLearned coding conventions and patterns.\n'
          : '# Notes\n\nGeneral observations and context.\n';
        await fs.writeFile(targetFile, header);
      }
      await fs.appendFile(targetFile, entry);

      return {
        success: true,
        output: `💡 Reflection saved (${category}): "${observation.slice(0, 80)}"\nThis will be available in future sessions.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to save reflection: ${msg}`, error: msg };
    }
  },
};

/**
 * AnalyzePatternsTool — detect repeated tool usage patterns and suggest skills.
 */
export const AnalyzePatternsTool: Tool = {
  name: 'analyze_patterns',
  description: 'Analyze your past tool usage across sessions to find repeated patterns. Patterns that appear 3+ times are candidates for automatic skill creation.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async execute(): Promise<ToolResult> {
    const patterns = await detectPatterns();

    if (patterns.length === 0) {
      return { success: true, output: 'No repeated patterns detected yet. Keep using tools across multiple conversations and patterns will emerge.' };
    }

    const unpromoted = patterns.filter(p => !p.promoted);
    const listing = patterns.slice(0, 10).map(p =>
      `• ${p.toolSequence.join(' → ')} — seen ${p.occurrences}x across sessions` +
      (p.promoted ? ' ✅ (skill created)' : ` 💡 suggested skill: "${p.suggestedSkillName}"`)
    ).join('\n');

    return {
      success: true,
      output: `Detected ${patterns.length} patterns (${unpromoted.length} unpromoted):\n\n${listing}` +
        (unpromoted.length > 0 ? '\n\nUse "promote_pattern" to create a skill from a detected pattern.' : ''),
    };
  },
};

/**
 * PromotePatternTool — create a skill from a detected pattern.
 * This is the self-perpetuating loop: usage → pattern detection → skill creation → better future usage.
 */
export const PromotePatternTool: Tool = {
  name: 'promote_pattern',
  description: 'Create a skill from a detected tool usage pattern. The skill will contain instructions for the pattern so you can apply it more efficiently in future conversations.',
  parameters: {
    type: 'object',
    properties: {
      pattern_id: { type: 'string', description: 'ID of the pattern to promote (from analyze_patterns)' },
      instructions: { type: 'string', description: 'The skill instructions you want to encode for this pattern' },
    },
    required: ['pattern_id', 'instructions'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const patternId = input.pattern_id as string;
    const instructions = input.instructions as string;

    const patterns = await getUnpromotedPatterns();
    const pattern = patterns.find(p => p.id === patternId);

    if (!pattern) {
      return { success: false, output: `Pattern '${patternId}' not found or already promoted.`, error: 'not found' };
    }

    const skillName = pattern.suggestedSkillName;
    const skillDir = path.join(learningProjectDir(), '.harness', 'skills', skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    const content = `---
name: "${skillName}"
description: "Auto-generated skill from detected pattern: ${pattern.toolSequence.join(' → ')}"
domain: "auto-learned"
confidence: "medium"
source: "self-learned from ${pattern.occurrences} occurrences"
triggers:
  - "${skillName.replace('auto-', '')}"
---

## Context

This skill was automatically created from a detected usage pattern.
The tool sequence **${pattern.toolSequence.join(' → ')}** was observed ${pattern.occurrences} times
across different sessions (first: ${pattern.firstSeen}, last: ${pattern.lastSeen}).

## Instructions

${instructions}

## Pattern

Tool sequence: ${pattern.toolSequence.join(' → ')}
`;

    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillPath, content);
      await markPatternPromoted(patternId);
      invalidateSkillsCache();

      return {
        success: true,
        output: `🎓 Skill "${skillName}" created from pattern!\n` +
          `Pattern: ${pattern.toolSequence.join(' → ')} (${pattern.occurrences} occurrences)\n` +
          `Saved to: ${skillPath}\n\nThis skill will be available in all future sessions.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to create skill: ${msg}`, error: msg };
    }
  },
};

/**
 * ConsolidateTool — trigger the dreaming/consolidation cycle.
 * Reviews all scattered memories and produces a structured digest.
 */
export const ConsolidateTool: Tool = {
  name: 'consolidate',
  description: 'Review and consolidate all your memories, reflections, and detected patterns into a structured knowledge digest. Like "sleeping on it" — this helps organize what you have learned across many sessions.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  async execute(): Promise<ToolResult> {
    const digest = await consolidateMemory();
    return {
      success: true,
      output: `🧠 Memory consolidation complete.\n\n${digest.slice(0, 3000)}`,
    };
  },
};

/**
 * EvolveTool — the agent modifies its own default system prompt.
 * This is the most powerful self-perpetuation mechanism: the agent
 * changes its own instructions based on what it has learned.
 */
export const EvolveTool: Tool = {
  name: 'evolve',
  description: 'Add a permanent instruction to your own system prompt. This changes how you behave in ALL future conversations. Use sparingly and deliberately — only for high-confidence improvements.',
  parameters: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: 'The new instruction to add to your system prompt permanently' },
      reason: { type: 'string', description: 'Why this instruction should be permanent' },
    },
    required: ['instruction', 'reason'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const instruction = input.instruction as string;
    const reason = input.reason as string;

    const entry = `\n## ${new Date().toISOString().split('T')[0]}: ${reason.slice(0, 60)}\n${instruction}\n`;

    try {
      await evolvePrompt(entry);

      // Also log this as a decision
      const memDir = path.join(learningProjectDir(), '.harness', 'memory');
      await fs.mkdir(memDir, { recursive: true });
      const decPath = path.join(memDir, 'decisions.md');
      try { await fs.access(decPath); } catch {
        await fs.writeFile(decPath, '# Decisions\n\nArchitectural and design decisions.\n');
      }
      await fs.appendFile(decPath,
        `\n### ${new Date().toISOString().split('T')[0]}: SELF-EVOLUTION — ${reason.slice(0, 60)}\n` +
        `**What:** Added permanent instruction: "${instruction.slice(0, 100)}"\n` +
        `**Why:** ${reason}\n`
      );

      return {
        success: true,
        output: `🧬 System prompt evolved!\n\nNew instruction: "${instruction.slice(0, 100)}"\nReason: ${reason}\n\nThis will affect all future conversations.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to evolve: ${msg}`, error: msg };
    }
  },
};

/**
 * ImproveSkillTool — the agent rewrites one of its own skills based on experience.
 * Skills are living documents that evolve.
 */
export const ImproveSkillTool: Tool = {
  name: 'improve_skill',
  description: 'Rewrite an existing skill to improve it based on experience. Skills are living documents — if you find a better approach, update the skill so future sessions benefit.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the skill to improve' },
      new_content: { type: 'string', description: 'The full new SKILL.md content (including frontmatter)' },
      reason: { type: 'string', description: 'What improved and why' },
    },
    required: ['name', 'new_content', 'reason'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const name = input.name as string;
    const newContent = input.new_content as string;
    const reason = input.reason as string;

    const skillPath = path.join(learningProjectDir(), '.harness', 'skills', name, 'SKILL.md');

    try {
      // Verify skill exists
      await fs.access(skillPath);

      // Back up the old version
      const old = await fs.readFile(skillPath, 'utf-8');
      const backupPath = path.join(learningProjectDir(), '.harness', 'skills', name, `SKILL.${Date.now()}.bak.md`);
      await fs.writeFile(backupPath, old);

      // Write improved version
      await fs.writeFile(skillPath, newContent);
      invalidateSkillsCache();

      return {
        success: true,
        output: `📈 Skill "${name}" improved!\nReason: ${reason}\nOld version backed up to ${path.basename(backupPath)}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to improve skill: ${msg}`, error: msg };
    }
  },
};
