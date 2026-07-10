import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  enqueueFromGoverned,
  enqueueReviewItem,
  flushReviewQueueWritesForTest,
  initReviewQueue,
  listReviewItems,
  resolveReviewItem,
} from './reviewQueue';
import type { GovernedAnswer } from './governedAnswer';

describe('review queue store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-queue-'));
    fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
    initReviewQueue(dir);
  });

  afterEach(async () => {
    await flushReviewQueueWritesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues and lists items, filtering by status and kind', () => {
    enqueueReviewItem({ kind: 'brain-update', content: 'fact', reason: 'found online' });
    enqueueReviewItem({ kind: 'needs-review', content: 'shaky answer', reason: 'low confidence' });

    expect(listReviewItems()).toHaveLength(2);
    expect(listReviewItems({ kind: 'brain-update' })).toHaveLength(1);
    expect(listReviewItems({ status: 'pending' })).toHaveLength(2);
    expect(listReviewItems({ status: 'approved' })).toHaveLength(0);
  });

  it('resolves a pending item once and returns null for unknown or already-resolved ids', () => {
    const item = enqueueReviewItem({ kind: 'needs-review', content: 'a', reason: 'r' });

    const drained = resolveReviewItem(item.id, 'drained');
    expect(drained?.status).toBe('drained');
    expect(drained?.resolvedAt).toBeDefined();

    expect(resolveReviewItem(item.id, 'rejected')).toBeNull();
    expect(resolveReviewItem('does-not-exist', 'approved')).toBeNull();
  });

  it('appends to the audit log only when a brain-update is approved', async () => {
    const approve = enqueueReviewItem({ kind: 'brain-update', content: 'Paris is the capital', reason: 'web' });
    const reject = enqueueReviewItem({ kind: 'brain-update', content: 'wrong fact', reason: 'web' });
    const needsReview = enqueueReviewItem({ kind: 'needs-review', content: 'ans', reason: 'flagged' });

    resolveReviewItem(approve.id, 'approved');
    resolveReviewItem(reject.id, 'rejected');
    resolveReviewItem(needsReview.id, 'approved'); // not a brain-update → no log line
    await flushReviewQueueWritesForTest();

    const log = fs.readFileSync(path.join(dir, '.harness', 'brain-approved.jsonl'), 'utf-8').trim();
    const lines = log.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe('Paris is the capital');
  });

  it('teaches the durable brain (patterns.md) only when a brain-update is approved', async () => {
    const approve = enqueueReviewItem({ kind: 'brain-update', content: 'Paris is the capital', reason: 'web' });
    const reject = enqueueReviewItem({ kind: 'brain-update', content: 'wrong fact', reason: 'web' });

    resolveReviewItem(approve.id, 'approved');
    resolveReviewItem(reject.id, 'rejected');
    await flushReviewQueueWritesForTest();

    const brain = fs.readFileSync(path.join(dir, '.harness', 'memory', 'patterns.md'), 'utf-8');
    expect(brain).toContain('# Learned Patterns');
    // Curated entry leads with the fact and carries a single provenance line.
    expect(brain).toContain('## Approved fact');
    expect(brain).toContain('Paris is the capital');
    expect(brain).toContain('Origin: approved brain-update');
    expect(brain).toMatch(/Origin: approved brain-update \S+ — web/);
    expect(brain).not.toContain('wrong fact');
  });

  it('merges provenance into an approved fact already present in the durable brain', async () => {
    const first = enqueueReviewItem({ kind: 'brain-update', content: 'Paris is the capital of France', reason: 'web' });
    resolveReviewItem(first.id, 'approved');
    await flushReviewQueueWritesForTest();

    // Same fact, different casing/spacing → merged, not re-written as a new block.
    const dup = enqueueReviewItem({ kind: 'brain-update', content: '  paris  is the CAPITAL of france ', reason: 'web again' });
    resolveReviewItem(dup.id, 'approved');
    await flushReviewQueueWritesForTest();

    const brain = fs.readFileSync(path.join(dir, '.harness', 'memory', 'patterns.md'), 'utf-8');
    const headers = (brain.match(/## Approved fact/g) || []).length;
    const origins = (brain.match(/Origin: approved brain-update/g) || []).length;
    expect(headers).toBe(1); // one fact block
    expect(origins).toBe(2); // two corroborating provenance lines
    expect(brain).toContain('web again');
  });

  it('appends a replay candidate to the durable seam only when a needs-review item is drained', async () => {
    const drain = enqueueReviewItem({ kind: 'needs-review', content: 'shaky answer', reason: 'low confidence' });
    const reject = enqueueReviewItem({ kind: 'needs-review', content: 'other answer', reason: 'flagged' });
    const brainUpdate = enqueueReviewItem({ kind: 'brain-update', content: 'a fact', reason: 'web' });

    resolveReviewItem(drain.id, 'drained');
    resolveReviewItem(reject.id, 'rejected');
    resolveReviewItem(brainUpdate.id, 'drained'); // not needs-review → no replay line
    await flushReviewQueueWritesForTest();

    const log = fs.readFileSync(path.join(dir, '.harness', 'needs-review-replay.jsonl'), 'utf-8').trim();
    const lines = log.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe('shaky answer');
  });

  it('reloads persisted items on re-init', async () => {
    enqueueReviewItem({ kind: 'brain-update', content: 'persisted', reason: 'r' });
    await flushReviewQueueWritesForTest();

    initReviewQueue(dir);
    const items = listReviewItems();
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('persisted');
  });

  it('maps a governed answer into needs-review and brain-update entries', () => {
    const governed: GovernedAnswer = {
      answer: 'The answer.',
      confidence: { mode: 'needs-review', reason: 'confidence 0.10 below 0.45' },
      critique: { findings: [], overall: 'review' },
      workingMemory: null,
      proposedBrainUpdates: [{ content: 'new fact', reason: 'found online unsaved' }],
    };

    const enqueued = enqueueFromGoverned(governed);
    expect(enqueued).toHaveLength(2);
    expect(listReviewItems({ kind: 'needs-review' })).toHaveLength(1);
    expect(listReviewItems({ kind: 'brain-update' })).toHaveLength(1);
  });

  it('does not enqueue a needs-review item when the critique passes', () => {
    const governed: GovernedAnswer = {
      answer: 'Solid answer.',
      confidence: { mode: 'from-brain', reason: 'cited from brain' },
      critique: { findings: [], overall: 'ok' },
      workingMemory: null,
      proposedBrainUpdates: [],
    };

    expect(enqueueFromGoverned(governed)).toHaveLength(0);
    expect(listReviewItems()).toHaveLength(0);
  });
});
