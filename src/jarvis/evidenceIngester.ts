// Evidence card → Knowledge graph ingester.
//
// Every completed evidence card writes a small set of records:
//
//   entity:run        — one per card
//   entity:tool       — one per tool name (deduped via upsertEntity)
//   entity:file       — one per touched file
//   edge:run→tool     — relation 'used'
//   edge:run→file     — relation 'touched' with action attribute
//   fact: run completed_at <createdAt>, run mode <mode>, run model <model>
//
// This is the "memory" that lets `recall("who changed payment.ts last")`
// return useful answers without scanning sessions linearly.

import type { EvidenceCard } from '../types/evidence';
import { appendRecord, upsertEntity, type GraphRecord } from './knowledgeGraph';

export interface IngestResult {
  runEntityId: string;
  written: number;
}

export async function ingestEvidenceCard(projectDir: string, card: EvidenceCard): Promise<IngestResult> {
  const written: GraphRecord[] = [];

  const run = await upsertEntity(projectDir, 'run', card.id, {
    kind: card.kind,
    mode: card.mode,
    model: card.model,
    backend: card.backend,
    createdAt: card.createdAt,
    request: oneLine(card.request, 240),
  }, 'evidence');
  written.push(run);

  for (const tool of card.tools) {
    const ent = await upsertEntity(projectDir, 'tool', tool.name, {}, 'evidence');
    written.push(ent);
    written.push(await appendRecord(projectDir, {
      kind: 'edge', from: run.id, to: ent.id, relation: 'used', weight: tool.success ? 1 : 0, source: 'evidence',
    }));
  }

  for (const file of card.files) {
    const ent = await upsertEntity(projectDir, 'file', file.path, {}, 'evidence');
    written.push(ent);
    written.push(await appendRecord(projectDir, {
      kind: 'edge', from: run.id, to: ent.id, relation: 'touched', source: 'evidence',
    }));
    written.push(await appendRecord(projectDir, {
      kind: 'fact', subject: file.path, predicate: 'last_action', object: file.action, confidence: 1, source: 'evidence',
    }));
  }

  if (card.model) {
    written.push(await appendRecord(projectDir, {
      kind: 'fact', subject: card.id, predicate: 'used_model', object: card.model, confidence: 1, source: 'evidence',
    }));
  }

  return { runEntityId: run.id, written: written.length };
}

function oneLine(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}
