import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'jarvis-mcp-serve.js');

describe('jarvis-mcp-serve subprocess', () => {
  // ts-node is a devDep; if it isn't installed (CI minimal), skip gracefully.
  const tsNodeInstalled = fs.existsSync(path.resolve(__dirname, '..', '..', 'node_modules', 'ts-node'));
  const itOrSkip = tsNodeInstalled ? it : it.skip;

  itOrSkip('round-trips tools/list over stdio', async () => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // Wait for the "ready on stdio" log line on stderr (max ~20s for ts-node cold start).
    await waitFor(() => stderr.includes('ready on stdio') || stderr.includes('fatal'), 20_000);

    if (stderr.includes('fatal')) {
      proc.kill();
      throw new Error(`subprocess fatal: ${stderr.slice(-400)}`);
    }

    proc.stdin.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');

    await waitFor(() => stdout.length > 0, 5_000);
    proc.kill();

    const firstLine = stdout.trim().split('\n')[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBe(1);
    expect(Array.isArray(parsed.result.tools)).toBe(true);
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
