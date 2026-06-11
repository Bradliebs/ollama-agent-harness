import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { createReviewQueueRouter } from './reviewQueueRoutes';
import {
  enqueueReviewItem,
  flushReviewQueueWritesForTest,
  initReviewQueue,
  listReviewItems,
} from '../governed/reviewQueue';
import { initReplayConsumer } from '../governed/replayConsumer';

describe('review-queue route API', () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-routes-'));
    fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
    initReviewQueue(dir);
    initReplayConsumer(dir);
    const app = express();
    app.use(express.json());
    app.use(createReviewQueueRouter());
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    await flushReviewQueueWritesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists items and filters by status', async () => {
    enqueueReviewItem({ kind: 'brain-update', content: 'fact', reason: 'web' });
    const res = await fetch(`${baseUrl}/api/review-queue?status=pending`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('reports governance metrics', async () => {
    const a = enqueueReviewItem({ kind: 'brain-update', content: 'fact', reason: 'web' });
    enqueueReviewItem({ kind: 'needs-review', content: 'pending answer', reason: 'low confidence' });
    await fetch(`${baseUrl}/api/review-queue/${a.id}/approve`, { method: 'POST' });

    const res = await fetch(`${baseUrl}/api/governed-metrics`);
    expect(res.status).toBe(200);
    const body = await res.json() as { metrics: { staged: number; approved: number } };
    expect(body.metrics.approved).toBe(1);
    expect(body.metrics.staged).toBe(1);
  });

  it('exposes replay history with before/after diff', async () => {
    // A replay re-enters the queue carrying the original drained text.
    enqueueReviewItem({ kind: 'needs-review', content: 'old answer', reason: 'flagged' }); // not a replay
    enqueueReviewItem({
      kind: 'needs-review',
      content: 'corrected answer',
      reason: 'inferred: replay of orig-1 (changed)',
      replayOf: 'orig-1',
      priorContent: 'old answer',
    });

    const res = await fetch(`${baseUrl}/api/replay-history`);
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ replayOf: string; changed: boolean; priorContent: string; content: string }> };
    expect(body.history).toHaveLength(1);
    expect(body.history[0].replayOf).toBe('orig-1');
    expect(body.history[0].changed).toBe(true);
    expect(body.history[0].priorContent).toBe('old answer');
    expect(body.history[0].content).toBe('corrected answer');
  });

  it('approves a brain-update and 404s an unknown or resolved id', async () => {
    const item = enqueueReviewItem({ kind: 'brain-update', content: 'fact', reason: 'web' });

    const ok = await fetch(`${baseUrl}/api/review-queue/${item.id}/approve`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(listReviewItems({ status: 'approved' })).toHaveLength(1);

    const again = await fetch(`${baseUrl}/api/review-queue/${item.id}/reject`, { method: 'POST' });
    expect(again.status).toBe(404);

    const unknown = await fetch(`${baseUrl}/api/review-queue/nope/drain`, { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('exposes drained answers on the replay seam and consumes them once', async () => {
    const item = enqueueReviewItem({ kind: 'needs-review', content: 'flagged answer', reason: 'sources conflicted' });
    const drained = await fetch(`${baseUrl}/api/review-queue/${item.id}/drain`, { method: 'POST' });
    expect(drained.status).toBe(200);
    await flushReviewQueueWritesForTest(); // drain appends to the seam fire-and-forget

    const peek = await fetch(`${baseUrl}/api/replay-candidates`);
    expect(peek.status).toBe(200);
    const peekBody = await peek.json() as { candidates: Array<{ content: string }> };
    expect(peekBody.candidates.some((c) => c.content === 'flagged answer')).toBe(true);

    const consumed = await fetch(`${baseUrl}/api/replay-candidates/consume`, { method: 'POST' });
    const consumedBody = await consumed.json() as { candidates: Array<{ content: string }> };
    expect(consumedBody.candidates.some((c) => c.content === 'flagged answer')).toBe(true);

    // The seam is drained: a second consume returns nothing.
    const again = await fetch(`${baseUrl}/api/replay-candidates/consume`, { method: 'POST' });
    const againBody = await again.json() as { candidates: unknown[] };
    expect(againBody.candidates).toHaveLength(0);
  });
});
