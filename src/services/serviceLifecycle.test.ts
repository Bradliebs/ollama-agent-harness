import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  canTransition,
  getServiceLifecycle,
  getServiceTemplate,
  initServiceLifecycle,
  probeServiceHealth,
  transitionService,
  SERVICE_TEMPLATES,
} from './serviceLifecycle';

describe('serviceLifecycle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-lifecycle-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('initializes lifecycle state', async () => {
    const state = await initServiceLifecycle(tmpDir, 'test_svc');
    expect(state.service_id).toBe('test_svc');
    expect(state.status).toBe('draft');

    const loaded = await getServiceLifecycle(tmpDir, 'test_svc');
    expect(loaded?.status).toBe('draft');
  });

  it('transitions from draft to active', async () => {
    await initServiceLifecycle(tmpDir, 'test_svc');
    const result = await transitionService(tmpDir, 'test_svc', 'active');
    expect(result.success).toBe(true);
    expect(result.from).toBe('draft');
    expect(result.to).toBe('active');

    const loaded = await getServiceLifecycle(tmpDir, 'test_svc');
    expect(loaded?.status).toBe('active');
    expect(loaded?.previous_status).toBe('draft');
  });

  it('rejects invalid transition', async () => {
    await initServiceLifecycle(tmpDir, 'test_svc');
    const result = await transitionService(tmpDir, 'test_svc', 'error');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot transition');
  });

  it('allows no-op transition to same status', async () => {
    await initServiceLifecycle(tmpDir, 'test_svc');
    const result = await transitionService(tmpDir, 'test_svc', 'draft');
    expect(result.success).toBe(true);
  });

  it('auto-initializes on transition if not yet created', async () => {
    const result = await transitionService(tmpDir, 'new_svc', 'active');
    expect(result.success).toBe(true);
    expect(result.from).toBe('draft');
  });
});

describe('canTransition', () => {
  it('allows draft → active', () => expect(canTransition('draft', 'active')).toBe(true));
  it('allows active → paused', () => expect(canTransition('active', 'paused')).toBe(true));
  it('allows active → error', () => expect(canTransition('active', 'error')).toBe(true));
  it('allows archived → active', () => expect(canTransition('archived', 'active')).toBe(true));
  it('rejects draft → error', () => expect(canTransition('draft', 'error')).toBe(false));
  it('rejects paused → error', () => expect(canTransition('paused', 'error')).toBe(false));
});

describe('SERVICE_TEMPLATES', () => {
  it('has at least 5 templates', () => {
    expect(SERVICE_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it('retrieves bullet_journal template by id', () => {
    const tmpl = getServiceTemplate('bullet_journal');
    expect(tmpl).toBeDefined();
    expect(tmpl!.name).toBe('Bullet Journal');
    expect(tmpl!.default_commands.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown template', () => {
    expect(getServiceTemplate('nonexistent')).toBeUndefined();
  });
});

describe('probeServiceHealth', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-health-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports unhealthy when files are missing', async () => {
    const result = await probeServiceHealth(tmpDir, 'missing_svc');
    expect(result.healthy).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports healthy when files exist', async () => {
    const svcDir = path.join(tmpDir, '.harness', 'services', 'good_svc');
    await fs.mkdir(svcDir, { recursive: true });
    await fs.writeFile(path.join(svcDir, 'service.json'), '{"service_id":"good_svc"}');
    await fs.writeFile(path.join(svcDir, 'state.json'), '{"tasks":[]}');
    const result = await probeServiceHealth(tmpDir, 'good_svc');
    expect(result.healthy).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
