import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectRunningEntries,
  completeJob,
  DEFAULT_STALE_AFTER_MS,
  heartbeatJob,
  jobLedgerPath,
  listOrphanedRuns,
  readLedger,
  recoverOrphanedJobs,
  startJob,
  type LedgerEvent,
  type OrphanedEntry,
} from './jobLedger';

async function makeProjectDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-jobledger-'));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('jobLedger', () => {
  describe('readLedger', () => {
    it('returns empty for missing file', async () => {
      const dir = await makeProjectDir();
      try {
        expect(await readLedger(dir)).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('skips malformed lines without crashing', async () => {
      const dir = await makeProjectDir();
      try {
        const file = jobLedgerPath(dir);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, [
          JSON.stringify({ type: 'start', jobId: 'a', name: 'A', kind: 'cron', startedAt: '2020-01-01T00:00:00.000Z', runId: 'r1' }),
          '{not valid json',
          '',
          JSON.stringify({ type: 'end', jobId: 'a', runId: 'r1', endedAt: '2020-01-01T00:01:00.000Z', success: true }),
        ].join('\n') + '\n');
        const events = await readLedger(dir);
        expect(events).toHaveLength(2);
        expect(events[0].type).toBe('start');
        expect(events[1].type).toBe('end');
      } finally { await cleanup(dir); }
    });
  });

  describe('start/complete cycle', () => {
    it('clean run produces start then end and no running entries', async () => {
      const dir = await makeProjectDir();
      try {
        const started = await startJob(dir, { jobId: 'job-1', name: 'Hello', kind: 'cron' });
        await completeJob(dir, { jobId: 'job-1', runId: started.runId, success: true });
        const events = await readLedger(dir);
        expect(events.map((e) => e.type)).toEqual(['start', 'end']);
        expect(collectRunningEntries(events)).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('failed run records error and is no longer running', async () => {
      const dir = await makeProjectDir();
      try {
        const started = await startJob(dir, { jobId: 'job-2', name: 'Boom', kind: 'manual' });
        await completeJob(dir, { jobId: 'job-2', runId: started.runId, success: false, error: 'oops' });
        const events = await readLedger(dir);
        const end = events.find((e): e is Extract<LedgerEvent, { type: 'end' }> => e.type === 'end');
        expect(end?.success).toBe(false);
        expect(end?.error).toBe('oops');
        expect(collectRunningEntries(events)).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('heartbeat refreshes lastHeartbeatAt and carries checkpoint', async () => {
      const dir = await makeProjectDir();
      try {
        const started = await startJob(dir, { jobId: 'job-3', name: 'Long', kind: 'opportunistic' }, new Date('2020-01-01T00:00:00Z'));
        await heartbeatJob(dir, 'job-3', started.runId, { checkpoint: { step: 2 } }, new Date('2020-01-01T00:01:00Z'));
        const events = await readLedger(dir);
        const running = collectRunningEntries(events);
        expect(running).toHaveLength(1);
        expect(running[0].lastHeartbeatAt).toBe('2020-01-01T00:01:00.000Z');
        expect(running[0].checkpoint).toEqual({ step: 2 });
      } finally { await cleanup(dir); }
    });
  });

  describe('recoverOrphanedJobs', () => {
    it('flags un-ended start past staleAfterMs and emits an orphan event', async () => {
      const dir = await makeProjectDir();
      try {
        const startedAt = new Date('2020-01-01T00:00:00Z');
        await startJob(dir, { jobId: 'job-x', name: 'Crashed', kind: 'cron' }, startedAt);
        const now = new Date('2020-01-01T00:10:00Z'); // 10 minutes later

        const seen: OrphanedEntry[] = [];
        const orphans = await recoverOrphanedJobs(dir, {
          staleAfterMs: DEFAULT_STALE_AFTER_MS,
          now,
          onOrphan: (entry) => { seen.push(entry); },
        });

        expect(orphans).toHaveLength(1);
        expect(orphans[0].jobId).toBe('job-x');
        expect(orphans[0].staleForMs).toBe(10 * 60 * 1000);
        expect(seen).toEqual(orphans);

        const events = await readLedger(dir);
        const orphanedEvents = events.filter((e) => e.type === 'orphaned');
        expect(orphanedEvents).toHaveLength(1);
      } finally { await cleanup(dir); }
    });

    it('is idempotent — second call finds no new orphans', async () => {
      const dir = await makeProjectDir();
      try {
        const startedAt = new Date('2020-01-01T00:00:00Z');
        await startJob(dir, { jobId: 'job-y', name: 'Crashed', kind: 'cron' }, startedAt);
        const now = new Date('2020-01-01T00:10:00Z');
        const first = await recoverOrphanedJobs(dir, { now });
        const second = await recoverOrphanedJobs(dir, { now });
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(0);
      } finally { await cleanup(dir); }
    });

    it('clean completed runs produce no orphans', async () => {
      const dir = await makeProjectDir();
      try {
        const started = await startJob(dir, { jobId: 'job-z', name: 'OK', kind: 'manual' });
        await completeJob(dir, { jobId: 'job-z', runId: started.runId, success: true });
        const orphans = await recoverOrphanedJobs(dir, { now: new Date(Date.now() + 24 * 60 * 60 * 1000) });
        expect(orphans).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('does not flag entries still inside the stale window', async () => {
      const dir = await makeProjectDir();
      try {
        const startedAt = new Date('2020-01-01T00:00:00Z');
        await startJob(dir, { jobId: 'fresh', name: 'Recent', kind: 'cron' }, startedAt);
        // 1 minute later, within the default 5-minute stale window.
        const orphans = await recoverOrphanedJobs(dir, { now: new Date('2020-01-01T00:01:00Z') });
        expect(orphans).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('uses lastHeartbeat as the activity anchor', async () => {
      const dir = await makeProjectDir();
      try {
        const startedAt = new Date('2020-01-01T00:00:00Z');
        const started = await startJob(dir, { jobId: 'hb', name: 'HB', kind: 'opportunistic' }, startedAt);
        await heartbeatJob(dir, 'hb', started.runId, {}, new Date('2020-01-01T00:09:00Z'));
        // 10 min after start but only 1 min after last heartbeat — should NOT be orphaned.
        const orphans = await recoverOrphanedJobs(dir, { now: new Date('2020-01-01T00:10:00Z') });
        expect(orphans).toEqual([]);
      } finally { await cleanup(dir); }
    });

    it('logs but does not crash when onOrphan throws', async () => {
      const dir = await makeProjectDir();
      try {
        await startJob(dir, { jobId: 'bad', name: 'Bad', kind: 'cron' }, new Date('2020-01-01T00:00:00Z'));
        const errors: string[] = [];
        const orphans = await recoverOrphanedJobs(dir, {
          now: new Date('2020-01-01T00:10:00Z'),
          onOrphan: () => { throw new Error('handler exploded'); },
          logError: (msg) => { errors.push(msg); },
        });
        expect(orphans).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/handler exploded/);
      } finally { await cleanup(dir); }
    });
  });

  describe('listOrphanedRuns', () => {
    it('returns hydrated orphan entries, newest first', async () => {
      const dir = await makeProjectDir();
      try {
        await startJob(dir, { jobId: 'a', name: 'A', kind: 'cron' }, new Date('2020-01-01T00:00:00Z'));
        await startJob(dir, { jobId: 'b', name: 'B', kind: 'manual' }, new Date('2020-01-01T00:00:30Z'));
        await recoverOrphanedJobs(dir, { now: new Date('2020-01-01T00:10:00Z') });
        const orphans = await listOrphanedRuns(dir);
        expect(orphans).toHaveLength(2);
        // Newest first; b was started 30s after a, so its orphan event is later.
        expect(orphans[0].jobId).toBe('b');
        expect(orphans[1].jobId).toBe('a');
        expect(orphans[0].name).toBe('B');
      } finally { await cleanup(dir); }
    });

    it('honours the limit', async () => {
      const dir = await makeProjectDir();
      try {
        await startJob(dir, { jobId: 'a', name: 'A', kind: 'cron' }, new Date('2020-01-01T00:00:00Z'));
        await startJob(dir, { jobId: 'b', name: 'B', kind: 'cron' }, new Date('2020-01-01T00:00:01Z'));
        await recoverOrphanedJobs(dir, { now: new Date('2020-01-01T00:10:00Z') });
        const orphans = await listOrphanedRuns(dir, { limit: 1 });
        expect(orphans).toHaveLength(1);
      } finally { await cleanup(dir); }
    });
  });

  describe('concurrent appends', () => {
    it('all events survive parallel writes', async () => {
      const dir = await makeProjectDir();
      try {
        const writes: Promise<unknown>[] = [];
        for (let i = 0; i < 20; i++) {
          writes.push(startJob(dir, { jobId: `job-${i}`, name: `J${i}`, kind: 'cron' }));
        }
        await Promise.all(writes);
        const events = await readLedger(dir);
        expect(events.filter((e) => e.type === 'start')).toHaveLength(20);
      } finally { await cleanup(dir); }
    });
  });
});
