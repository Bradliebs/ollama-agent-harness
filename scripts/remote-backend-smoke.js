#!/usr/bin/env node
/*
 * Remote backend smoke — exercises one cheap model per OpenAI-compatible
 * backend (Cerebras, Groq, GitHub Models, Mistral, OpenRouter, OpenAI)
 * end-to-end through the CLI to prove v0.2.2 backend wiring still works.
 *
 * Backend is selected by --backend; model by --model. The CLI is invoked
 * with -p "say hello" and the same hardening flags as scripts/headless-smoke.js
 * (--mode dontAsk, --max-turns 3, --unproductive-turn-limit 2).
 *
 * Backends with no configured API key (env or .harness/api-keys.json)
 * are SKIPPED, not failed. The smoke only fails if a configured backend
 * round-trips with a non-zero exit. This way users with one backend
 * configured see a green run while the other 5 are clearly skipped.
 *
 * Override the per-backend model via env:
 *   HARNESS_SMOKE_MODEL_CEREBRAS=llama3.1-8b
 *   HARNESS_SMOKE_MODEL_GROQ=llama-3.1-8b-instant
 *   HARNESS_SMOKE_MODEL_GITHUB=gpt-4o-mini
 *   HARNESS_SMOKE_MODEL_MISTRAL=mistral-small-latest
 *   HARNESS_SMOKE_MODEL_OPENROUTER=meta-llama/llama-3.3-70b-instruct:free
 *   HARNESS_SMOKE_MODEL_OPENAI=gpt-4o-mini
 *
 * Skip a specific backend even when a key is present:
 *   HARNESS_SMOKE_SKIP=openai,openrouter
 *
 * Per-backend timeout in ms (default 60000):
 *   HARNESS_SMOKE_TIMEOUT_MS=120000
 */

const { spawn } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');

const HARNESS_PATH = process.env.HARNESS_SMOKE_CLI_PATH
  || path.resolve(__dirname, '../dist/cli/index.js');
const TIMEOUT_MS = parseInt(process.env.HARNESS_SMOKE_TIMEOUT_MS || '60000', 10);
const SKIP = new Set(
  (process.env.HARNESS_SMOKE_SKIP || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

const BACKENDS = [
  { id: 'cerebras', envKeys: ['CEREBRAS_API_KEY'], defaultModel: 'llama3.1-8b' },
  { id: 'groq', envKeys: ['GROQ_API_KEY'], defaultModel: 'llama-3.1-8b-instant' },
  { id: 'github', envKeys: ['GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'], defaultModel: 'gpt-4o-mini' },
  { id: 'mistral', envKeys: ['MISTRAL_API_KEY'], defaultModel: 'mistral-small-latest' },
  { id: 'openrouter', envKeys: ['OPENROUTER_API_KEY'], defaultModel: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'openai', envKeys: ['OPENAI_API_KEY'], defaultModel: 'gpt-4o-mini' },
];

/**
 * Returns true if any of the listed env vars is set OR the key is present
 * in `.harness/api-keys.json`. The latter mirrors how the web UI stores
 * keys entered through Settings — so users who never exported anything to
 * their shell still get covered.
 */
function isConfigured(envKeys) {
  for (const name of envKeys) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return true;
  }
  const apiKeysPath = path.resolve(__dirname, '..', '.harness', 'api-keys.json');
  if (!existsSync(apiKeysPath)) return false;
  try {
    const stored = JSON.parse(readFileSync(apiKeysPath, 'utf-8'));
    for (const name of envKeys) {
      const value = stored[name];
      if (typeof value === 'string' && value.trim().length > 0) return true;
    }
  } catch {
    // Malformed file — treat as not configured rather than crashing.
  }
  return false;
}

function runOne(backend, model) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [
        HARNESS_PATH,
        '-p', 'say hello',
        '--mode', 'dontAsk',
        '--backend', backend,
        '--model', model,
        '--max-turns', '3',
        '--unproductive-turn-limit', '2',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: `timeout after ${TIMEOUT_MS}ms`, code: null });
    }, TIMEOUT_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, code: 0, stdoutBytes: stdout.length });
      } else {
        // Trim noisy backend errors to first few lines for readability.
        const trimmed = stderr.split('\n').slice(0, 4).join('\n');
        resolve({ ok: false, reason: `exit ${code}: ${trimmed}`, code });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn failed: ${error.message}`, code: null });
    });
  });
}

async function main() {
  if (!existsSync(HARNESS_PATH)) {
    throw new Error(`harness CLI not built at ${HARNESS_PATH} — run \`npm run build\` first`);
  }

  const results = [];
  for (const { id, envKeys, defaultModel } of BACKENDS) {
    if (SKIP.has(id)) {
      results.push({ backend: id, status: 'skipped', reason: 'in HARNESS_SMOKE_SKIP' });
      continue;
    }
    if (!isConfigured(envKeys)) {
      results.push({ backend: id, status: 'skipped', reason: `no key (${envKeys.join('/')})` });
      continue;
    }
    const modelEnv = `HARNESS_SMOKE_MODEL_${id.toUpperCase()}`;
    const model = process.env[modelEnv] || defaultModel;
    process.stdout.write(`[${id}] model=${model} ... `);
    const result = await runOne(id, model);
    if (result.ok) {
      console.log('PASS');
      results.push({ backend: id, status: 'pass', model });
    } else {
      console.log(`FAIL — ${result.reason}`);
      results.push({ backend: id, status: 'fail', model, reason: result.reason });
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    total: results.length,
  };
  console.log('---');
  console.log(JSON.stringify({ summary, results }, null, 2));

  if (summary.fail > 0) process.exitCode = 1;
  if (summary.pass === 0 && summary.skipped === results.length) {
    console.log('NOTE: no remote backends configured — set at least one *_API_KEY to exercise this smoke.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
