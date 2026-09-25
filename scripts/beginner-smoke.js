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
    let modelOptions = [{ name: 'groq/test-model', backend: 'groq', capabilities: {} }];
    await page.route('**/api/models', (route) => route.fulfill({ json: { models: modelOptions } }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && Boolean(document.getElementById('firstRunSetup')));
    await page.locator('#onboardModal button:has-text("Skip")').click();
    await page.evaluate(() => {
      const details = document.getElementById('welcomeFirstRun');
      if (details) details.open = true;
    });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    const result = await page.evaluate(() => {
      const readiness = document.getElementById('firstRunHealth');
      const status = document.getElementById('firstRunStatus');
      const quickStart = document.getElementById('quickStartBtn');
      const setup = document.getElementById('firstRunSetup');
      const input = document.getElementById('chatInput');
      const elements = [readiness, quickStart, setup, input];
      const fits = elements.every((element) => {
        const box = element?.getBoundingClientRect();
        return box && box.width <= window.innerWidth && box.left >= -1 && box.right <= window.innerWidth + 1;
      });
      const verdictText = readiness?.textContent || '';
      const actionable = /Chat \(configured, not verified\)|Chat \(needs attention\)/i.test(verdictText);
      return {
        ok: Boolean(readiness && status && quickStart && setup && input && fits && actionable),
        status: status?.textContent || '',
        verdictText,
        quickStartDisabled: Boolean(quickStart?.disabled),
        viewportWidth: window.innerWidth,
        fits,
        actionable,
      };
    });
    if (!result.ok) throw new Error(`Beginner smoke failed: ${JSON.stringify(result, null, 2)}\n--- server output (tail) ---\n${server.output().slice(-4000)}`);
    const scenarios = [
      { state: 'configured', status: 'Configuration checked. No chat request was sent.', message: 'Groq credentials configured; inference not verified.' },
      { state: 'blocked', status: 'The selected chat provider needs attention.', message: 'Groq requires GROQ_API_KEY.' },
      { state: 'needs-model', status: 'The selected chat model needs attention.', message: 'Choose a chat model.' },
    ];
    let activeScenario = scenarios[0];
    await page.route('**/api/setup/health?*', async (route) => {
      await route.fulfill({ json: {
        chat: { backend: 'groq', model: 'test-model', state: activeScenario.state, verified: false, message: activeScenario.message },
        ollama: { ok: false, modelCount: 0, message: 'Ollama offline.' },
        vision: { ok: false, message: 'Not configured.' },
        audio: { ok: false, message: 'Not configured.' },
      } });
    });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const scenario of scenarios) {
        activeScenario = scenario;
        await page.click('#firstRunSetup button:has-text("Check setup")');
        await page.waitForFunction((expected) => document.getElementById('firstRunHealth')?.textContent.includes(expected), scenario.message);
        const actual = await page.evaluate(() => ({
          status: document.getElementById('firstRunStatus')?.textContent,
          details: document.getElementById('firstRunHealth')?.textContent,
          fits: ['firstRunHealth', 'firstRunSetup'].every((id) => {
            const element = document.getElementById(id);
            const box = element.getBoundingClientRect();
            return box.left >= -1 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
          }),
        }));
        if (actual.status !== scenario.status || !actual.details.includes('Ollama (optional for selected chat)') || !actual.fits) {
          throw new Error(`Provider readiness failed at ${width}px: ${JSON.stringify(actual)}`);
        }
      }
    }
    modelOptions = [
      { name: 'groq/test-model', backend: 'groq', capabilities: {} },
      { name: 'qwen3:1.7b', backend: 'ollama', capabilities: {} },
    ];
    let savedModel = '';
    let settingsStatus = 200;
    await page.route('**/api/settings', route => route.request().method() === 'GET'
      ? route.fulfill({ status: settingsStatus, json: { model: savedModel } })
      : route.continue());
    const selections = [
      { saved: '', status: 200, expected: '' },
      { saved: 'groq/test-model', status: 200, expected: 'groq/test-model' },
      { saved: 'missing-model', status: 200, expected: '' },
      { saved: 'groq/test-model', status: 503, expected: '' },
    ];
    for (const selection of selections) {
      savedModel = selection.saved;
      settingsStatus = selection.status;
      await page.evaluate(() => loadModels());
      const actual = await page.locator('#modelSelect').inputValue();
      const sendDisabled = await page.locator('#sendBtn').isDisabled();
      if (actual !== selection.expected || (!selection.expected && !sendDisabled)) {
        throw new Error(`Model selection did not preserve explicit choice: ${JSON.stringify({ selection, actual, sendDisabled })}`);
      }
    }
    settingsStatus = 200;
    await page.selectOption('#modelSelect', 'groq/test-model');
    let chatRequests = 0;
    let chatEvents = [];
    let chatMode = 'events';
    let releaseHeldRequest;
    await page.route('**/api/chat', async (route) => {
      chatRequests += 1;
      if (chatMode === 'offline') return route.abort('internetdisconnected');
      if (chatMode === 'held') {
        await new Promise(resolve => { releaseHeldRequest = resolve; });
        return route.abort('aborted');
      }
      return route.fulfill({ contentType: 'text/event-stream', body: chatEvents.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
    });
    await page.waitForFunction(() => document.getElementById('modelSelect')?.value === 'groq/test-model');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.evaluate(() => startQuickTest());
    await page.waitForFunction(() => !document.querySelector('[data-quick-test-outcome]'));
    if (chatRequests !== 0) throw new Error('Cancelled quick test sent a chat request.');
    const outcomes = [
      { events: [{ type: 'text', content: 'A test response.' }, { type: 'done', reason: 'completed' }], state: 'responded' },
      { events: [{ type: 'error', message: 'Provider unavailable.' }, { type: 'done', reason: 'completed' }], state: 'not verified' },
      { events: [{ type: 'text', content: 'Partial response.' }], state: 'not verified' },
      { events: [{ type: 'error', message: 'The selected model does not support tools.' }, { type: 'done', reason: 'error' }], state: 'not verified' },
      { events: [], mode: 'offline', state: 'not verified' },
      { events: [{ type: 'text', content: 'Recovered response.' }, { type: 'done', reason: 'completed' }], state: 'responded' },
    ];
    for (const outcome of outcomes) {
      chatEvents = outcome.events;
      chatMode = outcome.mode || 'events';
      let confirmation = '';
      page.once('dialog', async (dialog) => { confirmation = dialog.message(); await dialog.accept(); });
      await page.evaluate(() => startQuickTest());
      const state = await page.locator('[data-quick-test-outcome]').last().getAttribute('data-quick-test-outcome');
      if (state !== outcome.state || !confirmation.includes(projectDir) || !confirmation.includes('Charges may apply')) {
        throw new Error(`Quick-test outcome mismatch: ${state}; expected ${outcome.state}`);
      }
    }
    if (chatRequests !== outcomes.length) throw new Error(`Unexpected quick-test request count: ${chatRequests}`);
    chatMode = 'held';
    page.once('dialog', dialog => dialog.accept());
    const heldRequest = page.waitForRequest(request => request.url().endsWith('/api/chat'));
    await page.evaluate(() => { window.smokeQuickTest = startQuickTest(); });
    await page.waitForFunction(() => isSending && activeChatController !== null);
    await heldRequest;
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.smokeQuickTest);
    releaseHeldRequest();
    const cancelled = await page.locator('[data-quick-test-outcome]').last().getAttribute('data-quick-test-outcome');
    if (cancelled !== 'stopped' || await page.locator('#sendBtn').isDisabled()) throw new Error('Cancelled work was marked successful or left Send disabled.');
    await page.route('**/api/readiness', route => route.abort('internetdisconnected'));
    const beforeOfflineSetup = chatRequests;
    await page.evaluate(() => startQuickTest());
    if (chatRequests !== beforeOfflineSetup) throw new Error('Offline workspace check sent a chat request.');
    const recoveredMessages = [
      { role: 'system', content: '[Continuity checkpoint]\nVerify the existing output.' },
      { role: 'user', content: 'Verify the output.', images: [] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'write-1', function: { name: 'file_write', arguments: { path: 'out/result.json' } } }] },
      { role: 'tool', content: 'Written', tool_call_id: 'write-1' },
    ];
    let recoveryDiagnostics = { missing: true, unreadable: false, corruptLines: 0 };
    let recoveryStatus = 200;
    await page.route('**/api/sessions/recovery-fixture', route => route.fulfill({ status: recoveryStatus, json: { messages: recoveredMessages, diagnostics: recoveryDiagnostics } }));
    await page.evaluate(() => { lastSessionId = 'untouched'; chatMessages = [{ role: 'user', content: 'Keep current chat' }]; });
    const originalChat = await page.locator('#chatArea').innerHTML();
    await page.evaluate(() => recoverSession('recovery-fixture'));
    if (await page.evaluate(() => lastSessionId !== 'untouched' || chatMessages[0]?.content !== 'Keep current chat')) throw new Error('Missing transcript replaced current chat.');
    recoveryDiagnostics = { missing: false, unreadable: true, corruptLines: 0 };
    await page.evaluate(() => recoverSession('recovery-fixture'));
    if (await page.evaluate(() => lastSessionId !== 'untouched' || chatMessages[0]?.content !== 'Keep current chat')) throw new Error('Unreadable transcript replaced current chat.');
    recoveryDiagnostics = { missing: false, unreadable: false, corruptLines: 0 };
    recoveryStatus = 503;
    await page.evaluate(() => recoverSession('recovery-fixture'));
    if (await page.evaluate(() => lastSessionId !== 'untouched' || chatMessages[0]?.content !== 'Keep current chat')) throw new Error('Failed session response replaced current chat.');
    recoveryStatus = 200;
    recoveryDiagnostics = { missing: false, unreadable: false, corruptLines: 1 };
    page.once('dialog', dialog => dialog.dismiss());
    await page.evaluate(() => recoverSession('recovery-fixture'));
    if (await page.evaluate(() => lastSessionId !== 'untouched' || chatMessages[0]?.content !== 'Keep current chat')) throw new Error('Cancelled partial recovery replaced current chat.');
    if (await page.locator('#chatArea').innerHTML() !== originalChat) throw new Error('Rejected recovery changed visible chat.');
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => recoverSession('recovery-fixture'));
    const restored = await page.evaluate(() => ({ messages: chatMessages, sessionId: lastSessionId }));
    if (JSON.stringify(restored.messages) !== JSON.stringify(recoveredMessages) || restored.sessionId !== 'recovery-fixture') throw new Error('Resume lost checkpoint or tool-call metadata.');
    if (chatRequests !== beforeOfflineSetup) throw new Error('Session recovery sent an unsolicited model request.');
    console.log(JSON.stringify({ ok: true, projectDir, port, ...result, quickTestOutcomes: outcomes.length, cancelledInFlight: true, offlineSetupBlocked: true, partialRecoveryConfirmed: true, recoveryMetadataPreserved: true }, null, 2));
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
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
