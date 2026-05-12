import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { appendLearningCandidate, extractLearningCandidate, getLearningCandidateProvenance, listLearningCandidates, listReviewedLearningCandidates, promoteLearningCandidate, reviewLearningCandidate } from './sessionLearning';
import type { SessionEvent } from '../types';

function event(id: string, data: SessionEvent['data']): SessionEvent {
  return { id, timestamp: '2026-04-29T00:00:00.000Z', type: 'system', data };
}

describe('session learning', () => {
  it('accepts high-quality session candidates', () => {
    const candidate = extractLearningCandidate('session-1', [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Fix the test failure' } }),
      event('t1', { kind: 'tool_result', call: { name: 'grep', input: {} }, result: { success: true, output: 'match' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Fixed by updating the assertion' } }),
    ]);

    expect(candidate.accepted).toBe(true);
    expect(candidate.toolNames).toEqual(['grep']);
    expect(candidate.qualityScore).toBeGreaterThanOrEqual(0.6);
  });

  it('rejects noisy sessions with low tool success', () => {
    const candidate = extractLearningCandidate('session-1', [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Fix it' } }),
      event('t1', { kind: 'tool_result', call: { name: 'bash', input: {} }, result: { success: false, output: 'failed' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Could not fix it' } }),
    ]);

    expect(candidate.accepted).toBe(false);
    expect(candidate.rejectionReasons).toContain('tool success rate below threshold');
  });

  it('appends candidates as JSONL', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-learning-'));
    const candidate = extractLearningCandidate('session-1', [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Summarize this' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Summary' } }),
    ]);

    const filePath = await appendLearningCandidate(projectDir, candidate);
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ sessionId: 'session-1' });
    await expect(listLearningCandidates(projectDir)).resolves.toHaveLength(1);
  });

  it('promotes accepted candidates to reviewable memory', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-promotion-'));
    const candidate = extractLearningCandidate('session-1', [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Remember a useful workflow' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Use focused tests before full validation' } }),
    ]);

    const promoted = await promoteLearningCandidate(projectDir, candidate);
    const memory = await fs.readFile(path.join(projectDir, '.harness', 'memory', 'patterns.md'), 'utf-8');

    expect(promoted).toMatchObject({ id: candidate.id });
    expect(memory).toContain('Remember a useful workflow');
  });

  it('records explicit candidate review decisions', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-review-'));
    const candidate = extractLearningCandidate('session-1', [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Capture this workflow' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Run focused validation before full validation' } }),
    ]);
    await appendLearningCandidate(projectDir, candidate);

    const review = await reviewLearningCandidate(projectDir, candidate.id, 'reject', 'too generic');
    const reviewed = await listReviewedLearningCandidates(projectDir);

    expect(review).toMatchObject({ candidateId: candidate.id, action: 'reject', reason: 'too generic' });
    expect(reviewed[0]).toMatchObject({ id: candidate.id, reviewStatus: 'reject' });
  });

  it('returns candidate provenance from source session events', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-provenance-'));
    const events = [
      event('u1', { kind: 'message', message: { role: 'user', content: 'Review this source workflow' } }),
      event('a1', { kind: 'message', message: { role: 'assistant', content: 'Source workflow captured' } }),
    ];
    const candidate = extractLearningCandidate('session-1', events);
    await appendLearningCandidate(projectDir, candidate);
    await fs.mkdir(path.join(projectDir, '.harness', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'sessions', 'session-1.jsonl'), events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');

    const provenance = await getLearningCandidateProvenance(projectDir, candidate.id);

    expect(provenance.candidate).toMatchObject({ id: candidate.id, reviewStatus: 'pending' });
    expect(provenance.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'u1', summary: expect.stringContaining('Review this source workflow') })]));
    expect(provenance.missingEventIds).toEqual([]);
  });
});