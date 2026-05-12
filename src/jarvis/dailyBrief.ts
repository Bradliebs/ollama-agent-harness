// Daily Brief composer.
//
// Produces a single Markdown document that summarizes everything the harness
// noticed since the last brief: ambient signals, evidence cards, learning
// candidates pending review, predictive suggestions, knowledge graph deltas,
// trust ladder changes. The brief is meant to be the first thing a user
// reads in the morning and the last thing at night.
//
// Pure function over inputs — no I/O. Callers fetch the inputs from their
// respective stores (`listLearningCandidates`, ambient signal log, evidence
// store) and feed them in. This keeps the module unit-testable and lets the
// scheduler / Document Studio decide how to render and persist the output.

import type { NervousSignal } from '../nervous/signals';
import type { NextActionSuggestion } from './predictiveEngine';
import type { KnowledgeGraphStatus } from './knowledgeGraph';
import type { TrustLadderSnapshot } from './trustLadder';

export interface BriefInputs {
  asOf: string;
  windowDescription: string; // e.g. "since yesterday at 18:00"
  ambientSignals: NervousSignal[];
  pendingLearningCandidates: Array<{ id: string; prompt: string; outcome: string; createdAt: string }>;
  predictiveSuggestions: NextActionSuggestion[];
  knowledgeGraph: KnowledgeGraphStatus;
  trustLadder: TrustLadderSnapshot;
  evidenceSummaries?: Array<{ title: string; status: string; at: string }>;
}

export function composeDailyBrief(inputs: BriefInputs): string {
  const lines: string[] = [];
  lines.push(`# Daily Brief — ${inputs.asOf}`);
  lines.push('');
  lines.push(`_${inputs.windowDescription}_`);
  lines.push('');

  // Ambient highlights
  lines.push('## Ambient signals');
  if (inputs.ambientSignals.length === 0) {
    lines.push('Nothing notable.');
  } else {
    const grouped = groupBy(inputs.ambientSignals, (s) => s.source);
    for (const [source, group] of Object.entries(grouped)) {
      lines.push(`- **${source}** — ${group.length} event${group.length === 1 ? '' : 's'}`);
      const latest = group.slice(-3);
      for (const s of latest) lines.push(`  - ${s.message}`);
    }
  }
  lines.push('');

  // Evidence summaries
  if (inputs.evidenceSummaries && inputs.evidenceSummaries.length > 0) {
    lines.push('## Recent runs');
    for (const e of inputs.evidenceSummaries.slice(-10)) {
      lines.push(`- ${e.at} — **${e.status}** — ${e.title}`);
    }
    lines.push('');
  }

  // Pending review
  lines.push('## Awaiting your review');
  if (inputs.pendingLearningCandidates.length === 0) {
    lines.push('No learning candidates pending review.');
  } else {
    for (const c of inputs.pendingLearningCandidates.slice(0, 8)) {
      lines.push(`- \`${c.id}\` — ${oneLine(c.prompt)} → ${oneLine(c.outcome)}`);
    }
  }
  lines.push('');

  // Predictive suggestions
  lines.push('## Suggested next moves');
  if (inputs.predictiveSuggestions.length === 0) {
    lines.push('No high-confidence patterns yet.');
  } else {
    for (const s of inputs.predictiveSuggestions.slice(0, 5)) {
      const pct = Math.round(s.confidence * 100);
      lines.push(`- After **${s.trigger}**, consider **${s.predicted}** _(${pct}% over ${s.sampleSize} samples)_`);
    }
  }
  lines.push('');

  // Knowledge graph stats
  lines.push('## Knowledge graph');
  lines.push(`- Records: ${inputs.knowledgeGraph.records}`);
  lines.push(`- Entities: ${inputs.knowledgeGraph.entities}`);
  lines.push(`- Edges: ${inputs.knowledgeGraph.edges}`);
  lines.push(`- Facts: ${inputs.knowledgeGraph.facts}`);
  if (inputs.knowledgeGraph.lastObservedAt) lines.push(`- Last observation: ${inputs.knowledgeGraph.lastObservedAt}`);
  lines.push('');

  // Trust ladder current state
  lines.push('## Trust ladder');
  const caps = Object.values(inputs.trustLadder.capabilities);
  if (caps.length === 0) {
    lines.push('All capabilities at default rung 2 (ask).');
  } else {
    caps
      .sort((a, b) => b.rung - a.rung)
      .slice(0, 10)
      .forEach((c) => lines.push(`- \`${c.capability}\` — rung ${c.rung} (accepted ${c.acceptedStreak}, rejected ${c.rejectedStreak})`));
  }
  lines.push('');

  return lines.join('\n');
}

function oneLine(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + '…';
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}
