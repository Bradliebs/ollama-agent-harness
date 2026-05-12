import { WorkerQueue } from './workerQueue';

describe('workerQueue', () => {
  it('enqueues and processes a job', async () => {
    const queue = new WorkerQueue();
    queue.registerExecutor('classify_task', async (job) => ({ classification: 'operate', input: job.input }));
    queue.enqueue('classify_task', { message: 'send me reminders' });
    expect(queue.pendingCount()).toBe(1);

    const result = await queue.processNext();
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
    expect(queue.pendingCount()).toBe(0);
  });

  it('handles job failure gracefully', async () => {
    const queue = new WorkerQueue();
    queue.registerExecutor('scan_logs', async () => { throw new Error('Log file not found'); });
    queue.enqueue('scan_logs', {});

    const result = await queue.processNext();
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('Log file not found');
  });

  it('fails jobs with no executor', async () => {
    const queue = new WorkerQueue();
    queue.enqueue('validate_json', { data: '{}' });

    const result = await queue.processNext();
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('No executor');
  });

  it('processes all pending jobs', async () => {
    const queue = new WorkerQueue();
    queue.registerExecutor('classify_task', async (job) => job.input);
    queue.registerExecutor('summarise_notes', async (job) => job.input);
    queue.enqueue('classify_task', { a: 1 });
    queue.enqueue('summarise_notes', { b: 2 });
    queue.enqueue('classify_task', { c: 3 });

    const results = await queue.processAll();
    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(queue.pendingCount()).toBe(0);
  });

  it('tracks completed job history', async () => {
    const queue = new WorkerQueue();
    queue.registerExecutor('classify_task', async () => 'done');
    queue.enqueue('classify_task', {});
    await queue.processNext();
    expect(queue.history().length).toBe(1);
    expect(queue.history()[0].status).toBe('completed');
  });

  it('returns null when no pending jobs', async () => {
    const queue = new WorkerQueue();
    const result = await queue.processNext();
    expect(result).toBeNull();
  });

  it('clears pending jobs', () => {
    const queue = new WorkerQueue();
    queue.enqueue('classify_task', {});
    queue.enqueue('classify_task', {});
    const cleared = queue.clear();
    expect(cleared).toBe(2);
    expect(queue.pendingCount()).toBe(0);
  });

  it('associates jobs with service and model IDs', () => {
    const queue = new WorkerQueue();
    const job = queue.enqueue('classify_task', {}, { service_id: 'bullet_journal', model_id: 'llama3.1:8b' });
    expect(job.service_id).toBe('bullet_journal');
    expect(job.model_id).toBe('llama3.1:8b');
  });

  it('retrieves jobs by ID', () => {
    const queue = new WorkerQueue();
    const job = queue.enqueue('classify_task', { x: 1 });
    expect(queue.getJob(job.job_id)).toBeDefined();
    expect(queue.getJob(job.job_id)!.job_type).toBe('classify_task');
  });
});
