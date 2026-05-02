#!/usr/bin/env node

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

async function main() {
  // package.json bin entry maps `harness` -> dist/cli/index.js, not dist/cli.js.
  // The previous path silently exited non-zero with a Node "Cannot find module"
  // error and was never traced because the smoke wrapper swallowed it.
  const harnessPath = path.resolve(__dirname, '../dist/cli/index.js');
  if (!existsSync(harnessPath)) {
    throw new Error(`harness CLI not built at ${harnessPath} — run \`npm run build\` first`);
  }

  return new Promise((resolve, reject) => {
    // `--mode dontAsk` is required in headless mode: without it, the very
    // first tool call (typically `reflect`) blocks waiting for a permission
    // approval that no human is there to give, and the process hangs until
    // the timeout fires.
    // `--max-turns 3` caps the loop so weak open-weight models that get
    // stuck in a reflect/promote_pattern self-loop (gemma4:e4b, qwen
    // coder series) still terminate before the smoke times out.
    // `--unproductive-turn-limit 2` short-circuits as soon as the model
    // has called two non-edit tools in a row — e.g. reflect, reflect.
    // The smoke is proving the CLI completes a round-trip; chasing
    // models that loop on reflect is out of scope.
    const child = spawn(
      'node',
      [harnessPath, '-p', 'say hello', '--mode', 'dontAsk', '--max-turns', '3', '--unproductive-turn-limit', '2'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // Hard timeout — without this, a stuck Ollama backend or a model
    // that quietly never responds will hang the smoke run indefinitely
    // and the autonomy loop's per-task budget can't catch it. Override
    // with HARNESS_SMOKE_TIMEOUT_MS.
    const timeoutMs = parseInt(process.env.HARNESS_SMOKE_TIMEOUT_MS || '60000', 10);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`harness exited with code ${code}. stderr: ${stderr}`));
      } else {
        console.log(JSON.stringify({ ok: true, code: 0, stdoutBytes: stdout.length }, null, 2));
        resolve();
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn harness: ${error.message}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
