// Memory intelligence layer.
//
// Adds smart behavior on top of the markdown memory files that already live
// under .harness/memory/. Provides:
//   - importance metadata on each section (HTML comments, model-friendly)
//   - dedup-aware section appends (line-level overlap detection)
//   - hard size enforcement with auto-compaction (drops lowest-importance
//     sections oldest first)
//   - TOC fallback when the file exceeds its budget for prompt rendering
//   - relevance-ranked search across sections
//   - daily-log compaction into weekly archives (tiered summarization)
//   - garbage collection (drop empty sections, dedup duplicate titles)
//
// All operations are best-effort: a corrupt or partially-written memory file
// is handled gracefully — the function returns a degraded result rather than
// throwing.

import * as fs from 'fs/promises';
import * as path from 'path';

export type Importance = 'high' | 'medium' | 'low';

export interface MemorySection {
  title: string;
  body: string;
  importance: Importance;
  createdAt?: string;
  lastReferencedAt?: string;
  /** Character offset where this section started in the source file. */
  offset?: number;
}

export interface MemoryFile {
  filePath: string;
  header: string;
  sections: MemorySection[];
}

export interface AppendSectionOptions {
  importance?: Importance;
  /** Default true. When true, line-level overlap with the existing section is suppressed. */
  dedup?: boolean;
  /** Optional explicit section title; otherwise the first markdown heading in `body` is used. */
  title?: string;
  now?: Date;
}

export interface MemoryMaintenanceSummary {
  compactedFiles: number;
  archivedSections: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
}

export interface MemoryGcSummary {
  removedSections: number;
  dedupedLines: number;
  filesScanned: number;
}

export interface MemoryRenderOptions {
  /** Max characters in the rendered output. When the file exceeds this, lowest-importance sections collapse to a TOC. */
  budgetChars?: number;
}

export interface RankedSection extends MemorySection {
  score: number;
  source: string;
}

const DEFAULT_BUDGET_CHARS = 10_000;
const HARD_SIZE_LIMIT_CHARS = 60_000;
// Importance ordering used by truncation/render decisions.
const IMPORTANCE_ORDER: Record<Importance, number> = { high: 3, medium: 2, low: 1 };

const SYNONYMS: Record<string, string[]> = {
  bug: ['issue', 'defect', 'error'],
  fix: ['resolve', 'patch', 'repair'],
  test: ['testing', 'spec', 'jest'],
  agent: ['subagent', 'helper'],
};

function memoryDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'memory');
}

function archiveDir(projectDir: string): string {
  return path.join(memoryDir(projectDir), '_archive');
}

// ─── Parsing ────────────────────────────────────────────────────────

const IMPORTANCE_RE = /<!--\s*importance:\s*(high|medium|low)(?:\s*\|\s*created:\s*([^|>]+?))?(?:\s*\|\s*last-referenced:\s*([^|>]+?))?\s*-->/i;

export function parseMemoryFile(content: string, filePath: string): MemoryFile {
  // Header is everything before the first "### " section heading.
  const sectionRegex = /^###\s+(.+)$/gm;
  const headings: { title: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(content)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index });
  }
  if (headings.length === 0) {
    return { filePath, header: content.trimEnd(), sections: [] };
  }
  const header = content.slice(0, headings[0].index).trimEnd();
  const sections: MemorySection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
    const block = content.slice(start, end);
    const newlineIdx = block.indexOf('\n');
    const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1).trimEnd();
    const meta = body.match(IMPORTANCE_RE);
    sections.push({
      title: headings[i].title,
      body,
      importance: (meta?.[1]?.toLowerCase() as Importance) ?? 'medium',
      createdAt: meta?.[2]?.trim(),
      lastReferencedAt: meta?.[3]?.trim(),
      offset: start,
    });
  }
  return { filePath, header, sections };
}

export function serializeMemoryFile(file: MemoryFile): string {
  const parts: string[] = [];
  if (file.header) parts.push(file.header.trimEnd(), '');
  for (const section of file.sections) {
    parts.push(`### ${section.title}`);
    if (section.body) parts.push(section.body.trimEnd());
    parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ─── Append with dedup + importance ─────────────────────────────────

export async function appendMemorySection(
  projectDir: string,
  fileName: string,
  body: string,
  options: AppendSectionOptions = {},
): Promise<{ written: boolean; reason?: string }> {
  const dir = memoryDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  const existing = await readFileSafe(filePath);
  const file = parseMemoryFile(existing ?? '', filePath);

  const importance: Importance = options.importance ?? 'medium';
  const now = (options.now ?? new Date()).toISOString().split('T')[0];
  const title = options.title ?? extractFirstHeading(body) ?? `${now}: note`;

  // Build the new body with importance metadata as the first line.
  const meta = `<!-- importance: ${importance} | created: ${now} -->`;
  // Strip any redundant leading "### title" the caller may have included.
  const cleanedBody = body.replace(/^###\s+.+\n/, '').trim();

  // Dedup: if the same title already exists with substantial overlap, skip.
  if (options.dedup !== false) {
    const existingSection = findSectionByTitle(file, title);
    if (existingSection && lineOverlap(existingSection.body, cleanedBody) >= 0.8) {
      return { written: false, reason: 'duplicate-content' };
    }
  }

  const composedBody = [meta, cleanedBody].filter(Boolean).join('\n');
  file.sections.push({
    title,
    body: composedBody,
    importance,
    createdAt: now,
  });

  // Hard size enforcement: if the serialized file exceeds the limit, drop
  // the lowest-importance, oldest sections until it fits.
  enforceHardSize(file);

  const serialized = serializeMemoryFile(file);
  const isNew = existing === null;
  const header = isNew ? defaultHeaderFor(fileName) : '';
  await fs.writeFile(filePath, isNew && !file.header ? `${header}\n${serialized}` : serialized, 'utf-8');
  return { written: true };
}

function defaultHeaderFor(fileName: string): string {
  if (fileName === 'decisions.md') return '# Decisions\n\nArchitectural and design decisions.';
  if (fileName === 'patterns.md') return '# Patterns\n\nLearned coding conventions and patterns.';
  return `# ${fileName.replace('.md', '')}\n\nGeneral notes.`;
}

function extractFirstHeading(body: string): string | undefined {
  const match = body.match(/^###\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function findSectionByTitle(file: MemoryFile, title: string): MemorySection | undefined {
  const normalized = title.toLowerCase().trim();
  return file.sections.find((section) => section.title.toLowerCase().trim() === normalized);
}

function lineOverlap(a: string, b: string): number {
  const linesA = new Set(a.split('\n').map((line) => line.trim()).filter(Boolean));
  const linesB = b.split('\n').map((line) => line.trim()).filter(Boolean);
  if (linesB.length === 0) return 0;
  let overlap = 0;
  for (const line of linesB) if (linesA.has(line)) overlap += 1;
  return overlap / linesB.length;
}

function enforceHardSize(file: MemoryFile): void {
  let serialized = serializeMemoryFile(file);
  if (serialized.length <= HARD_SIZE_LIMIT_CHARS) return;
  // Sort: lowest importance first, then oldest first.
  const ranked = [...file.sections]
    .map((section, index) => ({ section, index }))
    .sort((x, y) => {
      const ix = IMPORTANCE_ORDER[x.section.importance];
      const iy = IMPORTANCE_ORDER[y.section.importance];
      if (ix !== iy) return ix - iy;
      const cx = x.section.createdAt ?? '';
      const cy = y.section.createdAt ?? '';
      return cx.localeCompare(cy);
    });
  for (const { section } of ranked) {
    file.sections = file.sections.filter((s) => s !== section);
    serialized = serializeMemoryFile(file);
    if (serialized.length <= HARD_SIZE_LIMIT_CHARS) return;
  }
}

// ─── Render with budget + TOC fallback ──────────────────────────────

export async function renderMemoryFileForPrompt(
  projectDir: string,
  fileName: string,
  options: MemoryRenderOptions = {},
): Promise<string> {
  const filePath = path.join(memoryDir(projectDir), fileName);
  const existing = await readFileSafe(filePath);
  if (!existing) return '';
  const file = parseMemoryFile(existing, filePath);
  const budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const fullSerialized = serializeMemoryFile(file);
  if (fullSerialized.length <= budget) return fullSerialized;

  // Greedy: include sections by importance until the budget is exhausted, the
  // remainder collapses to a table-of-contents.
  const sortedByImportance = [...file.sections].sort((a, b) =>
    IMPORTANCE_ORDER[b.importance] - IMPORTANCE_ORDER[a.importance]
  );
  const expanded: MemorySection[] = [];
  const collapsed: MemorySection[] = [];
  let runningSize = (file.header?.length ?? 0) + 64;
  for (const section of sortedByImportance) {
    const sectionSize = section.title.length + section.body.length + 16;
    if (runningSize + sectionSize <= budget) {
      expanded.push(section);
      runningSize += sectionSize;
    } else {
      collapsed.push(section);
    }
  }
  // Re-order by original index so output reads naturally.
  const expandedOrdered = file.sections.filter((section) => expanded.includes(section));
  const partial: MemoryFile = { ...file, sections: expandedOrdered };
  let output = serializeMemoryFile(partial);
  if (collapsed.length > 0) {
    const tocLines = collapsed.map((section) => `- ${section.title} _(${section.importance})_`);
    output += `\n### _Table of Contents (${collapsed.length} more)_\n${tocLines.join('\n')}\n`;
  }
  return output;
}

// ─── Search ─────────────────────────────────────────────────────────

export async function searchMemory(projectDir: string, query: string, limit = 8): Promise<RankedSection[]> {
  const dir = memoryDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
  const terms = expandTerms(query);
  const ranked: RankedSection[] = [];
  for (const fileName of files) {
    const content = await readFileSafe(path.join(dir, fileName));
    if (!content) continue;
    const file = parseMemoryFile(content, path.join(dir, fileName));
    for (const section of file.sections) {
      const score = scoreSection(section, terms);
      if (score > 0) ranked.push({ ...section, score, source: fileName });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

function expandTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = new Set(terms);
  for (const term of terms) {
    for (const synonym of SYNONYMS[term] ?? []) expanded.add(synonym);
  }
  return Array.from(expanded);
}

function scoreSection(section: MemorySection, terms: string[]): number {
  const haystackTitle = section.title.toLowerCase();
  const haystackBody = section.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (haystackTitle.includes(term)) score += 4;
    if (haystackBody.includes(term)) score += 1;
  }
  // Importance weighting.
  score *= IMPORTANCE_ORDER[section.importance];
  return score;
}

// ─── Maintenance: compaction + tiered summarization ─────────────────

export async function runMemoryMaintenance(projectDir: string): Promise<MemoryMaintenanceSummary> {
  const dir = memoryDir(projectDir);
  let compactedFiles = 0;
  let archivedSections = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { compactedFiles, archivedSections, totalBytesBefore, totalBytesAfter };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    const content = await readFileSafe(filePath);
    if (!content) continue;
    totalBytesBefore += content.length;
    const file = parseMemoryFile(content, filePath);
    const before = file.sections.length;

    // Daily-log → weekly archive: any section older than 30 days with low
    // importance gets moved to a weekly archive file.
    const archived: MemorySection[] = [];
    file.sections = file.sections.filter((section) => {
      if (section.importance !== 'low') return true;
      const created = section.createdAt ? Date.parse(section.createdAt) : NaN;
      if (!Number.isFinite(created)) return true;
      if (Date.now() - created < 30 * 24 * 60 * 60 * 1000) return true;
      archived.push(section);
      return false;
    });
    if (archived.length > 0) {
      await archiveSections(projectDir, entry.name, archived);
      archivedSections += archived.length;
    }
    if (file.sections.length !== before) compactedFiles += 1;
    const serialized = serializeMemoryFile(file);
    totalBytesAfter += serialized.length;
    if (serialized !== content) await fs.writeFile(filePath, serialized, 'utf-8');
  }
  return { compactedFiles, archivedSections, totalBytesBefore, totalBytesAfter };
}

async function archiveSections(projectDir: string, sourceFileName: string, sections: MemorySection[]): Promise<void> {
  const archive = archiveDir(projectDir);
  await fs.mkdir(archive, { recursive: true });
  const week = isoWeekKey(new Date());
  const filePath = path.join(archive, `${sourceFileName.replace(/\.md$/, '')}-week-${week}.md`);
  const existing = await readFileSafe(filePath);
  const file = parseMemoryFile(existing ?? `# Archive ${week}\n\n`, filePath);
  for (const section of sections) file.sections.push(section);
  await fs.writeFile(filePath, serializeMemoryFile(file), 'utf-8');
}

function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── Garbage collection ─────────────────────────────────────────────

export async function runMemoryGc(projectDir: string): Promise<MemoryGcSummary> {
  const dir = memoryDir(projectDir);
  let removedSections = 0;
  let dedupedLines = 0;
  let filesScanned = 0;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { removedSections, dedupedLines, filesScanned };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    const content = await readFileSafe(filePath);
    if (!content) continue;
    filesScanned += 1;
    const file = parseMemoryFile(content, filePath);
    const before = file.sections.length;

    // Drop empty sections (body empty after stripping metadata).
    file.sections = file.sections.filter((section) => {
      const stripped = section.body.replace(IMPORTANCE_RE, '').trim();
      return stripped.length > 0;
    });
    removedSections += before - file.sections.length;

    // Dedup duplicate lines within each section body.
    for (const section of file.sections) {
      const lines = section.body.split('\n');
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const line of lines) {
        const key = line.trim();
        // Don't dedup blanks or metadata comments.
        if (!key || key.startsWith('<!--')) { kept.push(line); continue; }
        if (seen.has(key)) { dedupedLines += 1; continue; }
        seen.add(key);
        kept.push(line);
      }
      section.body = kept.join('\n');
    }

    const serialized = serializeMemoryFile(file);
    if (serialized !== content) await fs.writeFile(filePath, serialized, 'utf-8');
  }
  return { removedSections, dedupedLines, filesScanned };
}

// ─── Helpers ────────────────────────────────────────────────────────

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
