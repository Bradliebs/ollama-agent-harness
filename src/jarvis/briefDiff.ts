// Brief diffing — compare two daily brief markdown documents and surface
// what changed per section. Useful for evening recap vs morning brief, or
// week-over-week reviews.
//
// Pure function. Sections are heuristically split on `## ` headers; lines
// inside each section are diffed line-by-line (unordered set diff).

export interface SectionDiff {
  section: string;
  added: string[];
  removed: string[];
}

export interface BriefDiffResult {
  sections: SectionDiff[];
  summary: { sectionsChanged: number; linesAdded: number; linesRemoved: number };
}

export function diffBriefs(prev: string, next: string): BriefDiffResult {
  const prevSections = splitSections(prev);
  const nextSections = splitSections(next);
  const allKeys = new Set<string>([...prevSections.keys(), ...nextSections.keys()]);
  const sections: SectionDiff[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const key of allKeys) {
    const prevLines = prevSections.get(key) ?? new Set<string>();
    const nextLines = nextSections.get(key) ?? new Set<string>();
    const added = [...nextLines].filter((l) => !prevLines.has(l));
    const removed = [...prevLines].filter((l) => !nextLines.has(l));
    if (added.length === 0 && removed.length === 0) continue;
    sections.push({ section: key, added, removed });
    linesAdded += added.length;
    linesRemoved += removed.length;
  }

  return { sections, summary: { sectionsChanged: sections.length, linesAdded, linesRemoved } };
}

function splitSections(markdown: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current = '_preamble';
  let lines: string[] = [];
  const flush = () => {
    const cleaned = new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0));
    if (cleaned.size > 0) out.set(current, cleaned);
    lines = [];
  };
  for (const line of markdown.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      flush();
      current = headerMatch[1].trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}
