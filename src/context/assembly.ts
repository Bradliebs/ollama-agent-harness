import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from 'ollama';
import type { Tool } from '../types';
import { toolToSchema } from '../types/tool';
import { loadSkillsDir } from '../extensibility/skillLoader';
import { recall } from '../jarvis/knowledgeGraph';
import { listIndexes as listRagIndexes, search as searchRagIndex } from '../persistence/ragIndex';
import { buildMemoryPalace } from '../persistence/semanticMemory';
import { searchSessions } from '../persistence/sessionSearchIndex';
import { recordSwallowed } from '../observability/silentFailureSink';
import * as ccmem from '../services/conceptMemoryClient';

const PROJECT_MEMORY_MAX_CHARS = 8_000;
const AGENT_MEMORY_MAX_CHARS = 4_000;
const RECALL_MAX_HITS = 3;
const SKILL_LIST_MAX_ITEMS = 40;
const RAG_AUTO_K_PER_INDEX = 3;
const RAG_AUTO_MAX_INDEXES = 3;
const RAG_AUTO_SNIPPET_MAX_CHARS = 500;
const PALACE_AUTO_MAX_ROOMS = 3;
const PALACE_AUTO_ANCHORS_PER_ROOM = 2;
const PALACE_AUTO_ANCHOR_CHARS = 200;
const SESSION_SEARCH_MAX_HITS = 3;
const SESSION_SEARCH_SNIPPET_CHARS = 240;
/** Combined token-cost budget across the three auto-recall sections
 * (RAG + memory palace + prior sessions). Each section caps itself by
 * snippet length, but worst-case those caps sum to ~7 KB which is
 * painful on 8 K-context local models. This hard-cap trims the
 * combined block from the tail once all three are built, so any one
 * section can use the full budget when the others are empty. */
const RECALL_SECTIONS_COMBINED_MAX_CHARS = 4_000;

export interface ContextConfig {
  systemPrompt: string;
  projectDir: string;
  memoryFiles?: string[];
  skillsDir?: string;
  /** When set with a non-empty `recallQuery`, inject top KG hits as a memory section. */
  recallProjectDir?: string;
  recallQuery?: string;
  /** When set, auto-consult all RAG indexes in this project for `ragQuery`
   * (defaults to `recallQuery`). Requires `ragOllamaHost` to embed the query. */
  ragProjectDir?: string;
  ragQuery?: string;
  ragOllamaHost?: string;
  /** When set, inject a Memory Palace summary (top rooms + anchor samples). */
  palaceProjectDir?: string;
  /** When set with a non-empty `sessionSearchQuery`, inject prior-session hits. */
  sessionSearchProjectDir?: string;
  sessionSearchQuery?: string;
  /**
   * When set, query the Concept Cells memory service (ccmem) for semantically
   * relevant memories and inject the top hits. Uses `recallQuery` as the
   * search text when ccmemQuery is not explicitly provided.
   * Requires cc_service running at the configured URL (default localhost:8765).
   */
  ccmemUrl?: string;
  ccmemQuery?: string;
  /** Max concept memory hits to inject (default 5). */
  ccmemTopK?: number;
}

export async function assembleSystemContext(config: ContextConfig): Promise<string> {
  const parts: string[] = [config.systemPrompt];

  // Append project memory files (CLAUDE.md equivalent)
  const memoryPaths = config.memoryFiles ?? [
    path.join(config.projectDir, 'HARNESS.md'),
    path.join(config.projectDir, 'forge-memory', 'patterns.md'),
  ];

  for (const filePath of memoryPaths) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      parts.push(`\n--- ${path.basename(filePath)} ---\n${trimContextText(content, PROJECT_MEMORY_MAX_CHARS, 'middle')}`);
    } catch (err) { recordSwallowed('assembly.readMemoryFile', err); }
  }

  // Load agent memory (auto-memory from .harness/memory/)
  const autoMemoryDir = path.join(config.projectDir, '.harness', 'memory');
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      const content = await fs.readFile(path.join(autoMemoryDir, file), 'utf-8');
      parts.push(`\n--- Agent Memory: ${file} ---\n${trimContextText(content, AGENT_MEMORY_MAX_CHARS, 'tail')}`);
    } catch (err) { recordSwallowed('assembly.readAgentMemory', err); }
  }

  // Inject skill descriptions so the model knows what skills are available
  // (Paper §6.3: "only frontmatter descriptions stay in the prompt" — low context cost)
  // Mirrors the Anthropic Skill spec's Level-1 metadata stage: name + description
  // (+ optional triggers when the harness-extended frontmatter provides them).
  const sDir = config.skillsDir ?? path.join(config.projectDir, '.harness', 'skills');
  try {
    const skills = await loadSkillsDir(sDir);
    if (skills.length > 0) {
      const listedSkills = skills.slice(0, SKILL_LIST_MAX_ITEMS);
      const skillList = listedSkills.map(s => {
        const triggerSuffix = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(', ')})` : '';
        return `• ${s.name} — ${s.description}${triggerSuffix}`;
      }).join('\n');
      const omitted = skills.length > listedSkills.length ? `\n...(${skills.length - listedSkills.length} more skill(s) omitted from prompt; use list_skills when needed)` : '';
      parts.push(`\n--- Available Skills ---\nYou can invoke these skills using the "skill" tool. Use "create_skill" to create new ones.\n${skillList}${omitted}`);
    }
  } catch (err) { recordSwallowed('assembly.loadSkills', err); }

  // Track memory sources that FAILED unexpectedly this turn (threw — not the
  // benign "returned no hits" case) so we can warn the model its recall may be
  // incomplete instead of letting it silently treat "no hit" as "no such fact".
  // ccmem is intentionally excluded: its client never throws (returns empty on
  // error), so flagging its catch would be dead code.
  const degraded: string[] = [];

  // Inject knowledge-graph recall when caller opts in (jarvis layer).
  // Pulls the top hits matching `recallQuery` from `recallProjectDir` as a
  // small memory section. Failure-tolerant: any error means we skip.
  if (config.recallProjectDir && config.recallQuery && config.recallQuery.trim().length > 0) {
    try {
      const result = await recall(config.recallProjectDir, config.recallQuery, RECALL_MAX_HITS);
      const lines: string[] = [];
      for (const e of result.entities) lines.push(`- entity ${e.type}: ${e.name} _(source: ${e.id})_`);
      for (const f of result.facts) lines.push(`- fact: ${f.subject} ${f.predicate} ${f.object} _(source: ${f.id})_`);
      for (const ed of result.edges) lines.push(`- edge: ${ed.from} ${ed.relation} ${ed.to} _(source: ${ed.id})_`);
      if (lines.length > 0) {
        parts.push(`\n--- Knowledge graph recall: ${config.recallQuery} ---\n${lines.join('\n')}\n_When citing these facts in your answer, reference the source id in parentheses._`);
      }
    } catch (err) { recordSwallowed('assembly.kgRecall', err); degraded.push('knowledge-graph'); }
  }

  // Auto-consult RAG + memory palace + prior-session search are built into
  // a separate buffer with a shared character budget. Each section can
  // expand to use the full budget when the others are empty; if all three
  // hit their per-section caps the combined output is trimmed from the
  // tail before being attached to `parts`.
  const recallParts: string[] = [];

  // Auto-consult RAG: when at least one index exists, run the user query
  // against the top few indexes and inject the highest-scoring chunks as a
  // memory section. Without this, the RAG pipeline is built and exposed via
  // REST but never auto-fed into the chat path (specification drift).
  const ragQueryText = (config.ragQuery ?? config.recallQuery ?? '').trim();
  if (config.ragProjectDir && config.ragOllamaHost && ragQueryText.length > 0) {
    try {
      const indexes = await listRagIndexes(config.ragProjectDir);
      if (indexes.length > 0) {
        const targets = indexes.slice(0, RAG_AUTO_MAX_INDEXES);
        const lines: string[] = [];
        for (const idx of targets) {
          try {
            const hits = await searchRagIndex(config.ragProjectDir, idx.name, ragQueryText, {
              k: RAG_AUTO_K_PER_INDEX,
              ollamaHost: config.ragOllamaHost,
            });
            for (const h of hits) {
              const snippet = h.content.length > RAG_AUTO_SNIPPET_MAX_CHARS
                ? `${h.content.slice(0, RAG_AUTO_SNIPPET_MAX_CHARS)}...`
                : h.content;
              lines.push(`- [${idx.name}#${h.source}:${h.chunkNo}] (score ${h.score.toFixed(2)}) ${snippet.replace(/\s+/g, ' ').trim()}`);
            }
          } catch (err) { recordSwallowed(`assembly.ragSearch.${idx.name}`, err); degraded.push(`rag:${idx.name}`); }
        }
        if (lines.length > 0) {
          recallParts.push(`\n--- RAG recall: ${ragQueryText.slice(0, 120)} ---\n${lines.join('\n')}\n_Cite the index/source/chunk id in parentheses when using these snippets._`);
        }
      }
    } catch (err) { recordSwallowed('assembly.ragListIndexes', err); degraded.push('rag'); }
  }

  // Memory palace summary: surface rooms ranked by relevance to the current
  // user query (when one is available), falling back to entry-count ordering
  // when no query is supplied. Each room shows its highest-relevance anchor
  // samples so the model sees prior memory tied to what's being asked, not
  // just the largest pile of historical events.
  if (config.palaceProjectDir) {
    try {
      const palaceQuery = (config.recallQuery ?? config.sessionSearchQuery ?? '').trim();
      const palace = await buildMemoryPalace(config.palaceProjectDir, palaceQuery || undefined);
      if (palace.rooms.length > 0) {
        const lines = palace.rooms.slice(0, PALACE_AUTO_MAX_ROOMS).map((room) => {
          const anchorLines = room.anchors.slice(0, PALACE_AUTO_ANCHORS_PER_ROOM).map((a) => {
            const text = a.text.replace(/\s+/g, ' ').trim();
            const snippet = text.length > PALACE_AUTO_ANCHOR_CHARS ? `${text.slice(0, PALACE_AUTO_ANCHOR_CHARS)}...` : text;
            return `    • ${snippet}`;
          });
          const anchorBlock = anchorLines.length > 0 ? `\n${anchorLines.join('\n')}` : '';
          return `  - ${room.title} (${room.entryCount} entries, ${room.sessions.length} sessions)${anchorBlock}`;
        });
        recallParts.push(`\n--- Memory palace summary (${palace.roomCount} rooms, ${palace.entryCount} entries) ---\n${lines.join('\n')}`);
      }
    } catch (err) { recordSwallowed('assembly.memoryPalace', err); degraded.push('memory-palace'); }
  }

  // Prior-session hits: search the cross-session text index for the same
  // query and inject the top matches with snippets. Lets the model carry
  // continuity across sessions without manual recall.
  const sessionSearchText = (config.sessionSearchQuery ?? config.recallQuery ?? '').trim();
  if (config.sessionSearchProjectDir && sessionSearchText.length > 0) {
    try {
      const hits = await searchSessions(config.sessionSearchProjectDir, sessionSearchText, SESSION_SEARCH_MAX_HITS);
      if (hits.length > 0) {
        const lines = hits.map((h) => {
          const entry = h.entry;
          const snippet = entry.text.replace(/\s+/g, ' ').trim();
          const trimmed = snippet.length > SESSION_SEARCH_SNIPPET_CHARS ? `${snippet.slice(0, SESSION_SEARCH_SNIPPET_CHARS)}...` : snippet;
          return `- [session ${entry.sessionId} • ${entry.role} • ${entry.timestamp}] ${trimmed}`;
        });
        recallParts.push(`\n--- Prior sessions matching: ${sessionSearchText.slice(0, 120)} ---\n${lines.join('\n')}`);
      }
    } catch (err) { recordSwallowed('assembly.sessionSearch', err); degraded.push('prior-sessions'); }
  }

  // Concept memory recall: semantically relevant memories from ccmem.
  // Uses MiniLM embeddings so it surfaces related memories even when
  // keywords don't match (e.g. "auth" finds "JWT", "login", "token").
  const ccmemQueryText = (config.ccmemQuery ?? config.recallQuery ?? '').trim();
  if (config.ccmemUrl && ccmemQueryText.length > 0) {
    try {
      ccmem.setCcmemUrl(config.ccmemUrl);
      const topK = config.ccmemTopK ?? 5;
      const hits = await ccmem.recall(ccmemQueryText, topK);
      if (hits.length > 0) {
        const lines = hits.map((h) => {
          const label = h.label ? ` [${h.label}]` : '';
          const snippet = (h.source ?? '').replace(/\s+/g, ' ').trim();
          const trimmed = snippet.length > 300 ? `${snippet.slice(0, 300)}...` : snippet;
          return `- (margin ${h.margin.toFixed(3)})${label} ${trimmed}`;
        });
        recallParts.push(`\n--- Concept memory recall: ${ccmemQueryText.slice(0, 120)} ---\n${lines.join('\n')}`);
      }
    } catch (err) { recordSwallowed('assembly.ccmemRecall', err); }
  }

  if (recallParts.length > 0) {
    const combined = recallParts.join('\n');
    parts.push(trimContextText(combined, RECALL_SECTIONS_COMBINED_MAX_CHARS, 'tail'));
  }

  // Point-of-use degraded-memory signal. Only appears when a recall source
  // actually threw, so the default (all sources healthy) prompt is unchanged.
  if (degraded.length > 0) {
    const unique = [...new Set(degraded)];
    parts.push(`\n--- \u26a0\ufe0f Memory degraded ---\n${unique.length} memory source(s) failed this turn (${unique.join(', ')}); recalled context above may be incomplete. Do not treat the absence of a fact here as proof it is not in memory.`);
  }

  return parts.join('\n');
}

function trimContextText(content: string, maxChars: number, mode: 'middle' | 'tail'): string {
  if (content.length <= maxChars) return content;
  if (mode === 'tail') {
    return `...(trimmed to latest ${maxChars} chars for prompt budget)\n${content.slice(-maxChars)}`;
  }
  const half = Math.floor(maxChars / 2);
  return `${content.slice(0, half)}\n...(trimmed ${content.length - maxChars} chars for prompt budget)...\n${content.slice(-half)}`;
}

export function assembleToolSchemas(tools: Tool[]): string {
  const schemas = tools.map(toolToSchema);
  return JSON.stringify(schemas, null, 2);
}

export function assembleUserContext(projectDir: string): Message {
  return {
    role: 'user' as const,
    content: `Current working directory: ${projectDir}\nDate: ${new Date().toISOString().split('T')[0]}`,
  };
}

export function buildInitialMessages(
  userMessage: string,
  projectDir: string,
): Message[] {
  const safeProjectDir = typeof projectDir === 'string' && projectDir.trim().length > 0 ? projectDir : process.cwd();
  return [
    assembleUserContext(safeProjectDir),
    { role: 'user' as const, content: userMessage },
  ];
}

export function estimateTokenCount(messages: Message[]): number {
  // Rough estimate: ~4 chars per token
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(totalChars / 4);
}
