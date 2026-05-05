import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  appendEvent,
  emitEvent,
  queryEvents,
  getEvent,
  createSnapshot,
  getSnapshot,
  listSnapshots,
  getUndoEvents,
  summarizeEventStore,
  generatePostmortem,
} from './eventStore';

describe('eventStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-events-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends and queries events', async () => {
    const ev = await appendEvent(tmpDir, { category: 'service', type: 'service_created', data: { name: 'test' }, actor: 'user' });
    expect(ev.event_id).toBeTruthy();
    expect(ev.timestamp).toBeTruthy();

    const results = await queryEvents(tmpDir, { category: 'service' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('service_created');
  });

  it('emits convenience events', async () => {
    await emitEvent(tmpDir, 'promise', 'promise_created', { commitment: 'test' }, 'agent', 'p1');
    const results = await queryEvents(tmpDir, { category: 'promise', subject_id: 'p1' });
    expect(results).toHaveLength(1);
  });

  it('retrieves event by id', async () => {
    const ev = await appendEvent(tmpDir, { category: 'tool', type: 'tool_called', data: { tool: 'file_read' }, actor: 'agent' });
    const found = await getEvent(tmpDir, ev.event_id);
    expect(found?.event_id).toBe(ev.event_id);
  });

  it('returns null for unknown event id', async () => {
    const found = await getEvent(tmpDir, 'nonexistent');
    expect(found).toBeNull();
  });

  it('filters by time range', async () => {
    await emitEvent(tmpDir, 'system', 'boot', {}, 'system');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const results = await queryEvents(tmpDir, { after: future });
    expect(results).toHaveLength(0);
  });

  it('limits results', async () => {
    for (let i = 0; i < 5; i++) {
      await emitEvent(tmpDir, 'system', `event_${i}`, { i }, 'system');
    }
    const results = await queryEvents(tmpDir, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('creates and retrieves snapshots', async () => {
    const snap = await createSnapshot(tmpDir, 'svc1', { tasks: [1, 2] }, 'ev-123');
    expect(snap.snapshot_id).toBeTruthy();

    const loaded = await getSnapshot(tmpDir, 'svc1');
    expect(loaded?.state).toEqual({ tasks: [1, 2] });

    const subjects = await listSnapshots(tmpDir);
    expect(subjects).toContain('svc1');
  });

  it('returns null for missing snapshot', async () => {
    expect(await getSnapshot(tmpDir, 'nonexistent')).toBeNull();
  });

  it('gets undo events', async () => {
    const ev1 = await emitEvent(tmpDir, 'task', 'task_added', { title: 'a' }, 'user', 'svc1');
    const ev2 = await emitEvent(tmpDir, 'task', 'task_added', { title: 'b' }, 'user', 'svc1');
    await emitEvent(tmpDir, 'task', 'task_closed', { title: 'a' }, 'user', 'svc1');

    // Undo from ev2 onward should only keep ev1
    const remaining = await getUndoEvents(tmpDir, 'svc1', ev2.event_id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event_id).toBe(ev1.event_id);
  });

  it('preserves chronological order when emissions share a millisecond timestamp', async () => {
    // Force three events to share an identical timestamp the way fast CI hosts can.
    // Without a file-append tiebreaker, queryEvents sort+reverse rotates the order
    // and getUndoEvents returns the wrong slice.
    const fixed = '2026-05-05T00:00:00.000Z';
    const realToISOString = Date.prototype.toISOString;
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(fixed);
    try {
      const ev1 = await emitEvent(tmpDir, 'task', 'task_added', { title: 'a' }, 'user', 'svc-tie');
      const ev2 = await emitEvent(tmpDir, 'task', 'task_added', { title: 'b' }, 'user', 'svc-tie');
      const ev3 = await emitEvent(tmpDir, 'task', 'task_closed', { title: 'a' }, 'user', 'svc-tie');
      expect(ev1.timestamp).toBe(ev2.timestamp);
      expect(ev2.timestamp).toBe(ev3.timestamp);

      const remaining = await getUndoEvents(tmpDir, 'svc-tie', ev2.event_id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].event_id).toBe(ev1.event_id);
    } finally {
      Date.prototype.toISOString = realToISOString;
    }
  });

  it('summarizes the event store', async () => {
    await emitEvent(tmpDir, 'service', 'created', {}, 'user');
    await emitEvent(tmpDir, 'tool', 'called', {}, 'agent');
    await emitEvent(tmpDir, 'tool', 'called', {}, 'agent');

    const summary = await summarizeEventStore(tmpDir);
    expect(summary.total_events).toBe(3);
    expect(summary.categories.tool).toBe(2);
    expect(summary.categories.service).toBe(1);
  });

  it('generates postmortem', async () => {
    await emitEvent(tmpDir, 'tool', 'tool_called', { tool: 'web_read' }, 'agent', 'svc1');
    await emitEvent(tmpDir, 'tool', 'tool_failed', { tool: 'web_read', error: 'timeout' }, 'agent', 'svc1');

    const pm = await generatePostmortem(tmpDir, 'svc1');
    expect(pm).toContain('Postmortem: svc1');
    expect(pm).toContain('FAILURE');
  });

  it('returns message when no failures for postmortem', async () => {
    await emitEvent(tmpDir, 'service', 'created', {}, 'user', 'svc1');
    const pm = await generatePostmortem(tmpDir, 'svc1');
    expect(pm).toContain('No failure events');
  });
});
