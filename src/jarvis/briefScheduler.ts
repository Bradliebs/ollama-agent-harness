// Brief scheduler helper.
//
// Pure snapshot function the existing automation scheduler can call to produce
// a daily/evening brief without coupling jarvis to the scheduler module.

import { listLearningCandidates } from '../learning/sessionLearning';
import { readRunEvidence } from '../persistence/evidenceStore';
import { composeDailyBrief } from './dailyBrief';
import { getKnowledgeGraphStatus } from './knowledgeGraph';
import { mineNextActions } from './predictiveEngine';
import { eventsFromAmbientSignals, eventsFromEvidenceCards, mergeAndSort } from './predictiveAdapter';
import type { NervousSignal } from '../nervous/signals';
import { loadTrustLadder } from './trustLadder';

export interface BriefSnapshotOptions {
  projectDir: string;
  ambientSignals?: NervousSignal[];
  windowDescription?: string;
}

export interface BriefSnapshot {
  generatedAt: string;
  markdown: string;
}

export async function snapshotDailyBrief(options: BriefSnapshotOptions): Promise<BriefSnapshot> {
  const { projectDir } = options;
  const ambientSignals = options.ambientSignals ?? [];
  const [trust, knowledge, candidates, runs] = await Promise.all([
    loadTrustLadder(projectDir),
    getKnowledgeGraphStatus(projectDir),
    listLearningCandidates(projectDir, 20).catch(() => []),
    readRunEvidence(projectDir, 50).catch(() => []),
  ]);
  const events = mergeAndSort(eventsFromAmbientSignals(ambientSignals), eventsFromEvidenceCards(runs));
  const predictiveSuggestions = mineNextActions(events, { limit: 8 });
  const evidenceSummaries = runs.slice(0, 10).map((r) => ({ title: oneLine(r.request), status: r.kind, at: r.createdAt }));
  const markdown = composeDailyBrief({
    asOf: new Date().toISOString(),
    windowDescription: options.windowDescription ?? 'snapshot',
    ambientSignals,
    pendingLearningCandidates: candidates.map((c) => ({ id: c.id, prompt: c.prompt, outcome: c.outcome, createdAt: c.createdAt })),
    predictiveSuggestions,
    knowledgeGraph: knowledge,
    trustLadder: trust,
    evidenceSummaries,
  });
  return { generatedAt: new Date().toISOString(), markdown };
}

function oneLine(text: string, max = 80): string {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}
