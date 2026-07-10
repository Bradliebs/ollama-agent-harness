import type { Server } from 'http';
import express from 'express';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createIdentityRouter, type IdentityRoutesDeps } from './identityRoutes';
import { listIdentityHistory } from '../services/identityHistory';

jest.setTimeout(20_000);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'identity-routes-test-'));
}
async function cleanup(dir: string): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Mirrors server.ts's requireAuditReason contract: trimmed reason must be at
// least 8 characters, otherwise send 400 and return null.
function requireAuditReason(value: unknown, res: express.Response, label: string): string | null {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 8) {
    res.status(400).json({ error: `${label} requires a reason of at least 8 characters.` });
    return null;
  }
  return reason;
}

interface TestHarness {
  server: Server;
  baseUrl: string;
  projectDir: string;
}

async function startHarness(overrides?: Partial<IdentityRoutesDeps>): Promise<TestHarness> {
  const projectDir = await makeTempDir();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const router = createIdentityRouter({
    projectDir,
    requireAuth: () => true,
    requireAuditReason,
    logger: { info: () => { /* noop */ } },
    ...overrides,
  });
  app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, projectDir };
}

async function stopHarness(h: TestHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => h.server.close((err) => err ? reject(err) : resolve()));
  await cleanup(h.projectDir);
}

async function putAutoUpdate(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/identity/auto-update`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('web/identityRoutes — auto-update pre-arm baseline', () => {
  let h: TestHarness;
  afterEach(async () => { if (h) await stopHarness(h); });

  it('captures a labelled baseline snapshot when enabling adaptive identity', async () => {
    h = await startHarness();
    const res = await putAutoUpdate(h.baseUrl, { user: true, soul: false, reason: 'auditing identity drift' });
    expect(res.status).toBe(200);

    const history = await listIdentityHistory(h.projectDir);
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('Adaptive identity armed: auditing identity drift');
  });

  it('does not capture a snapshot when disabling adaptive identity', async () => {
    h = await startHarness();
    const res = await putAutoUpdate(h.baseUrl, { user: false, soul: false });
    expect(res.status).toBe(200);

    const history = await listIdentityHistory(h.projectDir);
    expect(history).toHaveLength(0);
  });

  it('rejects enabling without a reason and captures no snapshot', async () => {
    h = await startHarness();
    const res = await putAutoUpdate(h.baseUrl, { user: false, soul: true });
    expect(res.status).toBe(400);

    const history = await listIdentityHistory(h.projectDir);
    expect(history).toHaveLength(0);
  });
});
