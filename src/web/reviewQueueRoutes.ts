import express from 'express';

import {
  listReviewItems,
  resolveReviewItem,
  getGovernanceMetrics,
  type ReviewItemKind,
  type ReviewItemStatus,
} from '../governed/reviewQueue';
import { readReplayCandidates, consumeReplayCandidates } from '../governed/replayConsumer';

// Human-gated surface for the Governed Agent Loop review queue. Lists pending
// items and resolves them with an outcome. Approving a brain-update is the only
// path that writes an approved fact (to the audit log, inside the store).
export function createReviewQueueRouter(): express.Router {
  const router = express.Router();

  router.get('/api/review-queue', (req, res) => {
    const status = parseStatus(req.query.status);
    const kind = parseKind(req.query.kind);
    res.json({ items: listReviewItems({ status, kind }) });
  });

  // Small governance readout: lifetime counts of the review queue so a human
  // can see the loop's throughput (staged → approved/drained → re-queued).
  router.get('/api/governed-metrics', (_req, res) => {
    res.json({ metrics: getGovernanceMetrics() });
  });

  router.post('/api/review-queue/:id/approve', (req, res) => {
    resolveAndRespond(String(req.params.id), 'approved', res);
  });

  router.post('/api/review-queue/:id/reject', (req, res) => {
    resolveAndRespond(String(req.params.id), 'rejected', res);
  });

  router.post('/api/review-queue/:id/drain', (req, res) => {
    resolveAndRespond(String(req.params.id), 'drained', res);
  });

  // Consumer side of the drained-answer replay seam. GET peeks at the staged
  // candidates; POST /consume reads and atomically clears them so a downstream
  // auto-research / replay process handles each drained answer exactly once.
  router.get('/api/replay-candidates', async (_req, res) => {
    res.json({ candidates: await readReplayCandidates() });
  });

  router.post('/api/replay-candidates/consume', async (_req, res) => {
    res.json({ candidates: await consumeReplayCandidates() });
  });

  return router;
}

function resolveAndRespond(
  id: string,
  outcome: Exclude<ReviewItemStatus, 'pending'>,
  res: express.Response,
): void {
  const item = resolveReviewItem(id, outcome);
  if (!item) {
    res.status(404).json({ error: 'Review item not found or already resolved' });
    return;
  }
  res.json({ ok: true, item });
}

function parseStatus(value: unknown): ReviewItemStatus | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'drained'
    ? value
    : undefined;
}

function parseKind(value: unknown): ReviewItemKind | undefined {
  return value === 'brain-update' || value === 'needs-review' ? value : undefined;
}
