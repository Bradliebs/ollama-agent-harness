#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
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
    return 'http://localhost:11434';
  }
}
const realOllamaHost = normaliseHost(process.env.OLLAMA_HOST || process.env.HARNESS_OLLAMA_HOST || 'http://localhost:11434');
const retryRef = `retry-fault-probe-${Date.now()}`;

async function main() {
  const realModels = await fetchJson(new URL('/api/tags', realOllamaHost));
  const model = process.env.HARNESS_RETRY_PROBE_MODEL || realModels.models?.[0]?.name;
  if (!model) throw new Error(`No Ollama models available from ${realOllamaHost}. Pull one model before running this probe.`);

  const proxyPort = await getFreePort();
  const appPort = await getFreePort();
  const proxy = await startFaultProxy(proxyPort);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-retry-probe-project-'));
  const app = startHarnessServer(projectDir, appPort);
  try {
    await waitForServer(`http://127.0.0.1:${appPort}/`, app);
    const base = `http://127.0.0.1:${appPort}`;
    await postJson(`${base}/api/settings`, { ollamaHost: `http://127.0.0.1:${proxyPort}`, model });
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, message: 'Reply with exactly: retry probe ok' }),
    });
    const body = await response.text();
    const retryIndex = body.indexOf('"type":"model_retry"');
    const textIndex = body.indexOf('"type":"text"');
    const ok = response.status === 200
      && proxy.chatAttempts >= 2
      && retryIndex >= 0
      && body.includes(retryRef)
      && (textIndex === -1 || retryIndex < textIndex);
    const result = {
      ok,
      status: response.status,
      model,
      proxyPort,
      appPort,
      chatAttempts: proxy.chatAttempts,
      retryEventBeforeText: retryIndex >= 0 && (textIndex === -1 || retryIndex < textIndex),
      bodyPreview: body.slice(0, 600),
    };
    if (!ok) throw new Error(`Retry fault probe failed: ${JSON.stringify(result, null, 2)}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopChild(app.child);
    await closeServer(proxy.server);
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

async function startFaultProxy(port) {
  const target = new URL(realOllamaHost);
  const state = { chatAttempts: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/api/chat')) {
      state.chatAttempts += 1;
      if (state.chatAttempts === 1) {
        const payload = JSON.stringify({ error: `Internal Server Error (ref: ${retryRef})` });
        res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
        req.resume();
        return;
      }
    }
    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    };
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(options, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', (error) => {
      const payload = JSON.stringify({ error: error.message || String(error) });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    get chatAttempts() { return state.chatAttempts; },
  };
}

function startHarnessServer(projectDir, port) {
  const output = [];
  const child = spawn(process.execPath, [
    '-r',
    require.resolve('ts-node/register', { paths: [root] }),
    path.join(root, 'src', 'web', 'server.ts'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NO_OPEN: '1',
      HARNESS_PROJECT_DIR: projectDir,
      HARNESS_DISABLE_STARTUP_CONNECTORS: '1',
      HARNESS_OLLAMA_CHAT_MAX_ATTEMPTS: '2',
      HARNESS_OLLAMA_CHAT_RETRY_DELAY_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    output.push(chunk.toString());
    while (output.join('').length > 12000) output.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, output: () => output.join('') };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed with ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, app) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (app.child.exitCode !== null) throw new Error(`Harness server exited early with code ${app.child.exitCode}:\n${app.output()}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes('Ollama Agent Harness')) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for Harness server at ${url}:\n${app.output()}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000).unref?.();
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
