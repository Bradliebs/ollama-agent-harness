import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createPromise, listPromises, updatePromise, checkObligations, fulfilPromise, failPromise, detectCommitments } from './promiseLedger';

describe('promiseLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-promise-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates and lists a promise', async () => {
    const p = await createPromise(tmpDir, 'I will remind you every morning');
    expect(p.promise_id).toBeTruthy();
    expect(p.status).toBe('pending');
    expect(p.commitment).toBe('I will remind you every morning');

    const all = await listPromises(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].promise_id).toBe(p.promise_id);
  });

  it('updates promise status', async () => {
    const p = await createPromise(tmpDir, 'I will check this daily');
    const updated = await updatePromise(tmpDir, p.promise_id, { status: 'fulfilled' });
    expect(updated?.status).toBe('fulfilled');

    const all = await listPromises(tmpDir, { status: 'fulfilled' });
    expect(all).toHaveLength(1);
  });

  it('fulfils a promise', async () => {
    const p = await createPromise(tmpDir, 'I will send you a report');
    const result = await fulfilPromise(tmpDir, p.promise_id);
    expect(result?.status).toBe('fulfilled');
    expect(result?.last_fulfilled_at).toBeTruthy();
  });

  it('fails a promise', async () => {
    const p = await createPromise(tmpDir, 'I will monitor this');
    const result = await failPromise(tmpDir, p.promise_id);
    expect(result?.failure_count).toBe(1);
    expect(result?.status).toBe('pending');

    const marked = await failPromise(tmpDir, p.promise_id, true);
    expect(marked?.status).toBe('failed');
  });

  it('checks obligations and detects overdue', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await createPromise(tmpDir, 'I will remind you', { next_due_at: past });

    const result = await checkObligations(tmpDir);
    expect(result.pending).toBe(1);
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0].breach_type).toBe('overdue');
  });

  it('detects repeated failure breach', async () => {
    const p = await createPromise(tmpDir, 'I will monitor this');
    await updatePromise(tmpDir, p.promise_id, { failure_count: 3 });

    const result = await checkObligations(tmpDir);
    expect(result.breaches.some((b) => b.breach_type === 'repeated_failure')).toBe(true);
  });

  it('returns null for unknown promise id', async () => {
    const result = await updatePromise(tmpDir, 'nonexistent', { status: 'fulfilled' });
    expect(result).toBeNull();
  });

  it('filters by service_id', async () => {
    await createPromise(tmpDir, 'Promise A', { service_id: 'svc1' });
    await createPromise(tmpDir, 'Promise B', { service_id: 'svc2' });

    const filtered = await listPromises(tmpDir, { service_id: 'svc1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].commitment).toBe('Promise A');
  });
});

describe('detectCommitments', () => {
  it('detects reminder language', () => {
    const found = detectCommitments("I'll remind you every morning at 9am.");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain('remind you');
  });

  it('detects monitoring language', () => {
    const found = detectCommitments("I will monitor this site for changes.");
    expect(found.length).toBeGreaterThan(0);
  });

  it('returns empty for non-commitment text', () => {
    const found = detectCommitments("Here is the code you asked for.");
    expect(found).toHaveLength(0);
  });

  it('detects scheduling language', () => {
    const found = detectCommitments("I'll schedule a daily check.");
    expect(found.length).toBeGreaterThan(0);
  });

  it('detects follow-up language', () => {
    const found = detectCommitments("I'll follow up on this tomorrow.");
    expect(found.length).toBeGreaterThan(0);
  });
});
