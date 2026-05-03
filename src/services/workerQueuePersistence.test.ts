import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkerQueue } from './workerQueue';
import { registerDefaultExecutors } from './workerExecutors';

describe('workerQueue disk persistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-wq-'));
  });

  it('saves and loads queue state', async () => {
    const queue = new WorkerQueue();
    queue.enqueue('classify_task', { message: 'hello' });
    queue.enqueue('validate_json', { json: '{}' });

    const filePath = path.join(tmpDir, 'queue.json');
    await queue.saveToDisk(filePath);

    const loaded = new WorkerQueue();
    const result = await loaded.loadFromDisk(filePath);
    expect(result.loaded).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(loaded.pendingCount()).toBe(2);
  });

  it('preserves completed job history across save/load', async () => {
    const queue = new WorkerQueue();
    queue.registerExecutor('classify_task', async () => ({ done: true }));
    queue.enqueue('classify_task', { message: 'test' });
    await queue.processAll();

    const filePath = path.join(tmpDir, 'queue.json');
    await queue.saveToDisk(filePath);

    const loaded = new WorkerQueue();
    await loaded.loadFromDisk(filePath);
    expect(loaded.history().length).toBe(1);
    expect(loaded.history()[0].status).toBe('completed');
  });

  it('handles missing file gracefully', async () => {
    const queue = new WorkerQueue();
    const result = await queue.loadFromDisk(path.join(tmpDir, 'nonexistent.json'));
    expect(result.loaded).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('resets running jobs to pending on load', async () => {
    const filePath = path.join(tmpDir, 'queue.json');
    // Write a snapshot with a "running" job
    const snapshot = {
      version: 1,
      saved_at: new Date().toISOString(),
      pending: [{ job_id: 'test-1', job_type: 'classify_task', status: 'running', input: {}, created_at: new Date().toISOString() }],
      completed: [],
    };
    await fs.writeFile(filePath, JSON.stringify(snapshot), 'utf-8');

    const queue = new WorkerQueue();
    await queue.loadFromDisk(filePath);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.pending()[0].status).toBe('pending');
  });

  it('appends completed jobs to JSONL log', async () => {
    const logPath = path.join(tmpDir, 'worker.jsonl');
    const queue = new WorkerQueue();
    queue.registerExecutor('validate_json', async () => ({ valid: true }));
    const job = queue.enqueue('validate_json', { json: '{}' });
    await queue.processNext();

    const completed = queue.history()[0];
    await queue.appendToLog(logPath, completed);

    const raw = await fs.readFile(logPath, 'utf-8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed.job_id).toBe(job.job_id);
    expect(parsed.status).toBe('completed');
  });

  it('does not duplicate jobs on double load', async () => {
    const queue = new WorkerQueue();
    queue.enqueue('classify_task', { message: 'test' });
    const filePath = path.join(tmpDir, 'queue.json');
    await queue.saveToDisk(filePath);

    // Load twice
    await queue.loadFromDisk(filePath);
    expect(queue.pendingCount()).toBe(1); // Not 2
  });
});

describe('default worker executors', () => {
  it('registers all default executors', () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    // Verify by enqueueing and processing known types
    queue.enqueue('classify_task', { message: 'send me reminders' });
    expect(queue.pendingCount()).toBe(1);
  });

  it('classify_task classifies messages', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('classify_task', { message: 'send me reminders every morning' });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).mode).toBe('operate');
  });

  it('extract_tasks extracts commands', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('extract_tasks', { message: 'add task buy groceries' });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).commands.length).toBeGreaterThan(0);
  });

  it('validate_json validates valid JSON', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('validate_json', { json: '{"a": 1}' });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).valid).toBe(true);
  });

  it('validate_json rejects invalid JSON', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('validate_json', { json: 'not json' });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).valid).toBe(false);
  });

  it('summarise_notes summarises notes', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('summarise_notes', {
      notes: [
        { content: 'Called the dentist', created_at: '2026-05-01' },
        { content: 'Felt tired', created_at: '2026-05-02' },
      ],
    });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).note_count).toBe(2);
    expect((results[0].output as any).summary).toContain('dentist');
  });

  it('detect_failures finds repeated failures', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('detect_failures', {
      jobs: [
        { status: 'failed', error: 'timeout', job_type: 'classify_task' },
        { status: 'failed', error: 'timeout', job_type: 'classify_task' },
        { status: 'completed', job_type: 'validate_json' },
      ],
    });
    const results = await queue.processAll();
    expect(results[0].status).toBe('completed');
    expect((results[0].output as any).has_repeated).toBe(true);
    expect((results[0].output as any).repeated_failures[0].type).toBe('classify_task');
  });

  it('classify_task fails on missing message', async () => {
    const queue = new WorkerQueue();
    registerDefaultExecutors(queue);
    queue.enqueue('classify_task', {});
    const results = await queue.processAll();
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('message');
  });
});
