#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
// OLLAMA_HOST is a server bind directive that may be scheme-less (e.g. "0.0.0.0:11434");
// normalise to a client URL so `new URL` / `fetch` accept it. Mirrors src/web/server.ts.
function normaliseHost(raw) {
  const trimmed = String(raw).trim().replace(/\/$/, '');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = '11434';
    if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '') {
      url.hostname = 'localhost';
    }
    return url.origin;
  } catch {
    return DEFAULT_HOST;
  }
}
const host = normaliseHost(argValue('--host') || process.env.OLLAMA_HOST || DEFAULT_HOST);
const timeoutMs = Number(argValue('--timeout-ms') || process.env.HARNESS_ROUTING_PROBE_TIMEOUT_MS || 60000);
const requestedModels = values('--model');

async function main() {
  const models = requestedModels.length > 0 ? requestedModels : await listCloudModels();
  if (models.length === 0) {
    console.log(JSON.stringify({ ok: true, host, models: [], note: 'No installed :cloud models found.' }, null, 2));
    return;
  }

  const results = [];
  for (const model of models) {
    const result = runProbe(model);
    results.push(result);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, host, results }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function listCloudModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
    const body = await response.json();
    return (Array.isArray(body.models) ? body.models : [])
      .map((model) => String(model.name || ''))
      .filter((name) => name.endsWith(':cloud'))
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

function runProbe(model) {
  const script = path.join(__dirname, 'lean-gemma-tool-probe.js');
  const child = spawnSync(process.execPath, [script, '--model', model, '--host', host, '--timeout-ms', String(timeoutMs)], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: process.env,
  });
  const stdout = String(child.stdout || '').trim();
  const stderr = String(child.stderr || '').trim();
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    model,
    ok: child.status === 0 && Boolean(parsed?.toolCallOk),
    status: child.status,
    toolCallOk: Boolean(parsed?.toolCallOk),
    exactFinalOk: Boolean(parsed?.exactFinalOk),
    firstToolCallNames: Array.isArray(parsed?.firstToolCallNames) ? parsed.firstToolCallNames : [],
    firstPromptTokens: parsed?.firstPromptTokens ?? null,
    secondPromptTokens: parsed?.secondPromptTokens ?? null,
    stderr: stderr.slice(0, 500),
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function values(name) {
  const found = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) found.push(process.argv[index + 1]);
  }
  return found;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});