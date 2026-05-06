import { spawn } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';

const UI_SMOKE_SCRIPT = resolve(__dirname, '../../scripts/ui-smoke.js');

describe('scripts/ui-smoke.js fresh mode', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
      server?.close((error) => error ? reject(error) : resolveClose());
    });
    server = undefined;
  });

  it('refuses to reuse a reachable default local smoke server', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>stale smoke server</title>');
    });
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');

    const result = await runUiSmokeFresh(address.port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Fresh UI smoke requested');
    expect(result.stderr).toContain(`http://127.0.0.1:${address.port}/ is already reachable`);
  });
});

async function runUiSmokeFresh(port: number): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [UI_SMOKE_SCRIPT, '--fresh'], {
      env: {
        ...process.env,
        HARNESS_UI_SMOKE_PORT: String(port),
        HARNESS_UI_URL: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status: number | null) => resolveRun({ status, stderr }));
  });
}
