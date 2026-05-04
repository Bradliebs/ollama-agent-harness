import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createPromise, listPromises, fulfilPromise, checkObligations } from '../services/promiseLedger';
import { initServiceLifecycle, transitionService, getServiceLifecycle, probeServiceHealth } from '../services/serviceLifecycle';
import { appendEvent, emitEvent, queryEvents, summarizeEventStore, pruneEventsByAge } from '../persistence/eventStore';
import { buildRepoGraph, analyzeImpact, summarizeRepo, generateArchitectureDiagram } from '../core/codeIntelligence';

/**
 * Integration test: exercises the full lifecycle of service creation → promise
 * creation → event emission → obligation checking → verification → impact analysis.
 */
describe('subsystem integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-integ-'));
    // Set up a mini source tree for code intelligence
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await fs.writeFile(path.join(srcDir, 'main.ts'), "import { add } from './utils';\nexport function run() { return add(1, 2); }\n");
    await fs.writeFile(path.join(srcDir, 'main.test.ts'), "import { run } from './main';\ntest('run', () => expect(run()).toBe(3));\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: service → promise → events → obligations → graph → impact', async () => {
    // 1. Service lifecycle
    const lifecycle = await initServiceLifecycle(tmpDir, 'test_svc', 'draft');
    expect(lifecycle.status).toBe('draft');

    const activated = await transitionService(tmpDir, 'test_svc', 'active');
    expect(activated.success).toBe(true);

    const state = await getServiceLifecycle(tmpDir, 'test_svc');
    expect(state?.status).toBe('active');

    // 2. Create a promise linked to the service
    const promise = await createPromise(tmpDir, 'I will check this daily', {
      service_id: 'test_svc',
      schedule_id: 'job-123',
      capability_required: 'scheduler',
    });
    expect(promise.status).toBe('pending');

    // 3. Emit events
    await emitEvent(tmpDir, 'service', 'service_created', { service_id: 'test_svc' }, 'user', 'test_svc');
    await emitEvent(tmpDir, 'promise', 'promise_created', { promise_id: promise.promise_id }, 'agent', promise.promise_id);
    await emitEvent(tmpDir, 'schedule', 'job_executed', { job_id: 'job-123' }, 'scheduler', 'job-123');

    // 4. Check obligations
    const obligations = await checkObligations(tmpDir);
    expect(obligations.pending).toBe(1);
    expect(obligations.breaches).toHaveLength(0);

    // 5. Fulfil promise
    const fulfilled = await fulfilPromise(tmpDir, promise.promise_id);
    expect(fulfilled?.status).toBe('fulfilled');

    // 6. Check obligations again
    const obligationsAfter = await checkObligations(tmpDir);
    expect(obligationsAfter.pending).toBe(0);
    expect(obligationsAfter.fulfilled).toBe(1);

    // 7. Query events
    const events = await queryEvents(tmpDir, { category: 'promise' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // 8. Summarize event store
    const summary = await summarizeEventStore(tmpDir);
    expect(summary.total_events).toBe(3);
    expect(summary.categories.service).toBe(1);
    expect(summary.categories.promise).toBe(1);
    expect(summary.categories.schedule).toBe(1);

    // 9. Build code intelligence graph
    const graph = await buildRepoGraph(tmpDir);
    expect(graph.nodes.size).toBe(3);

    const repoSummary = summarizeRepo(graph);
    expect(repoSummary.total_files).toBe(3);
    expect(repoSummary.test_files).toBe(1);

    // 10. Impact analysis
    const impact = analyzeImpact(graph, ['src/utils.ts']);
    expect(impact.direct).toContain('src/main.ts');
    expect(impact.affected_tests).toContain('src/main.test.ts');

    // 11. Architecture diagram
    const diagram = generateArchitectureDiagram(graph);
    expect(diagram).toContain('graph LR');
    expect(diagram).toContain('src');

    // 12. Event age pruning
    const pruned = await pruneEventsByAge(tmpDir, 0); // 0 days = prune all
    expect(pruned).toBe(3);
    const afterPrune = await summarizeEventStore(tmpDir);
    expect(afterPrune.total_events).toBe(0);
  });

  it('service health check detects missing files', async () => {
    const health = await probeServiceHealth(tmpDir, 'nonexistent_svc');
    expect(health.healthy).toBe(false);
    expect(health.issues.length).toBeGreaterThan(0);
  });

  it('promise with overdue date creates breach', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await createPromise(tmpDir, 'Overdue promise', { next_due_at: past });
    const obligations = await checkObligations(tmpDir);
    expect(obligations.breaches).toHaveLength(1);
    expect(obligations.breaches[0].breach_type).toBe('overdue');
  });
});
