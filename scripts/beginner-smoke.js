#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

async function main() {
  const { chromium } = require('playwright');
  const port = await getFreePort();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-beginner-smoke-project-'));
  const server = startHarnessServer(projectDir, port);
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && Boolean(document.getElementById('beginnerReadiness')));
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      const details = document.getElementById('welcomeFirstRun');
      if (details) details.open = true;
    });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    const result = await page.evaluate(() => {
      const readiness = document.getElementById('beginnerReadiness');
      const title = document.getElementById('beginnerReadinessTitle');
      const badge = document.getElementById('beginnerReadinessBadge');
      const quickStart = document.getElementById('quickStartBtn');
      const setup = document.getElementById('firstRunSetup');
      const input = document.getElementById('chatInput');
      const elements = [readiness, quickStart, setup, input];
      const fits = elements.every((element) => {
        const box = element?.getBoundingClientRect();
        return box && box.width <= window.innerWidth && box.left >= -1 && box.right <= window.innerWidth + 1;
      });
      const verdictText = readiness?.textContent || '';
      const actionable = /Ready for first chat|Start Ollama first|Install one model|Pick a model|Setup check failed/i.test(verdictText);
      return {
        ok: Boolean(readiness && title && badge && quickStart && setup && input && fits && actionable),
        title: title?.textContent || '',
        badge: badge?.textContent || '',
        verdictText,
        quickStartDisabled: Boolean(quickStart?.disabled),
        viewportWidth: window.innerWidth,
        fits,
        actionable,
      };
    });
    if (!result.ok) throw new Error(`Beginner smoke failed: ${JSON.stringify(result, null, 2)}`);
    console.log(JSON.stringify({ ok: true, projectDir, port, ...result }, null, 2));
  } finally {
    if (browser) await browser.close();
    await stopChild(server.child);
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
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
      HARNESS_UI_SMOKE_CHAT: '1',
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

async function waitForServer(url, server) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (server.child.exitCode !== null) throw new Error(`Harness server exited early with code ${server.child.exitCode}:\n${server.output()}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes('Ollama Agent Harness')) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for Harness server at ${url}:\n${server.output()}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000).unref?.();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
