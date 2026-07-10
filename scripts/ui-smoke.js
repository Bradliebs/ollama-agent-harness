#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const freshLocalServer = args.includes('--fresh') || truthy(process.env.HARNESS_UI_SMOKE_FRESH);
const providedTargetUrl = args.find((arg) => !arg.startsWith('--')) || process.env.HARNESS_UI_URL || '';
const defaultSmokePort = process.env.HARNESS_UI_SMOKE_PORT || '4300';
const targetUrl = providedTargetUrl || `http://127.0.0.1:${defaultSmokePort}/`;
const dashboardRenderTimeoutMs = 30000;

async function main() {
  const cleanupServer = await ensureTargetServer();
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    try {
      await runStaticSmoke();
    } finally {
      await cleanupServer();
    }
    return;
  }

  const browser = await chromium.launch({ headless: true });
  instrumentBrowserDiagnostics(browser);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Suppress the first-visit onboarding modal (shown ~400ms after load) so it
    // does not overlay and intercept later clicks such as "Verify install".
    await page.addInitScript(() => {
      try { localStorage.setItem('harness.onboardSeen', String(Date.now())); } catch (e) {}
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && Boolean(window.loadReadiness));
    const slashPaletteSmoke = await page.evaluate(() => {
      const input = document.getElementById('chatInput');
      if (!input || typeof autoSize !== 'function') return { ok: false, reason: 'chat input or autoSize missing' };
      input.value = '/';
      input.focus();
      autoSize(input);
      const palette = document.getElementById('slashPalette');
      const items = Array.from(document.querySelectorAll('#slashPaletteList .slash-palette-item'));
      const visible = Boolean(palette && !palette.classList.contains('hidden'));
      const hasHelp = items.some((item) => item.textContent?.includes('/help'));
      input.value = '';
      autoSize(input);
      return { ok: visible && items.length > 0 && hasHelp, visible, itemCount: items.length, hasHelp };
    });
    let dynamicSkillSlashCommandSmoke = { ok: false, reason: 'not run' };
    let myceliumContextCardsSmoke = { ok: false, reason: 'not run' };
    let inboxStripSmoke = { ok: false, reason: 'not run' };
    let topbarPetSmoke = { ok: false, reason: 'not run' };
    await page.evaluate(() => { const details = document.getElementById('welcomeFirstRun'); if (details) details.open = true; });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    const mobileBeginnerSmoke = await runMobileBeginnerSmoke(browser, targetUrl);
    const freshStartupSmoke = await runFreshStartupSmoke(browser, targetUrl);
    const historyRestoreSmoke = await runHistoryRestoreSmoke(browser, targetUrl);
    await page.click('text=Verify install');
    await page.evaluate(async () => {
      const response = await fetch('/api/about');
      renderAboutPanel(await response.json());
    });
    await page.waitForFunction(() => document.getElementById('aboutPanel')?.textContent.includes('Manifest'));
    await page.evaluate(() => document.getElementById('verifyReleaseBtn')?.click());
    await page.waitForFunction(() => !document.getElementById('releaseVerificationPanel').classList.contains('initial-hidden'));
    dynamicSkillSlashCommandSmoke = await runDynamicSkillSlashCommandSmoke(browser, targetUrl);
    myceliumContextCardsSmoke = await runMyceliumContextCardsSmoke(browser, targetUrl);
    inboxStripSmoke = await runInboxStripSmoke(browser, targetUrl);
    topbarPetSmoke = await runTopbarPetSmoke(browser, targetUrl);
    let panelToggleSmoke = { ok: false, reason: 'not run' };
    panelToggleSmoke = await runPanelToggleSmoke(browser, targetUrl);
    await page.evaluate(() => { if (document.getElementById('rightPanel')?.classList.contains('hidden')) toggleRight(); });
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Run setup doctor'))?.click());
    await page.waitForFunction(() => !document.getElementById('settingsDoctorHealth').classList.contains('initial-hidden'));
    await page.waitForFunction(() => document.querySelectorAll('#outputValidationTemplates button').length > 0);
    await page.evaluate(() => document.querySelector('#outputValidationTemplates button')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationProfilesStatus')?.textContent.includes('Installed'));
    await page.evaluate(() => { document.getElementById('outputValidationPreviewText').value = 'Implemented src/web/server.ts and ran npm test plus npm run typecheck.'; document.getElementById('outputValidationProfile').value = 'coding-answer'; });
    await page.evaluate(() => document.getElementById('previewOutputValidationBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationPreviewResult')?.textContent.includes('coding-answer'));
    await page.evaluate(() => { document.getElementById('outputValidationPreviewText').value = 'It will be cloudy.'; document.getElementById('outputValidationProfile').value = 'factual-answer'; });
    await page.evaluate(() => document.getElementById('previewOutputValidationBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationPreviewResult')?.textContent.includes('Try:'));
    await page.evaluate(() => {
      document.getElementById('customProfileId').value = 'smoke-profile';
      document.getElementById('customProfileLabel').value = 'Smoke Profile';
      document.getElementById('customProfileDescription').value = 'Created by UI smoke.';
      document.getElementById('customProfileInstructions').value = 'Mention smoke validation.';
    });
    await page.evaluate(() => document.getElementById('saveProfileFromFormBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationProfilesStatus')?.textContent.includes('custom profiles saved'));
    await page.evaluate(() => { window.__guidedProfileSavedSmoke = true; });
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Refresh trace exports'))?.click());
    await page.evaluate(async () => {
      const data = await fetch('/api/capabilities').then((response) => response.json());
      const host = document.createElement('div');
      host.innerHTML = renderCapabilityAlignmentPanel({ items: data.capabilities, summary: data.summary });
      document.body.appendChild(host);
      window.__capabilityAlignmentSmoke = Boolean(document.getElementById('capabilityAlignmentPanel')) && document.getElementById('capabilityAlignmentPanel').textContent.includes('Live broker trading');
    });
    await page.evaluate(() => showLeftTab('skills', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('skills'"))));
    await page.waitForFunction(() => Boolean(document.getElementById('skillList')) && Boolean(document.getElementById('skillDiagnostics')) && Boolean(document.getElementById('skillAutomationPanel')));
    const skillsTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('skillList')).display !== 'none');
    await page.evaluate(() => showLeftTab('palace', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('palace'"))));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    const palaceTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    await page.evaluate(() => showLeftTab('discovery', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('discovery'"))));
    await page.waitForFunction(() => Boolean(document.getElementById('discoveryPanel')));
    const operateModeSmoke = await page.evaluate(async () => {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'check https://example.com/ui-smoke-agentic-service daily to see if it is available' }) });
      const body = await response.text();
      const secondResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'check https://example.org/ui-smoke-agentic-service daily to see if the price drops' }) });
      const secondBody = await secondResponse.text();
      const selectedModelResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'send me a telegram reminder', model: 'github/gpt-4.1' }) });
      const selectedModelBody = await selectedModelResponse.text();
      await loadDiscovery();
      await loadOperatingServiceDetail('not_configured');
      const missingDetailUnavailable = document.getElementById('operatingServiceDetail')?.textContent.includes('Service details unavailable');
      const serviceButtons = Array.from(document.querySelectorAll('#operatingServicesDiscoveryPanel button')).filter((button) => button.textContent?.includes('Details'));
      return {
        status: response.status,
        secondStatus: secondResponse.status,
        selectedModelStatus: selectedModelResponse.status,
        body,
        secondBody,
        selectedModelBody,
        serviceButtonCount: serviceButtons.length,
        missingDetailUnavailable,
        hasExportControl: Boolean(Array.from(document.querySelectorAll('#operatingServicesDiscoveryPanel button')).find((button) => button.textContent?.includes('Export JSON'))),
        hasImportControl: Boolean(document.getElementById('operatingServiceImportFile')),
        hasServicePanelText: document.getElementById('operatingServicesDiscoveryPanel')?.textContent.includes('Site Monitor Agent'),
      };
    });
    await page.locator('#operatingServicesDiscoveryPanel button:has-text("Details")').first().click();
    await page.waitForFunction(() => document.getElementById('operatingServiceDetail')?.textContent.includes('storage'));
    const operatingServiceDetailRendered = await page.evaluate(() => document.getElementById('operatingServiceDetail')?.textContent.includes('storage'));
    const exportDownload = await Promise.all([
      page.waitForEvent('download'),
      page.click('#operatingServicesDiscoveryPanel button:has-text("Export JSON")'),
    ]).then(([download]) => download);
    let exportPath = await exportDownload.path();
    if (!exportPath) {
      exportPath = path.join(os.tmpdir(), `harness-operating-services-export-${Date.now()}.json`);
      await exportDownload.saveAs(exportPath);
    }
    const exportedServicesPayload = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    const importPath = path.join(os.tmpdir(), `harness-operating-services-import-${Date.now()}.json`);
    fs.writeFileSync(importPath, JSON.stringify(exportedServicesPayload, null, 2), 'utf-8');
    const fileChooser = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#operatingServicesDiscoveryPanel button:has-text("Import JSON")'),
    ]).then(([chooser]) => chooser);
    await fileChooser.setFiles(importPath);
    // Import reports completion via an in-page toast (showToast), not a browser
    // dialog as it once did. Waiting on a never-firing 'dialog' event hung the
    // smoke forever; instead wait for the toast text and capture it.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('div')).some((el) => el.style.zIndex === '10000' && /Imported \d+ service\(s\); skipped \d+\./.test(el.textContent || '')), null, { timeout: 15000 });
    const importDialogMessage = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div')).find((node) => node.style.zIndex === '10000' && /Imported \d+ service\(s\); skipped \d+\./.test(node.textContent || ''));
      return el ? el.textContent.trim() : '';
    });
    await page.waitForFunction(() => document.getElementById('operatingServicesDiscoveryPanel')?.textContent.includes('service(s) configured'));
    await page.locator('#operatingServicesDiscoveryPanel button:has-text("Details")').first().click();
    await page.waitForFunction(() => document.getElementById('operatingServiceDetail')?.textContent.includes('storage'));
    const importedOperatingServiceDetailRendered = await page.evaluate(() => document.getElementById('operatingServiceDetail')?.textContent.includes('storage'));
    fs.rmSync(importPath, { force: true });
    const operatingServiceExportImportRoundTrip = {
      exportedServiceCount: Array.isArray(exportedServicesPayload.services) ? exportedServicesPayload.services.length : 0,
      importDialogMessage,
    };
    const capabilityStarterSmoke = await page.evaluate(async () => {
      if (typeof loadReadiness !== 'function' || typeof loadCapabilityTemplates !== 'function') return { ok: false, reason: 'starter functions missing' };
      await loadReadiness();
      await loadCapabilityTemplates();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const panel = document.getElementById('capabilityTemplatePanel');
      const detailsButton = Array.from(panel?.querySelectorAll('button') || []).find((button) => button.textContent?.includes('Details'));
      if (!panel || !detailsButton) return { ok: false, reason: 'starter details button missing', panelText: panel?.textContent || '' };
      await loadCapabilityTemplateStarterDetail('meeting-notes-actions');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const detail = document.getElementById('capabilityTemplateDetail');
      const hasDetail = Boolean(detail?.textContent.includes('Meeting Notes to Action Items Starter'));
      const hasPreviewControl = Boolean(Array.from(detail?.querySelectorAll('button') || []).find((button) => button.textContent?.includes('Preview')));
      const hasTriggerContracts = Boolean(detail?.textContent.includes('Triggers:') && detail.textContent.includes('message-ingest'));
      if (typeof runCapabilityTemplateStarterAction !== 'function') return { ok: false, reason: 'starter action function missing', hasDetail, hasPreviewControl };
      await runCapabilityTemplateStarterAction('meeting-notes-actions', 'preview');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const statusText = document.getElementById('capabilityTemplateActionStatus')?.textContent || '';
      return {
        ok: hasDetail && hasPreviewControl && hasTriggerContracts && statusText.includes('Preview ready'),
        hasPanel: Boolean(panel),
        hasDetail,
        hasPreviewControl,
        hasTriggerContracts,
        statusText,
      };
    });
    await page.evaluate(() => showLeftTab('runs', document.querySelector('[onclick*="showLeftTab(\'runs\'"]')));
    await page.waitForFunction(() => document.getElementById('runsView')?.textContent.includes('Operating service export') && document.getElementById('runsView')?.textContent.includes('Operating service import'));
    const operatingServiceEvidenceVisible = await page.evaluate(() => document.getElementById('runsView')?.textContent.includes('Operating service export') && document.getElementById('runsView')?.textContent.includes('Operating service import'));
    const automationJobSafetyVisible = await page.evaluate(() => document.getElementById('automationJobSafetyPanel')?.textContent.includes('Safety audit'));
    await page.evaluate(() => showLeftTab('discovery', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('discovery'"))));
    const discoveryTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('discoveryView')).display !== 'none');
    await page.evaluate(() => showLeftTab('learning', document.querySelector('[onclick*="learning"]')));
    await page.waitForFunction(() => Boolean(document.getElementById('learningCandidateQueue')));
    const learningWasVisible = await page.evaluate(() => getComputedStyle(document.getElementById('learningView')).display !== 'none');
    // Navigate remaining tabs to verify they render without errors
    for (const tab of ['files', 'memory', 'snapshots', 'rag', 'runs', 'workflows']) {
      await page.evaluate((t) => showLeftTab(t, document.querySelector(`[onclick*="showLeftTab('${t}'"]`)), tab);
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => showLeftTab('mycelium', document.querySelector('[onclick*="showLeftTab(\'mycelium\'"]')));
    await page.waitForFunction(() => document.getElementById('myceliumView')?.textContent.includes('Mycelium Network'));
    const myceliumTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('myceliumView')).display !== 'none');
    // Navigate tools tab last so its dynamically-rendered panels don't
    // create duplicate IDs before the dedup check runs.
    await page.evaluate(() => showLeftTab('tools', document.querySelector('[onclick*="showLeftTab(\'tools\'"]')));
    await page.waitForFunction(() => Boolean(document.querySelector('.mcp-hub')), null, { timeout: dashboardRenderTimeoutMs });
    await page.evaluate(() => {
      const deniedOutput = "Permission denied for 'file_write': Nervous System requires verification";
      if (typeof appendPermissionRecoveryItem !== 'function') return;
      const toolBox = document.createElement('div');
      toolBox.id = 'permissionRecoverySmokeHost';
      toolBox.className = 'tool-list';
      toolBox.style.cssText = 'position:fixed;left:16px;bottom:16px;width:560px;z-index:9999;';
      document.body.appendChild(toolBox);
      appendPermissionRecoveryItem(toolBox, deniedOutput);
      const row = toolBox.querySelector('.tool-item-permission');
      window.__permissionRecoverySmoke = Boolean(row)
        && typeof isPermissionOrRecoveryFailure === 'function'
        && isPermissionOrRecoveryFailure(deniedOutput)
        && row.textContent.includes('Action blocked')
        && row.textContent.includes('Keep going 2h');
    });
    // Final outer wait for the row's locator to be visible before measuring.
    const recoveryRow = page.locator('.tool-item-permission').first();
    await recoveryRow.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const recoveryBox = await recoveryRow.boundingBox().catch(() => null);
    const recoveryButtonBox = recoveryBox
      ? await recoveryRow.locator('button:has-text("Keep going 2h")').boundingBox().catch(() => null)
      : null;
    const recoveryScreenshotPath = path.join(os.tmpdir(), `harness-permission-recovery-${Date.now()}.png`);
    if (recoveryBox) await recoveryRow.screenshot({ path: recoveryScreenshotPath });
    const recoveryLayoutSmoke = Boolean(recoveryBox)
      && recoveryBox.width >= 320
      && recoveryBox.height >= 30
      && Boolean(recoveryButtonBox)
      && recoveryButtonBox.width >= 90
      && recoveryButtonBox.height >= 24
      && fs.existsSync(recoveryScreenshotPath)
      && fs.statSync(recoveryScreenshotPath).size > 100;
    await page.evaluate(() => {
      window.__unattendedRunwayRequests = [];
      window.__unattendedRunwayOriginals = {
        fetch: window.fetch.bind(window),
        loadToolsDashboard: window.loadToolsDashboard,
        loadReadiness: window.loadReadiness,
        loadNervousStatus: window.loadNervousStatus,
        refreshAutonomyBanner: window.refreshAutonomyBanner,
      };
      window.fetch = (resource, init = {}) => {
        const url = typeof resource === 'string' ? resource : resource?.url;
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(init.body) : null;
        if (url === '/api/permissions/timed-autonomy' && method === 'POST') {
          window.__unattendedRunwayRequests.push({ url, method, body });
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url === '/api/tools' && method === 'GET') {
          window.__unattendedRunwayRequests.push({ url, method, body });
          return Promise.resolve(new Response(JSON.stringify({ disabled: ['bash', 'file_edit'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url === '/api/tools/bulk-toggle' && method === 'POST') {
          window.__unattendedRunwayRequests.push({ url, method, body });
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url === '/api/capabilities' && method === 'GET') {
          window.__unattendedRunwayRequests.push({ url, method, body });
          return Promise.resolve(new Response(JSON.stringify({ capabilities: [
            { id: 'arbitrary-shell', posture: 'gated', requiredControls: ['permission-mode'] },
            { id: 'background-autonomous-jobs', posture: 'gated', requiredControls: ['permission-mode'] },
            { id: 'self-modifying-code', posture: 'gated', requiredControls: ['permission-mode'] },
          ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url === '/api/capabilities/grants' && method === 'POST') {
          window.__unattendedRunwayRequests.push({ url, method, body });
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return window.__unattendedRunwayOriginals.fetch(resource, init);
      };
      window.loadToolsDashboard = () => {};
      window.loadReadiness = async () => {};
      window.loadNervousStatus = () => {};
      window.refreshAutonomyBanner = () => {};
    });
    await recoveryRow.locator('button:has-text("Keep going 2h")').click();
    await page.waitForFunction(() => {
      const requests = window.__unattendedRunwayRequests || [];
      return requests.some((request) => request.url === '/api/permissions/timed-autonomy')
        && requests.some((request) => request.url === '/api/tools/bulk-toggle')
        && requests.filter((request) => request.url === '/api/capabilities/grants').length === 3;
    }, null, { timeout: 5000 });
    const unattendedRunwayClickSmoke = await page.evaluate(() => {
      const requests = window.__unattendedRunwayRequests || [];
      const timed = requests.find((request) => request.url === '/api/permissions/timed-autonomy');
      const tools = requests.find((request) => request.url === '/api/tools/bulk-toggle');
      const grants = requests.filter((request) => request.url === '/api/capabilities/grants');
      const button = document.getElementById('unattendedRunwayBtn');
      const ok = timed?.body?.expiresInMinutes === 120
        && timed?.body?.reason === 'One-click unattended runway from chat window'
        && Array.isArray(tools?.body?.names)
        && tools.body.names.includes('bash')
        && tools.body.enabled === true
        && tools.body.expiresInMinutes === 120
        && grants.length === 3
        && grants.every((request) => request.body?.expiresInMinutes === 120 && request.body?.reason === 'One-click unattended runway from chat window')
        && button?.textContent === 'Keep going 2h'
        && button.classList.contains('active');
      const originals = window.__unattendedRunwayOriginals || {};
      if (originals.fetch) window.fetch = originals.fetch;
      if (originals.loadToolsDashboard !== undefined) window.loadToolsDashboard = originals.loadToolsDashboard;
      if (originals.loadReadiness !== undefined) window.loadReadiness = originals.loadReadiness;
      if (originals.loadNervousStatus !== undefined) window.loadNervousStatus = originals.loadNervousStatus;
      if (originals.refreshAutonomyBanner !== undefined) window.refreshAutonomyBanner = originals.refreshAutonomyBanner;
      return { ok, requestCount: requests.length, grantCount: grants.length, buttonText: button?.textContent || '' };
    });
    const mcpDiscoverClickSmoke = await page.evaluate(async () => {
      if (typeof renderMcpRuntimeList !== 'function' || typeof mcpRuntimeDiscoverTools !== 'function') return false;
      const host = document.createElement('div');
      host.innerHTML = renderMcpRuntimeList([{ id: 'smoke-mcp', command: 'node', args: [], running: true, tools: [] }]);
      document.body.appendChild(host);
      const originalFetch = window.fetch.bind(window);
      const originalLoadToolsDashboard = window.loadToolsDashboard;
      let endpointHit = false;
      window.fetch = (resource, init) => {
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url === '/api/mcp/runtime/servers/smoke-mcp/discover-tools' && init?.method === 'POST') {
          endpointHit = true;
          return Promise.resolve(new Response(JSON.stringify({ server: { id: 'smoke-mcp', running: true, tools: [{ name: 'echo' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(resource, init);
      };
      window.loadToolsDashboard = async () => {};
      try {
        host.querySelector('button[onclick*="mcpRuntimeDiscoverTools"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        window.__mcpDiscoveryControlsSmoke = Boolean(host.querySelector('.mcp-hub'))
          && typeof window.mcpRuntimeDiscoverTools === 'function'
          && host.textContent.includes('Discover tools');
        return endpointHit && document.body.textContent.includes('Discovered 1 MCP tool');
      } finally {
        window.fetch = originalFetch;
        window.loadToolsDashboard = originalLoadToolsDashboard;
        host.remove();
      }
    });
    const autonomyStartPayloadSmoke = await page.evaluate(async () => {
      if (typeof renderAutonomyBuilder !== 'function' || typeof startAutonomyRun !== 'function') {
        return { ok: false, reason: 'autonomy builder functions missing' };
      }
      const panel = document.getElementById('autonomyBuilderPanel');
      if (!panel) return { ok: false, reason: 'autonomy builder panel missing' };
      panel.innerHTML = renderAutonomyBuilder({
        planPath: 'IMPLEMENTATION_PLAN.md',
        pending: 1,
        done: 0,
        failed: 0,
        tasks: [{ id: 'ui-smoke-autonomy', title: 'UI smoke autonomy start payload', status: 'pending', anchors: [] }],
      });
      document.getElementById('autonomyMaxIterations').value = '20';
      document.getElementById('autonomyMaxTurns').value = '150';
      document.getElementById('autonomyTimeBudgetHours').value = '0';
      document.getElementById('autonomyUnproductiveTurnLimit').value = '100';
      const originalFetch = window.fetch;
      let startPayload = null;
      window.fetch = (resource, init = {}) => {
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url === '/api/autonomy/start') {
          startPayload = init?.body ? JSON.parse(init.body) : null;
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            pid: 12345,
            requestedMaxIterations: 20,
            requestedMaxTurns: 150,
            requestedUnproductiveTurnLimit: 100,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
      try {
        await startAutonomyRun();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const statusText = document.getElementById('autonomyBuilderStatus')?.textContent || '';
        const acceptedText = document.getElementById('autonomyAcceptedSettings')?.textContent || '';
        return {
          ok: Boolean(startPayload)
            && startPayload.maxIterations === 20
            && startPayload.maxTurns === 150
            && startPayload.unproductiveTurnLimit === 100
            && acceptedText.includes('Server accepted: 20 task(s) this run')
            && acceptedText.includes('150 turns/task')
            && acceptedText.includes('stall limit 100'),
          startPayload,
          statusText,
          acceptedText,
        };
      } finally {
        window.fetch = originalFetch;
      }
    });
    const result = await page.evaluate(({ palaceWasVisible, discoveryWasVisible, skillsWasVisible, learningWasVisible, myceliumWasVisible, operateModeSmoke, operatingServiceExportImportRoundTrip, operatingServiceDetailRendered, importedOperatingServiceDetailRendered, capabilityStarterSmoke, slashPaletteSmoke, dynamicSkillSlashCommandSmoke, myceliumContextCardsSmoke, inboxStripSmoke, topbarPetSmoke, panelToggleSmoke, automationJobSafetyVisible, recoveryLayoutSmoke, recoveryScreenshotPath, unattendedRunwayClickSmoke, mcpDiscoverClickSmoke, mobileBeginnerSmoke, freshStartupSmoke, historyRestoreSmoke }) => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
      // Dynamically-rendered panels may legitimately re-render with the same ID
      const dynamicPanelIds = new Set(['permissionPanel', 'capabilityAlignmentPanel', 'toolRegistryPanel', 'automationRunsSection', 'curatorRunsSection']);
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index && !dynamicPanelIds.has(id));
      return {
        title: document.title,
        mode: 'playwright',
        hasAppScript: Array.from(document.scripts).some((script) => /\/app\.js(\?|$)/.test(script.src)),
        hasChatHistoryApi: typeof window.HarnessChatHistory?.outboundChatHistory === 'function' && typeof window.HarnessChatHistory?.saveChatSession === 'function' && typeof window.HarnessChatHistory?.loadPersistedChatSession === 'function',
        hasPermissionPanel: Boolean(document.getElementById('permissionPanel')),
        hasPermissionRecoveryActionRow: Boolean(window.__permissionRecoverySmoke),
        hasPermissionRecoveryLayout: Boolean(recoveryLayoutSmoke),
        hasUnattendedRunwayClick: Boolean(unattendedRunwayClickSmoke.ok),
        unattendedRunwayClickSmoke,
        permissionRecoveryScreenshotPath: recoveryScreenshotPath,
        hasCapabilityAlignmentPanel: Boolean(window.__capabilityAlignmentSmoke),
        hasChatInput: Boolean(document.getElementById('chatInput')),
        hasTraceExports: Boolean(document.getElementById('traceExports')),
        hasTraceInspector: Boolean(document.getElementById('traceInspector')),
        hasRuntimeStorage: Boolean(document.getElementById('runtimeStorageStatus')),
        hasMcpDiscoveryControls: Boolean(mcpDiscoverClickSmoke) || Boolean(window.__mcpDiscoveryControlsSmoke) || (Boolean(document.querySelector('.mcp-hub')) && typeof window.mcpRuntimeDiscoverTools === 'function' && document.body.textContent.includes('Discover tools')),
        mcpDiscoverClickSmoke: Boolean(mcpDiscoverClickSmoke),
        hasSkillList: Boolean(document.getElementById('skillList')),
        hasSkillDiagnostics: Boolean(document.getElementById('skillDiagnostics')),
        hasSkillAutomationPanel: Boolean(document.getElementById('skillAutomationPanel')) && typeof window.runSkillAutomation === 'function',
        hasOpenSkillsFunction: typeof window.openSkillsTab === 'function' && typeof window.appendOpenSkillsAction === 'function',
        hasDiscoveryView: Boolean(document.getElementById('discoveryView')),
        hasDiscoveryPanel: Boolean(document.getElementById('discoveryPanel')),
        hasModelCatalogPanel: Boolean(document.getElementById('modelCatalogPanel')),
        hasModelRecommendations: (() => {
          const panel = document.getElementById('modelRecommendationsPanel');
          const text = panel?.textContent || '';
          return Boolean(panel) && text.includes('Recommended defaults') && text.includes('Best for coding') && text.includes('Safe local fallback');
        })(),
        hasExtensionDiscoveryPanel: Boolean(document.getElementById('extensionDiscoveryPanel')),
        hasOperatingServicesDiscoveryPanel: Boolean(document.getElementById('operatingServicesDiscoveryPanel')),
        hasOperatingServiceDetailFunction: typeof window.loadOperatingServiceDetail === 'function',
        operatingServiceDetailRendered: Boolean(operatingServiceDetailRendered) && Boolean(importedOperatingServiceDetailRendered),
        operateModeSmokeStatus: operateModeSmoke.status,
        operateModeSmokeHandled: operateModeSmoke.body.includes('"mode":"OPERATE_MODE"') && operateModeSmoke.body.includes('Site Monitor Agent is set up') && operateModeSmoke.secondBody.includes('"mode":"OPERATE_MODE"') && operateModeSmoke.secondBody.includes('Site Monitor Agent is set up') && operateModeSmoke.selectedModelBody.includes('"mode":"OPERATE_MODE"') && Boolean(operateModeSmoke.hasServicePanelText),
        operateModeSmokeSecondStatus: operateModeSmoke.secondStatus,
        operateModeSmokeSelectedModelStatus: operateModeSmoke.selectedModelStatus,
        operatingServiceButtonCount: operateModeSmoke.serviceButtonCount,
        missingOperatingServiceDetailHandled: Boolean(operateModeSmoke.missingDetailUnavailable),
        hasOperatingServiceExportImport: Boolean(operateModeSmoke.hasExportControl) && Boolean(operateModeSmoke.hasImportControl),
        operatingServiceExportImportRoundTrip,
        hasAutomationDiscoveryPanel: Boolean(document.getElementById('automationDiscoveryPanel')),
        hasSessionSearchDiscoveryPanel: Boolean(document.getElementById('sessionSearchDiscoveryPanel')),
        hasCuratorDiscoveryPanel: Boolean(document.getElementById('curatorDiscoveryPanel')),
        hasCuratorSettingsSection: Boolean(document.getElementById('curatorSettingsSection')) && Boolean(document.getElementById('curatorEnabled')),
        hasKillSwitchShortcut: typeof window.toggleKillSwitchShortcut === 'function' && typeof window.refreshKillSwitchBanner === 'function',
        hasModelCatalogSettings: Boolean(document.getElementById('modelCatalogUrl')) && Boolean(document.getElementById('modelCatalogTtlHours')) && Boolean(document.getElementById('refreshModelCatalogBtn')),
        hasExtensionPolicySettings: Boolean(document.getElementById('extensionExecutableToggle')) && Boolean(document.getElementById('extensionPermissionReviewToggle')) && Boolean(document.getElementById('extensionAllowedPluginNames')),
        hasDiscoveryFunctions: typeof window.loadDiscovery === 'function' && typeof window.refreshModelCatalog === 'function' && typeof window.rebuildSessionSearchIndex === 'function' && typeof window.updateModelCatalogSetting === 'function' && typeof window.toggleExtensionExecutablePlugins === 'function',
        hasRoutingSettings: Boolean(document.getElementById('smallHelperModel')) && Boolean(document.getElementById('strongHelperModel')),
        hasMediaToolSettings: Boolean(document.getElementById('visionModel')) && Boolean(document.getElementById('audioTranscribeCommand')),
        hasSettingsDoctor: Boolean(document.getElementById('settingsAudioSamplePath')) && Boolean(document.getElementById('settingsDoctorHealth')),
        hasOutputValidationSettings: Boolean(document.getElementById('outputValidationProfile')) && Boolean(document.getElementById('outputValidationToggle')) && Boolean(document.getElementById('outputValidationAutoSelectToggle')),
        hasOutputValidationProfileEditor: Boolean(document.getElementById('outputValidationProfilesJson')) && Boolean(document.getElementById('saveOutputValidationProfilesBtn')) && Boolean(document.getElementById('customProfileId')) && Boolean(document.getElementById('customProfileChecks')),
        outputValidationProfiles: Array.from(document.querySelectorAll('#outputValidationProfile option')).map((option) => option.value),
        settingsDoctorVisible: Boolean(document.getElementById('settingsDoctorHealth')) && !document.getElementById('settingsDoctorHealth').classList.contains('initial-hidden'),
        firstRunHealthVisible: Boolean(document.getElementById('firstRunHealth')) && !document.getElementById('firstRunHealth').classList.contains('initial-hidden'),
        hasContextDetails: Boolean(document.getElementById('contextDetails')),
        hasTraceEvalExamples: Boolean(document.getElementById('traceEvalExamples')),
        hasWeatherReplayEvalButton: Boolean(document.getElementById('createWeatherReplayEvalBtn')),
        hasBeginnerGuide: Boolean(document.getElementById('beginnerGuide')),
        hasMissionControl: Boolean(document.getElementById('missionControlPanel')),
        missionControlRendered: (() => {
          const panel = document.getElementById('missionControlPanel');
          return Boolean(panel && (panel.textContent || '').includes('Tell Harness the job'));
        })(),
        readinessDetailsSmoke: (() => {
          const panel = document.getElementById('readinessDetailsPanel');
          return { ok: Boolean(panel) && !panel.open && (panel.querySelector('summary')?.textContent || '').includes('Readiness details'), closed: panel ? !panel.open : false };
        })(),
        advancedDiagnosticsSmoke: (() => {
          const panel = document.getElementById('advancedDiagnosticsPanel');
          const summary = panel?.querySelector('summary')?.textContent || '';
          return { ok: Boolean(panel) && !panel.open && summary.includes('Advanced diagnostics') && summary.includes('Context, safety, and capability details'), closed: panel ? !panel.open : false, summary };
        })(),
        workToolsSmoke: (() => {
          const panel = document.getElementById('workToolsPanel');
          return { ok: Boolean(panel) && !panel.open && (panel.querySelector('summary')?.textContent || '').includes('Work tools'), closed: panel ? !panel.open : false };
        })(),
        taskFirstSmoke: (() => {
          const panel = document.getElementById('taskFirstPanel');
          const taskInput = document.getElementById('missionTaskInput');
          const chatInput = document.getElementById('chatInput');
          if (!panel || !taskInput || !chatInput || typeof window.sendTaskFirstPrompt !== 'function') return { ok: false, reason: 'missing panel/input/function' };
          taskInput.value = 'Review the current changes and show risks.';
          window.sendTaskFirstPrompt();
          const filled = chatInput.value === 'Review the current changes and show risks.';
          const hasContext = /Harness|AI|Current workspace|No model selected|ready|warning|blocker/i.test(panel.textContent || '');
          return { ok: filled && hasContext && (panel.textContent || '').includes('Tell Harness the job'), filled, hasContext, text: (panel.textContent || '').slice(0, 160) };
        })(),
        codingLoopSmoke: (() => {
          const rail = document.getElementById('codingLoopRail');
          const taskInput = document.getElementById('missionTaskInput');
          const chatInput = document.getElementById('chatInput');
          if (!rail || !taskInput || !chatInput || typeof window.startCodingLoopPrompt !== 'function') return { ok: false, reason: 'missing rail/input/function' };
          taskInput.value = 'Fix the smallest failing validation.';
          window.startCodingLoopPrompt();
          const railText = rail.textContent || '';
          return { ok: railText.includes('Task') && railText.includes('Validate') && chatInput.value.includes('show the diff, evidence') && chatInput.value.includes('Fix the smallest failing validation.'), railText, prompt: chatInput.value };
        })(),
        capabilityStarterSmoke,
        slashPaletteSmoke,
        dynamicSkillSlashCommandSmoke,
        myceliumContextCardsSmoke,
        inboxStripSmoke,
        topbarPetSmoke,
        panelToggleSmoke,
        automationJobSafetyVisible,
        planCompleteNotBlocked: !(document.getElementById('missionControlPanel')?.querySelector('.mission-card.blocked')?.textContent?.includes('pending task')),
        hasAutonomyBuilder: Boolean(document.getElementById('autonomyBuilderPanel')),
        hasAutonomyMaxTurnsInput: Boolean(document.getElementById('autonomyMaxTurns')),
        hasDocumentStudio: Boolean(document.getElementById('documentStudioPanel')) && Boolean(document.getElementById('documentTitle')) && Boolean(document.getElementById('documentList')),
        hasDocumentTemplateOptions: ['adr', 'release-notes', 'handoff'].every((value) => Boolean(document.querySelector(`#documentTemplate option[value="${value}"]`))),
        hasDocumentFormatOptions: ['markdown', 'html', 'pdf', 'docx'].every((value) => Boolean(document.querySelector(`#documentFormat option[value="${value}"]`))),
        hasReadinessFunctions: typeof window.loadReadiness === 'function' && typeof window.renderReadiness === 'function' && typeof window.loadAutonomyPlanPreview === 'function',
        hasDocumentFunctions: typeof window.generateDocument === 'function' && typeof window.loadDocuments === 'function' && typeof window.fillDocumentFromEvidence === 'function',
        hasEvidenceRenderer: typeof window.attachEvidenceCard === 'function',
        evidenceOutcomeSmoke: (() => {
          if (typeof window.attachEvidenceCard !== 'function') return { ok: false, reason: 'renderer missing' };
          const host = document.createElement('div');
          host.className = 'msg assistant';
          host.innerHTML = '<div class="msg-body"><div class="msg-content">ok</div></div>';
          document.body.appendChild(host);
          window.attachEvidenceCard(host, {
            id: 'smoke-evidence',
            kind: 'chat',
            mode: 'build',
            createdAt: new Date().toISOString(),
            request: 'smoke',
            model: 'smoke-model',
            permissionMode: 'default',
            toolSuccessRate: 1,
            tools: [{ name: 'file_edit', success: true }],
            files: [{ action: 'edit', path: 'ui/app.js' }, { action: 'write', requestedPath: 'agent-outputs/final-acceptance-probe.txt', path: 'C:\\AI\\AgentFiles\\final-acceptance-probe.txt', redirected: true, redirectKind: 'agent-outputs' }],
            commands: [{ command: 'npm run typecheck', success: true }],
            validation: { profile: 'coding-answer', status: 'pass', score: 1, findings: [], missingSections: [] },
            artifacts: [{ title: 'diff', kind: 'summary' }],
          });
          const strip = host.querySelector('[data-outcome-strip="1"]');
          const text = strip?.textContent || '';
          const card = host.querySelector('.evidence-card');
          const summary = card?.querySelector('summary')?.textContent || '';
          const nextButton = card?.querySelector('[data-evidence-next="1"]');
          nextButton?.click();
          const draftedPrompt = document.getElementById('chatInput')?.value || '';
          host.remove();
          const filesText = card?.querySelector('.evidence-lists')?.textContent || '';
          return { ok: Boolean(strip) && Boolean(card?.open) && summary.includes('What happened: Ready to inspect') && text.includes('Files changed2') && text.includes('Commands run1') && text.includes('ResultPassed') && text.includes('RiskLow') && text.includes('Artifacts1') && text.includes('Ready to inspect') && filesText.includes('agent-outputs/final-acceptance-probe.txt -> C:\\AI\\AgentFiles\\final-acceptance-probe.txt') && Boolean(nextButton) && draftedPrompt.includes('Show me the diff'), text, summary, filesText, open: Boolean(card?.open), draftedPrompt };
        })(),
        readOnlyEvidenceSmoke: (() => {
          if (typeof window.renderOutcomeStrip !== 'function') return { ok: false, reason: 'renderer missing' };
          const html = window.renderOutcomeStrip({
            id: 'smoke-read-only-evidence',
            kind: 'chat',
            mode: 'review',
            createdAt: new Date().toISOString(),
            request: 'smoke read-only',
            tools: [{ name: 'bash', success: true }],
            files: [],
            commands: [{ command: 'git status', success: true }],
            artifacts: [],
          });
          return { ok: html.includes('Result</strong><span>Not run (read-only)') && html.includes('Risk</strong><span>Low') && html.includes('Next</strong><span>Review output'), html };
        })(),
        stoppedEvidenceSmoke: (() => {
          if (typeof window.buildClientStoppedEvidence !== 'function') return { ok: false, reason: 'builder missing' };
          const evidence = window.buildClientStoppedEvidence('smoke stopped run', 'smoke-model', [{ name: 'bash', success: false, inputSummary: '{}', outputSummary: 'failed' }], [{ command: 'git log', success: false, outputSummary: 'failed' }], 'user_stopped');
          const html = window.renderOutcomeStrip(evidence);
          return { ok: evidence.validation?.status === 'fail' && html.includes('Needs review') && html.includes('1 failed'), stopReason: evidence.recovery?.stopReason, html };
        })(),
        hasRunEvidenceRenderer: typeof window.renderRunEvidenceLog === 'function',
        hasWalkthroughChecklist: Boolean(document.getElementById('walkthroughChecklist')),
        hasWalkthroughFunction: typeof window.openWalkthroughTarget === 'function',
        hasFirstRunSetup: Boolean(document.getElementById('firstRunSetup')),
        // Quick-start chips are populated by quickStartChipsMarkup() at
        // DOMContentLoaded. Guard against the helper regressing to empty.
        quickStartChips: (() => {
          const host = document.getElementById('quickSuggestions');
          const cards = host ? Array.from(host.querySelectorAll('.quick-card')) : [];
          const titles = cards.map((card) => card.querySelector('.qc-title')?.textContent?.trim() || '');
          return { count: cards.length, titles, populated: host?.dataset?.populated === '1' };
        })(),
        hasFirstRunInputs: Boolean(document.getElementById('firstRunOllamaHost')) && Boolean(document.getElementById('firstRunVisionModel')) && Boolean(document.getElementById('firstRunAudioCommand')) && Boolean(document.getElementById('firstRunAudioSamplePath')),
        hasFirstRunHealth: Boolean(document.getElementById('firstRunHealth')),
        hasAttachmentHint: Boolean(document.getElementById('attachmentHint')),
        hasMemoryPalace: Boolean(document.getElementById('memoryPalaceView')),
        hasPalaceDetail: Boolean(document.getElementById('palaceDetail')),
        palaceTabVisible: palaceWasVisible,
        discoveryTabVisible: discoveryWasVisible,
        skillsTabVisible: skillsWasVisible,
        learningTabVisible: learningWasVisible,
        myceliumTabVisible: myceliumWasVisible,
        hasMyceliumView: Boolean(document.getElementById('myceliumView')),
        hasMyceliumNetworkPanel: document.getElementById('myceliumView')?.textContent.includes('Mycelium Network'),
        hasMyceliumRouteInspection: document.getElementById('myceliumView')?.textContent.includes('Last route') && document.getElementById('myceliumView')?.textContent.includes('Blocked routes'),
        hasMyceliumGraphSections: document.getElementById('myceliumView')?.textContent.includes('Nodes') && document.getElementById('myceliumView')?.textContent.includes('Edges') && document.getElementById('myceliumView')?.textContent.includes('Episodes'),
        hasMyceliumFunctions: typeof window.loadMycelium === 'function' && typeof window.resetMyceliumGraph === 'function',
        traceInspectButtons: document.querySelectorAll('#traceExports button').length,
        palaceAnchorButtons: document.querySelectorAll('.palace-anchor').length,
        hasLearningCandidateQueue: Boolean(document.getElementById('learningCandidateQueue')),
        hasCandidateProvenanceDetail: Boolean(document.getElementById('candidateProvenanceDetail')),
        hasEvalDatasetManager: Boolean(document.getElementById('evalDatasetManager')),
        hasEvalRunTrend: Boolean(document.getElementById('evalRunTrend')),
        hasOutputValidationTrend: Boolean(document.getElementById('outputValidationTrend')),
        hasOutputValidationSourceTrend: Boolean(document.getElementById('outputValidationSourceTrend')),
        hasOutputValidationTrendExport: Boolean(document.getElementById('downloadOutputValidationTrendBtn')),
        hasProfilePresetImportExport: Boolean(document.getElementById('downloadProfilePresetBtn')) && Boolean(document.getElementById('importProfilePresetBtn')) && Boolean(document.getElementById('profilePresetFileInput')),
        hasProfilePresetFunctions: typeof window.downloadOutputValidationProfilesPreset === 'function' && typeof window.importOutputValidationProfilesPreset === 'function' && typeof window.handleOutputValidationProfilesPresetFile === 'function',
        hasValidationTemplates: Boolean(document.getElementById('outputValidationTemplates')) && document.querySelectorAll('#outputValidationTemplates button').length > 0,
        hasValidationTemplateExamples: document.querySelectorAll('#outputValidationTemplates .template-example').length > 0,
        hasValidationTemplateFunction: typeof window.installOutputValidationTemplate === 'function' && typeof window.loadOutputValidationTemplates === 'function',
        hasValidationPreview: Boolean(document.getElementById('outputValidationPreviewText')) && Boolean(document.getElementById('previewOutputValidationBtn')) && Boolean(document.getElementById('outputValidationPreviewResult')),
        hasValidationPreviewFunction: typeof window.previewOutputValidation === 'function' && typeof window.renderValidationPreviewResult === 'function',
        validationPreviewRendered: document.getElementById('outputValidationPreviewResult')?.textContent.includes('factual-answer'),
        validationFixSuggestionsRendered: document.getElementById('outputValidationPreviewResult')?.textContent.includes('Try:'),
        hasWalkthroughPersistenceFunction: typeof window.markWalkthroughStep === 'function' && typeof window.refreshWalkthroughChecklist === 'function',
        hasCompletedWalkthroughStep: document.querySelectorAll('#walkthroughChecklist .walkthrough-step.done').length > 0,
        hasAboutPanel: Boolean(document.getElementById('aboutPanel')),
        hasAboutManifestLink: document.getElementById('aboutPanel')?.textContent.includes('Manifest'),
        hasAboutFunction: typeof window.loadAbout === 'function',
        hasReleaseVerification: Boolean(document.getElementById('verifyReleaseBtn')) && Boolean(document.getElementById('releaseVerificationPanel')),
        hasReleaseVerificationFunction: typeof window.verifyReleaseAsset === 'function',
        hasFallbackRoutingSetting: Boolean(document.getElementById('fallbackHelperModel')),
        hasCommunicationConnectorSettings: Boolean(document.getElementById('discordStatus')) && Boolean(document.getElementById('slackStatus')) && Boolean(document.getElementById('whatsappStatus')),
        hasCommunicationConnectorFunctions: typeof window.loadConnectorStatuses === 'function' && typeof window.saveSlackWebhook === 'function' && typeof window.saveWhatsAppSetup === 'function',
        connectorPasswordInputsEmpty: ['discordTokenInput', 'slackWebhookInput', 'whatsappAccessTokenInput'].every((id) => document.getElementById(id)?.value === ''),
        hasDesktopInputEvidence: Boolean(document.getElementById('desktopInputEvidence')) && typeof window.loadDesktopInputEvidence === 'function',
        releaseVerificationRendered: !document.getElementById('releaseVerificationPanel').classList.contains('initial-hidden'),
        guidedProfileSaved: Boolean(window.__guidedProfileSavedSmoke),
        hasRunEvalDatasetButton: Boolean(document.getElementById('runEvalDatasetBtn')),
        hasRunLiveReplayDatasetButton: Boolean(document.getElementById('runLiveReplayDatasetBtn')),
        hasApplyCalibrationButton: Boolean(document.getElementById('applyCalibrationBtn')),
        hasRoutingMetricsFunction: typeof window.renderRoutingMetrics === 'function',
        hasCandidateQueueFunction: typeof window.reviewLearningCandidate === 'function',
        hasEvalDatasetFunction: typeof window.downloadEvalDataset === 'function',
        hasCandidateProvenanceFunction: typeof window.inspectLearningCandidate === 'function',
        hasRunEvalDatasetFunction: typeof window.runEvalDataset === 'function',
        hasReplaySourceLinkFunction: typeof window.renderReplaySourceLinks === 'function',
        hasReplayFailureFunction: typeof window.renderLatestRunFailures === 'function',
        hasMediaToolSettingFunction: typeof window.updateMediaToolSetting === 'function',
        hasSkillRefreshFunction: typeof window.refreshSkillSurfacesAfterToolResult === 'function',
        hasFirstRunSetupFunction: typeof window.applyFirstRunSetup === 'function',
        hasFirstRunHealthFunction: typeof window.checkFirstRunHealth === 'function',
        hasOutputValidationSettingFunction: typeof window.updateOutputValidationSetting === 'function' && typeof window.toggleOutputValidation === 'function' && typeof window.toggleOutputValidationAutoSelect === 'function' && typeof window.saveOutputValidationProfiles === 'function' && typeof window.validateOutputValidationProfilesEditor === 'function' && typeof window.saveProfileFromForm === 'function',
        hasOutputValidationFormatter: typeof window.formatOutputValidation === 'function',
        hasOutputValidationGroupedRenderer: typeof window.appendOutputValidationItem === 'function',
        hasOutputValidationProfileRenderer: typeof window.appendOutputValidationProfileItem === 'function',
        hasApplyCalibrationFunction: typeof window.applyRoutingCalibration === 'function',
        duplicateIds,
        mobileBeginnerSmoke,
        freshStartupSmoke,
        historyRestoreSmoke,
      };
    }, { palaceWasVisible: palaceTabVisible, discoveryWasVisible: discoveryTabVisible, skillsWasVisible: skillsTabVisible, learningWasVisible: learningWasVisible, myceliumWasVisible: myceliumTabVisible, operateModeSmoke, operatingServiceExportImportRoundTrip, operatingServiceDetailRendered, importedOperatingServiceDetailRendered, capabilityStarterSmoke, slashPaletteSmoke, dynamicSkillSlashCommandSmoke, myceliumContextCardsSmoke, inboxStripSmoke, topbarPetSmoke, panelToggleSmoke, automationJobSafetyVisible, recoveryLayoutSmoke, recoveryScreenshotPath, unattendedRunwayClickSmoke, mcpDiscoverClickSmoke, mobileBeginnerSmoke, freshStartupSmoke, historyRestoreSmoke });
    result.autonomyStartPayloadSmoke = autonomyStartPayloadSmoke;

    const failures = [];
    if (!result.title.endsWith('Ollama Agent Harness')) failures.push(`Unexpected title: ${result.title}`);
    if (!result.hasAppScript) failures.push('ui/app.js script was not loaded');
    if (!result.hasChatHistoryApi) failures.push('chat history helper API was not available at runtime');
    if (!result.hasPermissionPanel) failures.push('permission panel was not created');
    if (!result.hasPermissionRecoveryActionRow) failures.push('permission recovery action row did not render');
    if (!result.hasPermissionRecoveryLayout) failures.push('permission recovery action row layout/screenshot check failed');
    if (!result.hasUnattendedRunwayClick) failures.push(`Keep going recovery click did not issue the expected timed runway calls: ${JSON.stringify(result.unattendedRunwayClickSmoke)}`);
    if (!result.hasCapabilityAlignmentPanel) failures.push('capability alignment panel was not rendered');
    if (!result.hasChatInput) failures.push('chat input was not found');
    if (!result.hasTraceExports) failures.push('trace export panel was not found');
    if (!result.hasTraceInspector) failures.push('trace inspector panel was not found');
    if (!result.hasRuntimeStorage) failures.push('runtime storage panel was not found');
    if (!result.hasMcpDiscoveryControls) failures.push('MCP discovery controls were not rendered');
    if (!result.mcpDiscoverClickSmoke) failures.push('MCP discovery click path did not call the discover endpoint');
    if (!result.hasSkillList) failures.push('skill list was not rendered');
    if (!result.hasSkillDiagnostics) failures.push('skill diagnostics panel was not rendered');
    if (!result.hasSkillAutomationPanel) failures.push('skill automation panel was not rendered');
    if (!result.hasOpenSkillsFunction) failures.push('open skills chat action functions were not found');
    if (!result.hasDiscoveryView) failures.push('discovery view was not found');
    if (!result.hasDiscoveryPanel) failures.push('discovery panel was not rendered');
    if (!result.hasModelCatalogPanel) failures.push('model catalog discovery panel was not rendered');
    if (!result.hasModelRecommendations) failures.push('model recommendation guide was not rendered');
    if (!result.hasExtensionDiscoveryPanel) failures.push('extension discovery panel was not rendered');
    if (!result.hasOperatingServicesDiscoveryPanel) failures.push('operating services discovery panel was not rendered');
    if (!result.hasOperatingServiceDetailFunction) failures.push('operating service detail function was not loaded');
    if (!result.operatingServiceDetailRendered) failures.push('operating service detail did not render');
    if (result.operateModeSmokeStatus !== 200 || result.operateModeSmokeSecondStatus !== 200 || result.operateModeSmokeSelectedModelStatus !== 200 || !result.operateModeSmokeHandled) failures.push('operate mode chat smoke did not create visible operating services');
    if (result.operatingServiceButtonCount < 2) failures.push('operating services discovery panel did not render multiple service detail controls');
    if (!result.missingOperatingServiceDetailHandled) failures.push('missing operating service detail did not render an unavailable message');
    if (!result.hasOperatingServiceExportImport) failures.push('operating service export/import controls were not rendered');
    if (!result.operatingServiceExportImportRoundTrip || result.operatingServiceExportImportRoundTrip.exportedServiceCount < 1 || !/Imported \d+ service\(s\); skipped \d+\./.test(result.operatingServiceExportImportRoundTrip.importDialogMessage)) failures.push('operating service export/import browser round trip failed');
    if (!operatingServiceEvidenceVisible) failures.push('operating service export/import evidence was not visible in Runs UI');
    if (!result.hasAutomationDiscoveryPanel) failures.push('automation discovery panel was not rendered');
    if (!result.hasSessionSearchDiscoveryPanel) failures.push('session search discovery panel was not rendered');
    if (!result.hasCuratorDiscoveryPanel) failures.push('curator discovery panel was not rendered');
    if (!result.hasCuratorSettingsSection) failures.push('curator settings section was not rendered');
    if (!result.hasKillSwitchShortcut) failures.push('kill switch keyboard shortcut helpers were not loaded');
    if (!result.hasModelCatalogSettings) failures.push('model catalog settings were not found');
    if (!result.hasExtensionPolicySettings) failures.push('extension activation policy settings were not found');
    if (!result.hasDiscoveryFunctions) failures.push('discovery functions were not found');
    if (!result.hasRoutingSettings) failures.push('helper routing settings were not found');
    if (!result.hasMediaToolSettings) failures.push('media tool settings were not found');
    if (!result.hasSettingsDoctor) failures.push('settings setup doctor controls were not found');
    if (!result.hasOutputValidationSettings) failures.push('output validation settings were not found');
    if (!result.hasOutputValidationProfileEditor) failures.push('output validation profile editor was not found');
    for (const profile of ['oracle-prime', 'factual-answer', 'coding-answer', 'tool-result-summary']) {
      if (!result.outputValidationProfiles.includes(profile)) failures.push(`output validation profile option was not found: ${profile}`);
    }
    if (!result.settingsDoctorVisible) failures.push('settings setup doctor did not render results');
    if (!result.firstRunHealthVisible) failures.push('first-run setup doctor did not render results');
    if (!result.hasContextDetails) failures.push('context details were not found');
    if (!result.hasTraceEvalExamples) failures.push('trace eval example panel was not found');
    if (!result.hasWeatherReplayEvalButton) failures.push('weather replay eval button was not found');
    if (!result.hasBeginnerGuide) failures.push('beginner guide was not found');
    if (!result.hasMissionControl) failures.push('start-work panel was not found');
    if (!result.missionControlRendered) failures.push('start-work readiness did not render');
    if (!result.readinessDetailsSmoke?.ok) failures.push(`readiness details hierarchy smoke failed: ${JSON.stringify(result.readinessDetailsSmoke)}`);
    if (!result.advancedDiagnosticsSmoke?.ok) failures.push(`advanced diagnostics wrapper smoke failed: ${JSON.stringify(result.advancedDiagnosticsSmoke)}`);
    if (!result.workToolsSmoke?.ok) failures.push(`work tools hierarchy smoke failed: ${JSON.stringify(result.workToolsSmoke)}`);
    if (!result.taskFirstSmoke?.ok) failures.push(`task-first work panel smoke failed: ${JSON.stringify(result.taskFirstSmoke)}`);
    if (!result.codingLoopSmoke?.ok) failures.push(`coding loop smoke failed: ${JSON.stringify(result.codingLoopSmoke)}`);
    if (!result.capabilityStarterSmoke?.ok) failures.push(`capability template starter panel smoke failed: ${result.capabilityStarterSmoke?.reason || result.capabilityStarterSmoke?.statusText || 'unknown'}`);
    if (!result.slashPaletteSmoke?.ok) failures.push(`slash command palette did not open for bare slash: ${result.slashPaletteSmoke?.reason || 'no visible commands'}`);
    if (!result.dynamicSkillSlashCommandSmoke?.ok) failures.push(`dynamic skill slash command did not submit expected skill request: ${JSON.stringify(result.dynamicSkillSlashCommandSmoke)}`);
    if (!result.myceliumContextCardsSmoke?.ok) failures.push(`mycelium context cards did not render expected nodes: ${JSON.stringify(result.myceliumContextCardsSmoke)}`);
    if (!result.inboxStripSmoke?.ok) failures.push(`inbox strip did not render aggregated items: ${JSON.stringify(result.inboxStripSmoke)}`);
    if (!result.topbarPetSmoke?.ok) failures.push(`topbar pet did not transition through expected states: ${JSON.stringify(result.topbarPetSmoke)}`);
    if (!result.panelToggleSmoke?.ok) failures.push(`panel toggle smoke failed — panels did not open/close correctly: ${JSON.stringify(result.panelToggleSmoke)}`);
    if (!result.automationJobSafetyVisible) failures.push('automation job safety panel was not rendered');
    if (!result.planCompleteNotBlocked) failures.push('plan-complete state incorrectly shows blocked card for pending tasks');
    if (!result.hasAutonomyBuilder) failures.push('autonomy builder panel was not found');
    if (!result.autonomyStartPayloadSmoke?.ok) failures.push(`autonomy start payload did not preserve 150 turns: ${JSON.stringify(result.autonomyStartPayloadSmoke)}`);
    if (!result.hasDocumentStudio) failures.push('document studio panel was not found');
    if (!result.hasDocumentTemplateOptions) failures.push('expanded document template options were not found');
    if (!result.hasDocumentFormatOptions) failures.push('expanded document format options were not found');
    if (!result.hasReadinessFunctions) failures.push('readiness/autonomy functions were not found');
    if (!result.hasDocumentFunctions) failures.push('document generation functions were not found');
    if (!result.hasEvidenceRenderer) failures.push('evidence renderer function was not found');
    if (!result.evidenceOutcomeSmoke?.ok) failures.push(`evidence outcome summary smoke failed: ${JSON.stringify(result.evidenceOutcomeSmoke)}`);
    if (!result.readOnlyEvidenceSmoke?.ok) failures.push(`read-only evidence summary smoke failed: ${JSON.stringify(result.readOnlyEvidenceSmoke)}`);
    if (!result.stoppedEvidenceSmoke?.ok) failures.push(`stopped evidence smoke failed: ${JSON.stringify(result.stoppedEvidenceSmoke)}`);
    if (!result.hasRunEvidenceRenderer) failures.push('run evidence renderer function was not found');
    if (!result.hasWalkthroughChecklist) failures.push('walkthrough checklist was not found');
    if (!result.hasWalkthroughFunction) failures.push('walkthrough action function was not found');
    if (!result.hasFirstRunSetup) failures.push('first-run setup panel was not found');
    if (!result.quickStartChips?.populated || (result.quickStartChips?.count ?? 0) < 4) {
      failures.push(`quick-start chips did not populate from quickStartChipsMarkup(): ${JSON.stringify(result.quickStartChips)}`);
    }
    if (!result.hasFirstRunInputs) failures.push('first-run setup inputs were not found');
    if (!result.hasFirstRunHealth) failures.push('first-run health panel was not found');
    if (!result.hasAttachmentHint) failures.push('attachment hint was not found');
    if (!result.hasMemoryPalace) failures.push('memory palace view was not found');
    if (result.palaceAnchorButtons > 0 && !result.hasPalaceDetail) failures.push('palace detail panel was not found');
    if (!result.palaceTabVisible) failures.push('palace tab did not become visible');
    if (!result.discoveryTabVisible) failures.push('discovery tab did not become visible');
    if (!result.skillsTabVisible) failures.push('skills tab did not become visible');
    if (!result.learningTabVisible) failures.push('learning tab did not become visible');
    if (!result.myceliumTabVisible) failures.push('mycelium tab did not become visible');
    if (!result.hasMyceliumView) failures.push('mycelium view was not found');
    if (!result.hasMyceliumNetworkPanel) failures.push('mycelium network panel did not render');
    if (!result.hasMyceliumRouteInspection) failures.push('mycelium route inspection panels were not rendered');
    if (!result.hasMyceliumGraphSections) failures.push('mycelium graph sections were not rendered');
    if (!result.hasMyceliumFunctions) failures.push('mycelium functions were not found');
    if (!result.hasLearningCandidateQueue) failures.push('learning candidate queue was not rendered');
    if (!result.hasCandidateProvenanceDetail) failures.push('candidate provenance detail panel was not rendered');
    if (!result.hasEvalDatasetManager) failures.push('eval dataset manager was not rendered');
    if (!result.hasEvalRunTrend) failures.push('eval run trend panel was not rendered');
    if (!result.hasOutputValidationTrend) failures.push('output validation trend panel was not rendered');
    if (!result.hasOutputValidationSourceTrend) failures.push('output validation source trend panel was not rendered');
    if (!result.hasOutputValidationTrendExport) failures.push('output validation trend export button was not rendered');
    if (!result.hasProfilePresetImportExport) failures.push('profile preset import/export controls were not rendered');
    if (!result.hasProfilePresetFunctions) failures.push('profile preset import/export functions were not found');
    if (!result.hasValidationTemplates) failures.push('validation template controls were not rendered');
    if (!result.hasValidationTemplateExamples) failures.push('validation template examples were not rendered');
    if (!result.hasValidationTemplateFunction) failures.push('validation template functions were not found');
    if (!result.hasValidationPreview) failures.push('validation preview controls were not rendered');
    if (!result.hasValidationPreviewFunction) failures.push('validation preview functions were not found');
    if (!result.validationPreviewRendered) failures.push('validation preview did not render a result');
    if (!result.validationFixSuggestionsRendered) failures.push('validation fix suggestions did not render');
    if (!result.hasWalkthroughPersistenceFunction) failures.push('walkthrough persistence functions were not found');
    if (!result.hasCompletedWalkthroughStep) failures.push('walkthrough completed state was not rendered');
    if (!result.hasAboutPanel) failures.push('about panel was not rendered');
    if (!result.hasAboutManifestLink) failures.push('about panel manifest link was not rendered');
    if (!result.hasAboutFunction) failures.push('about panel function was not found');
    if (!result.hasReleaseVerification) failures.push('release verification controls were not rendered');
    if (!result.hasReleaseVerificationFunction) failures.push('release verification function was not found');
    if (!result.hasFallbackRoutingSetting) failures.push('fallback routing setting was not rendered');
    if (!result.hasCommunicationConnectorSettings) failures.push('communication connector settings were not rendered');
    if (!result.hasCommunicationConnectorFunctions) failures.push('communication connector functions were not found');
    if (!result.connectorPasswordInputsEmpty) failures.push('communication connector password inputs were populated from settings');
    if (!result.hasDesktopInputEvidence) failures.push('desktop input evidence UI was not rendered');
    if (!result.releaseVerificationRendered) failures.push('release verification did not render a result');
    if (!result.guidedProfileSaved) failures.push('guided profile form did not save a profile');
    if (!result.hasRunEvalDatasetButton) failures.push('run eval dataset button was not rendered');
    if (!result.hasRunLiveReplayDatasetButton) failures.push('run live replay dataset button was not rendered');
    if (!result.hasApplyCalibrationButton) failures.push('apply calibration button was not rendered');
    if (!result.hasRoutingMetricsFunction) failures.push('routing metrics function was not found');
    if (!result.hasCandidateQueueFunction) failures.push('candidate review function was not found');
    if (!result.hasEvalDatasetFunction) failures.push('eval dataset function was not found');
    if (!result.hasCandidateProvenanceFunction) failures.push('candidate provenance function was not found');
    if (!result.hasRunEvalDatasetFunction) failures.push('eval runner function was not found');
    if (!result.hasReplaySourceLinkFunction) failures.push('replay source link function was not found');
    if (!result.hasReplayFailureFunction) failures.push('replay failure function was not found');
    if (!result.hasMediaToolSettingFunction) failures.push('media tool setting function was not found');
    if (!result.hasSkillRefreshFunction) failures.push('skill refresh function was not found');
    if (!result.hasFirstRunSetupFunction) failures.push('first-run setup function was not found');
    if (!result.hasFirstRunHealthFunction) failures.push('first-run health function was not found');
    if (!result.hasOutputValidationSettingFunction) failures.push('output validation setting function was not found');
    if (!result.hasOutputValidationFormatter) failures.push('output validation formatter was not found');
    if (!result.hasOutputValidationGroupedRenderer) failures.push('grouped output validation renderer was not found');
    if (!result.hasOutputValidationProfileRenderer) failures.push('output validation profile renderer was not found');
    if (!result.hasApplyCalibrationFunction) failures.push('apply calibration function was not found');
    if (!result.mobileBeginnerSmoke?.ok) failures.push(`mobile beginner smoke failed: ${JSON.stringify(result.mobileBeginnerSmoke)}`);
    if (!result.freshStartupSmoke?.ok) failures.push(`fresh startup smoke failed: ${JSON.stringify(result.freshStartupSmoke)}`);
    if (!result.historyRestoreSmoke?.ok) failures.push(`history restore smoke failed: ${JSON.stringify(result.historyRestoreSmoke)}`);
    if (result.duplicateIds.length > 0) failures.push(`duplicate ids found: ${result.duplicateIds.join(', ')}`);

    if (failures.length > 0) {
      console.error(failures.join('\n'));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({ ok: true, url: targetUrl, ...result }, null, 2));
  } finally {
    await browser.close();
    await cleanupServer();
  }
}

async function runMobileBeginnerSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    // Suppress the first-visit onboarding modal so it does not overlay and
    // intercept clicks on the landing page during the layout-fit checks.
    await page.addInitScript(() => {
      try { localStorage.setItem('harness.onboardSeen', String(Date.now())); } catch (e) {}
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && typeof window.loadReadiness === 'function');
    await page.evaluate(() => { const details = document.getElementById('welcomeFirstRun'); if (details) details.open = true; });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    return await page.evaluate(() => {
      const quickStart = document.getElementById('quickStartBtn');
      const input = document.getElementById('chatInput');
      const firstRun = document.getElementById('firstRunSetup');
      const inputBox = input?.getBoundingClientRect();
      const firstRunBox = firstRun?.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const serializeBox = (box) => box ? ({ left: box.left, right: box.right, width: box.width }) : null;
      const boxes = {
        input: serializeBox(inputBox),
        firstRun: serializeBox(firstRunBox),
      };
      const fits = [inputBox, firstRunBox].every((box) => box && box.width <= viewportWidth && box.left >= -1 && box.right <= viewportWidth + 1);
      return {
        ok: Boolean(quickStart && input && firstRun && fits),
        viewportWidth,
        boxes,
        quickStartDisabled: Boolean(quickStart?.disabled),
        fits,
      };
    });
  } finally {
    await page.close();
  }
}

async function runDynamicSkillSlashCommandSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && Boolean(window.loadReadiness));
    return await page.evaluate(async () => {
    if (typeof loadSkills !== 'function' || typeof maybeShowSlashPalette !== 'function' || typeof applySelectedSlashCommand !== 'function') {
      return { ok: false, reason: 'slash command functions missing' };
    }
    const input = document.getElementById('chatInput');
    const modelSelect = document.getElementById('modelSelect');
    if (!input || !modelSelect) return { ok: false, reason: 'chat input or model select missing' };
    if (!modelSelect.value) {
      const option = document.createElement('option');
      option.value = 'ui-smoke-model';
      option.textContent = 'ui-smoke-model';
      modelSelect.appendChild(option);
      modelSelect.value = 'ui-smoke-model';
    }
    const originalFetch = window.fetch.bind(window);
    const originalSuggest = window.maybeSuggestOutputValidationProfile;
    let chatPayload = null;
    window.maybeSuggestOutputValidationProfile = async () => {};
    window.fetch = (resource, init = {}) => {
      const url = typeof resource === 'string' ? resource : resource?.url;
      if (url === '/api/chat') {
        chatPayload = init?.body ? JSON.parse(init.body) : null;
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"text","content":"skill ready"}\n\ndata: {"type":"done","reason":"completed"}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      }
      if (url === '/api/skills') {
        const skill = { name: 'zero-budget-growth-bible', description: 'Zero-budget growth system', domain: 'marketing', triggers: [], enabled: true };
        return Promise.resolve(new Response(JSON.stringify({
          skills: [skill],
          sources: [{ source: 'runtime', skills: [skill], diagnostics: [], mutable: true }, { source: 'repo', skills: [], diagnostics: [], mutable: false }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url === '/api/skills/usage') {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url === '/api/curator') {
        return Promise.resolve(new Response(JSON.stringify({ proposals: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(resource, init);
    };
    try {
      await loadSkills();
      input.value = '/ze';
      input.focus();
      autoSize(input);
      maybeShowSlashPalette(input.value);
      const paletteText = document.getElementById('slashPaletteList')?.textContent || '';
      applySelectedSlashCommand();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const hidden = document.getElementById('slashPalette')?.classList.contains('hidden');
      return {
        ok: Boolean(chatPayload)
          && chatPayload.message === 'Use the skill: zero-budget-growth-bible'
          && hidden
          && input.value === ''
          && paletteText.includes('/zero-budget-growth-bible'),
        chatPayload,
        hidden,
        inputValue: input.value,
        paletteText,
      };
    } finally {
      window.fetch = originalFetch;
      window.maybeSuggestOutputValidationProfile = originalSuggest;
    }
    });
  } finally {
    await page.close();
  }
}

async function runFreshStartupSmoke(browser, targetUrl) {
  const staleText = 'stale startup chat should not render';
  const page = await browser.newPage();
  try {
    await page.addInitScript((text) => {
      localStorage.setItem('harness.chatSession', JSON.stringify({
        version: 1,
        currentChatId: 'stale-chat-id',
        messages: [
          { role: 'user', content: text },
          { role: 'assistant', content: 'old assistant response' },
        ],
      }));
    }, staleText);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')));
    return await page.evaluate((text) => {
      const chatArea = document.getElementById('chatArea');
      const welcome = document.getElementById('welcome');
      const renderedText = chatArea?.textContent || '';
      const historyApiAvailable = typeof window.HarnessChatHistory?.loadPersistedChatSession === 'function';
      return {
        ok: Boolean(welcome && historyApiAvailable && !renderedText.includes(text)),
        hasWelcome: Boolean(welcome),
        renderedStaleText: renderedText.includes(text),
        historyApiAvailable,
      };
    }, staleText);
  } finally {
    await page.close();
  }
}

async function runHistoryRestoreSmoke(browser, targetUrl) {
  const id = 'ui-smoke-history-restore-' + Date.now().toString(36);
  const title = 'UI smoke history restore';
  const userText = 'history restore smoke user message';
  const assistantText = 'history restore smoke assistant reply';
  const page = await browser.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatInput')) && typeof window.loadHistory === 'function');
    return await page.evaluate(async ({ id, title, userText, assistantText }) => {
      try {
        await fetch('/api/history/' + id, { method: 'DELETE' });
        const saveResponse = await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            title,
            messages: [
              { role: 'user', content: userText },
              { role: 'assistant', content: assistantText },
            ],
          }),
        });
        if (!saveResponse.ok) return { ok: false, reason: 'history save failed', status: saveResponse.status };
        await loadHistory();
        const historyItem = Array.from(document.querySelectorAll('#historyList .history-item')).find((item) => item.textContent?.includes(title));
        if (!historyItem) return { ok: false, reason: 'history item missing' };
        await loadChat(id);
        await loadHistory();
        const renderedText = document.getElementById('chatArea')?.textContent || '';
        const activeItem = document.querySelector('#historyList .history-item.active');
        return {
          ok: renderedText.includes(userText) && renderedText.includes(assistantText) && Boolean(activeItem?.textContent?.includes(title)),
          renderedUserText: renderedText.includes(userText),
          renderedAssistantText: renderedText.includes(assistantText),
          activeHistoryItem: Boolean(activeItem?.textContent?.includes(title)),
        };
      } finally {
        await fetch('/api/history/' + id, { method: 'DELETE' });
      }
    }, { id, title, userText, assistantText });
  } finally {
    await page.close();
  }
}

async function ensureTargetServer() {
  if (await canReachTarget()) {
    if (freshLocalServer && !providedTargetUrl) {
      throw new Error(`Fresh UI smoke requested, but ${targetUrl} is already reachable. Stop the existing server or provide HARNESS_UI_URL for an explicit target.`);
    }
    return () => {};
  }
  if (providedTargetUrl) {
    throw new Error(`Unable to reach ${targetUrl}. Start the Harness web server first, or omit the URL to let smoke:ui start the default local server.`);
  }

  const url = new URL(targetUrl);
  const serverArgs = fs.existsSync('src/web/server.ts')
    ? ['-r', 'ts-node/register', 'src/web/server.ts']
    : ['dist/web/server.js'];
  const server = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PORT: url.port || '4300', NO_OPEN: '1', HARNESS_UI_SMOKE_CHAT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputChunks = [];
  const collectOutput = (chunk) => {
    outputChunks.push(chunk.toString());
    while (outputChunks.join('').length > 8000) outputChunks.shift();
  };
  const getOutput = () => outputChunks.join('');
  server.stdout.on('data', collectOutput);
  server.stderr.on('data', collectOutput);

  try {
    await waitForTarget(server, getOutput);
  } catch (error) {
    await stopStartedServer(server, getOutput);
    throw error;
  }
  return () => stopStartedServer(server, getOutput);
}

async function canReachTarget() {
  try {
    const response = await fetch(targetUrl, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTarget(server, getOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 90_000) {
    if (server.exitCode !== null) {
      throw new Error(`Unable to start Harness web server for UI smoke.\n${getOutput()}`);
    }
    if (await canReachTarget()) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for Harness web server at ${targetUrl}.\n${getOutput()}`);
}

async function stopStartedServer(server, getOutput) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill();
  const exited = await waitForExit(server, 5000);
  if (!exited) console.warn(`Timed out waiting for temporary Harness web server to exit.\n${getOutput()}`);
}

function waitForExit(server, timeoutMs) {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    server.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

/**
 * Cross-checks UI Settings panel API key entries against backend presets.
 *
 * Reads the REMOTE_API_KEY_FIELDS array (already in the fetched appScript)
 * and the OPENAI_COMPATIBLE_PRESETS table from src/core/chatClientFactory.ts
 * on disk. Returns the set of UI key NAMES that have no matching preset
 * apiKeyEnvVars entry — those are orphans like the v0.2.2 Anthropic row
 * (UI offered to save a key the harness had no client to invoke).
 *
 * Returns { orphans: string[], error?: string }. Errors are non-fatal
 * (treated as a verification failure, not a smoke crash).
 */
function checkApiKeyAlignment(appScript) {
  // Extract UI-side names from REMOTE_API_KEY_FIELDS array literal.
  const uiArrayMatch = appScript.match(/const\s+REMOTE_API_KEY_FIELDS\s*=\s*\[([\s\S]*?)\];/);
  if (!uiArrayMatch) {
    return { orphans: [], error: 'REMOTE_API_KEY_FIELDS array not found in ui/app.js' };
  }
  const uiNames = Array.from(uiArrayMatch[1].matchAll(/name:\s*['"]([A-Z0-9_]+)['"]/g)).map((m) => m[1]);
  if (uiNames.length === 0) {
    return { orphans: [], error: 'no name entries parsed from REMOTE_API_KEY_FIELDS' };
  }

  // Extract preset env var names from chatClientFactory.ts (local file).
  let factorySource;
  try {
    factorySource = fs.readFileSync('src/core/chatClientFactory.ts', 'utf-8');
  } catch (error) {
    return { orphans: [], error: `cannot read src/core/chatClientFactory.ts: ${error.message}` };
  }
  const presetEnvNames = new Set();
  for (const match of factorySource.matchAll(/apiKeyEnvVars:\s*\[([^\]]+)\]/g)) {
    for (const inner of match[1].matchAll(/['"]([A-Z0-9_]+)['"]/g)) {
      presetEnvNames.add(inner[1]);
    }
  }
  if (presetEnvNames.size === 0) {
    return { orphans: [], error: 'no apiKeyEnvVars parsed from chatClientFactory.ts' };
  }

  const orphans = uiNames.filter((name) => !presetEnvNames.has(name));
  return { orphans };
}


async function runStaticSmoke() {
  const pageResponse = await fetch(targetUrl);
  const html = await pageResponse.text();
  const appUrl = new URL('./app.js', targetUrl).toString();
  const appResponse = await fetch(appUrl);
  const appScript = await appResponse.text();
  const chatHistoryUrl = new URL('./chatHistory.js', targetUrl).toString();
  const chatHistoryResponse = await fetch(chatHistoryUrl);
  const chatHistoryScript = await chatHistoryResponse.text();
  const ids = Array.from(html.matchAll(/id="([^"]+)"/g)).map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const result = {
    ok: true,
    mode: 'static',
    url: targetUrl,
    title: /<title>Ollama Agent Harness<\/title>/.test(html) ? 'Ollama Agent Harness' : '',
    hasAppScript: html.includes('./app.js'),
    hasChatHistoryScript: html.includes('./chatHistory.js'),
    hasChatHistoryApi: chatHistoryScript.includes('HarnessChatHistory') && chatHistoryScript.includes('outboundChatHistory') && chatHistoryScript.includes('saveChatSession') && chatHistoryScript.includes('loadPersistedChatSession'),
    hasTraceExports: ids.includes('traceExports'),
    hasTraceInspector: ids.includes('traceInspector'),
    hasRuntimeStorage: ids.includes('runtimeStorageStatus'),
    hasRoutingSettings: ids.includes('smallHelperModel') && ids.includes('strongHelperModel'),
    hasMediaToolSettings: ids.includes('visionModel') && ids.includes('audioTranscribeCommand'),
    hasSettingsDoctor: ids.includes('settingsAudioSamplePath') && ids.includes('settingsDoctorHealth'),
    hasOutputValidationSettings: ids.includes('outputValidationProfile') && ids.includes('outputValidationToggle') && ids.includes('outputValidationAutoSelectToggle'),
    hasOutputValidationProfileEditor: ids.includes('outputValidationProfilesJson') && ids.includes('saveOutputValidationProfilesBtn') && ids.includes('customProfileId') && ids.includes('customProfileChecks'),
    outputValidationProfiles: Array.from(html.matchAll(/<option value="([^"]+)"/g)).map((match) => match[1]).filter((value) => ['oracle-prime', 'factual-answer', 'coding-answer', 'tool-result-summary'].includes(value)),
    hasContextDetails: ids.includes('contextDetails'),
    hasTraceEvalExamples: ids.includes('traceEvalExamples'),
    hasWeatherReplayEvalButton: ids.includes('createWeatherReplayEvalBtn'),
    hasBeginnerGuide: ids.includes('beginnerGuide'),
    hasCapabilityTemplatePanelSupport: appScript.includes('capabilityTemplatePanel') && appScript.includes('function loadCapabilityTemplates'),
    hasCapabilityTemplateStarterDetailFunction: appScript.includes('function loadCapabilityTemplateStarterDetail') && appScript.includes('/api/capability-templates/') && appScript.includes('/starter'),
    hasCapabilityTemplateStarterActionFunction: appScript.includes('function runCapabilityTemplateStarterAction') && appScript.includes('/actions') && appScript.includes('Preview ready'),
    hasWalkthroughChecklist: ids.includes('walkthroughChecklist'),
    hasFirstRunSetup: ids.includes('firstRunSetup'),
    hasFirstRunInputs: ids.includes('firstRunOllamaHost') && ids.includes('firstRunVisionModel') && ids.includes('firstRunAudioCommand') && ids.includes('firstRunAudioSamplePath'),
    hasFirstRunHealth: ids.includes('firstRunHealth'),
    hasAttachmentHint: ids.includes('attachmentHint'),
    hasMemoryPalace: ids.includes('memoryPalaceView'),
    hasMyceliumView: ids.includes('myceliumView'),
    hasMyceliumTab: html.includes("showLeftTab('mycelium'") && html.includes('Mycelium'),
    hasMyceliumFunctions: appScript.includes('function loadMycelium') && appScript.includes('function resetMyceliumGraph'),
    hasMyceliumRouteInspection: appScript.includes('Last route') && appScript.includes('Blocked routes') && appScript.includes('/api/mycelium/last-route'),
    hasMyceliumGraphSections: appScript.includes('Nodes') && appScript.includes('Edges') && appScript.includes('Episodes'),
    hasTraceInspectorFunction: appScript.includes('function inspectTraceExport'),
    hasTraceFilterFunction: appScript.includes('function renderTraceInspector'),
    hasPalaceEntryFunction: appScript.includes('function loadPalaceEntry'),
    hasRuntimeCleanupFunction: appScript.includes('function cleanupRuntimeStorage'),
    hasRoutingMetricsFunction: appScript.includes('function renderRoutingMetrics'),
    hasCandidateQueueFunction: appScript.includes('function reviewLearningCandidate'),
    hasEvalDatasetFunction: appScript.includes('function downloadEvalDataset'),
    hasCandidateProvenanceFunction: appScript.includes('function inspectLearningCandidate'),
    hasRunEvalDatasetFunction: appScript.includes('function runEvalDataset'),
    hasReplaySourceLinkFunction: appScript.includes('function renderReplaySourceLinks'),
    hasReplayFailureFunction: appScript.includes('function renderLatestRunFailures'),
    hasMediaToolSettingFunction: appScript.includes('function updateMediaToolSetting'),
    hasSettingsDoctorFunction: appScript.includes('function checkSettingsHealth'),
    hasFirstRunSetupFunction: appScript.includes('function applyFirstRunSetup'),
    hasFirstRunHealthFunction: appScript.includes('function checkFirstRunHealth'),
    hasOutputValidationSettingFunction: appScript.includes('function updateOutputValidationSetting') && appScript.includes('function toggleOutputValidation') && appScript.includes('function toggleOutputValidationAutoSelect') && appScript.includes('function saveOutputValidationProfiles') && appScript.includes('function validateOutputValidationProfilesEditor') && appScript.includes('function saveProfileFromForm'),
    hasOutputValidationFormatter: appScript.includes('function formatOutputValidation'),
    hasOutputValidationGroupedRenderer: appScript.includes('function appendOutputValidationItem'),
    hasOutputValidationProfileRenderer: appScript.includes('function appendOutputValidationProfileItem') && appScript.includes('output_validation_profile'),
    hasOutputValidationTrendFunction: appScript.includes('function renderOutputValidationTrends'),
    hasOutputValidationSourceTrend: appScript.includes('outputValidationSourceTrend') && appScript.includes('bySelectionSource'),
    hasOutputValidationTrendExportFunction: appScript.includes('function downloadOutputValidationTrend'),
    hasProfilePresetImportExport: ids.includes('downloadProfilePresetBtn') && ids.includes('importProfilePresetBtn') && ids.includes('profilePresetFileInput'),
    hasProfilePresetFunctions: appScript.includes('function downloadOutputValidationProfilesPreset') && appScript.includes('function importOutputValidationProfilesPreset') && appScript.includes('function handleOutputValidationProfilesPresetFile'),
    hasValidationTemplates: ids.includes('outputValidationTemplates'),
    hasValidationTemplateExamples: html.includes('template-example'),
    hasValidationTemplateFunction: appScript.includes('function installOutputValidationTemplate') && appScript.includes('function loadOutputValidationTemplates'),
    hasValidationPreview: ids.includes('outputValidationPreviewText') && ids.includes('previewOutputValidationBtn') && ids.includes('outputValidationPreviewResult'),
    hasValidationPreviewFunction: appScript.includes('function previewOutputValidation') && appScript.includes('function renderValidationPreviewResult') && appScript.includes('Try:'),
    hasWalkthroughPersistenceFunction: appScript.includes('function markWalkthroughStep') && appScript.includes('function refreshWalkthroughChecklist'),
    hasAboutPanel: ids.includes('aboutPanel'),
    hasAboutFunction: appScript.includes('function loadAbout') && appScript.includes('function renderAboutPanel'),
    hasAboutManifestLink: appScript.includes('manifestName') && appScript.includes('manifestUrl'),
    hasReleaseVerification: ids.includes('verifyReleaseBtn') && ids.includes('releaseVerificationPanel'),
    hasReleaseVerificationFunction: appScript.includes('function verifyReleaseAsset'),
    hasContextPresetControls: html.includes('applyContextPreset(8192)') && html.includes('applyContextPreset(32768)') && appScript.includes('function applyContextPreset'),
    hasFallbackRoutingSetting: ids.includes('fallbackHelperModel') && html.includes("updateRoutingSetting('fallbackModel'") && appScript.includes('currentModelRouting.fallbackModel'),
    hasCommunicationConnectorSettings: ids.includes('discordStatus') && ids.includes('slackStatus') && ids.includes('whatsappStatus'),
    hasCommunicationConnectorFunctions: appScript.includes('function loadConnectorStatuses') && appScript.includes('function saveSlackWebhook') && appScript.includes('function saveWhatsAppSetup'),
    hasDesktopInputEvidence: ids.includes('desktopInputEvidence') && appScript.includes('function loadDesktopInputEvidence') && appScript.includes('/api/desktop-input/evidence'),
    hasWalkthroughFunction: appScript.includes('function openWalkthroughTarget'),
    hasMediaToolGuidance: appScript.includes('image_analyze') && appScript.includes('audio_transcribe'),
    hasRecoveryCopy: appScript.includes('Unfinished chat available') && appScript.includes('Fork starts a copy'),
    hasApplyCalibrationFunction: appScript.includes('function applyRoutingCalibration'),
    hasWeatherReplayEvalFunction: appScript.includes('function createWeatherReplayEval'),
    // Settings panel collapsibility (v0.2.2): the helper must be defined,
    // the localStorage key must be referenced for both read and write, and
    // the helper must be called from initialization. Drift in any of these
    // breaks settings-section persistence across reloads.
    hasSettingsCollapseFunction: appScript.includes('function setupSettingsCollapse'),
    hasSettingsCollapseInit: /\bsetupSettingsCollapse\(\)/.test(appScript),
    hasSettingsOpenSectionsRead: appScript.includes("localStorage.getItem('settingsOpenSections'"),
    hasSettingsOpenSectionsWrite: appScript.includes("localStorage.setItem('settingsOpenSections'"),
    hasSettingsSearch: appScript.includes('panel-search') && appScript.includes('settingsSearch'),
    // UI/preset alignment: every key NAME the Settings panel offers must
    // map to a backend preset in src/core/chatClientFactory.ts. An entry
    // here without a matching preset means the user can save a key that
    // no chat client will ever read (the Anthropic drift bug). The check
    // grep-extracts both lists and reports missing names.
    apiKeyAlignment: checkApiKeyAlignment(appScript),
    duplicateIds,
  };
  const failures = [];
  if (result.title !== 'Ollama Agent Harness') failures.push('unexpected or missing page title');
  if (!result.hasAppScript) failures.push('ui/app.js script reference was not found');
  if (!result.hasChatHistoryScript) failures.push('ui/chatHistory.js script reference was not found');
  if (!result.hasChatHistoryApi) failures.push('ui/chatHistory.js helper API was not found');
  if (!result.hasTraceExports) failures.push('trace export panel was not found');
  if (!result.hasTraceInspector) failures.push('trace inspector panel was not found');
  if (!result.hasRuntimeStorage) failures.push('runtime storage panel was not found');
  if (!result.hasRoutingSettings) failures.push('helper routing settings were not found');
  if (!result.hasMediaToolSettings) failures.push('media tool settings were not found');
  if (!result.hasSettingsDoctor) failures.push('settings setup doctor controls were not found');
  if (!result.hasOutputValidationSettings) failures.push('output validation settings were not found');
  if (!result.hasOutputValidationProfileEditor) failures.push('output validation profile editor was not found');
  for (const profile of ['oracle-prime', 'factual-answer', 'coding-answer', 'tool-result-summary']) {
    if (!result.outputValidationProfiles.includes(profile)) failures.push(`output validation profile option was not found: ${profile}`);
  }
  if (!result.hasContextDetails) failures.push('context details were not found');
  if (!result.hasTraceEvalExamples) failures.push('trace eval example panel was not found');
  if (!result.hasWeatherReplayEvalButton) failures.push('weather replay eval button was not found');
  if (!result.hasBeginnerGuide) failures.push('beginner guide was not found');
  if (!result.hasCapabilityTemplatePanelSupport) failures.push('capability template panel support was not found');
  if (!result.hasCapabilityTemplateStarterDetailFunction) failures.push('capability template starter detail function was not found');
  if (!result.hasCapabilityTemplateStarterActionFunction) failures.push('capability template starter action function was not found');
  if (!result.hasWalkthroughChecklist) failures.push('walkthrough checklist was not found');
  if (!result.hasFirstRunSetup) failures.push('first-run setup panel was not found');
  if (!result.hasFirstRunInputs) failures.push('first-run setup inputs were not found');
  if (!result.hasFirstRunHealth) failures.push('first-run health panel was not found');
  if (!result.hasAttachmentHint) failures.push('attachment hint was not found');
  if (!result.hasMemoryPalace) failures.push('memory palace view was not found');
  if (!result.hasMyceliumView) failures.push('mycelium view was not found');
  if (!result.hasMyceliumTab) failures.push('mycelium tab was not found');
  if (!result.hasMyceliumFunctions) failures.push('mycelium functions were not found');
  if (!result.hasMyceliumRouteInspection) failures.push('mycelium route inspection support was not found');
  if (!result.hasMyceliumGraphSections) failures.push('mycelium graph section support was not found');
  if (!result.hasTraceInspectorFunction) failures.push('trace inspector function was not found');
  if (!result.hasTraceFilterFunction) failures.push('trace filtering function was not found');
  if (!result.hasPalaceEntryFunction) failures.push('palace entry function was not found');
  if (!result.hasRuntimeCleanupFunction) failures.push('runtime cleanup function was not found');
  if (!result.hasRoutingMetricsFunction) failures.push('routing metrics function was not found');
  if (!result.hasCandidateQueueFunction) failures.push('candidate review function was not found');
  if (!result.hasEvalDatasetFunction) failures.push('eval dataset function was not found');
  if (!result.hasCandidateProvenanceFunction) failures.push('candidate provenance function was not found');
  if (!result.hasRunEvalDatasetFunction) failures.push('eval runner function was not found');
  if (!result.hasReplaySourceLinkFunction) failures.push('replay source link function was not found');
  if (!result.hasReplayFailureFunction) failures.push('replay failure function was not found');
  if (!result.hasMediaToolSettingFunction) failures.push('media tool setting function was not found');
  if (!result.hasSettingsDoctorFunction) failures.push('settings setup doctor function was not found');
  if (!result.hasFirstRunSetupFunction) failures.push('first-run setup function was not found');
  if (!result.hasFirstRunHealthFunction) failures.push('first-run health function was not found');
  if (!result.hasOutputValidationSettingFunction) failures.push('output validation setting function was not found');
  if (!result.hasOutputValidationFormatter) failures.push('output validation formatter was not found');
  if (!result.hasOutputValidationGroupedRenderer) failures.push('grouped output validation renderer was not found');
  if (!result.hasOutputValidationProfileRenderer) failures.push('output validation profile renderer was not found');
  if (!result.hasOutputValidationTrendFunction) failures.push('output validation trend renderer was not found');
  if (!result.hasOutputValidationSourceTrend) failures.push('output validation source trend renderer was not found');
  if (!result.hasOutputValidationTrendExportFunction) failures.push('output validation trend export function was not found');
  if (!result.hasProfilePresetImportExport) failures.push('profile preset import/export controls were not found');
  if (!result.hasProfilePresetFunctions) failures.push('profile preset import/export functions were not found');
  if (!result.hasValidationTemplates) failures.push('validation template controls were not found');
  if (!result.hasValidationTemplateExamples) failures.push('validation template example renderer was not found');
  if (!result.hasValidationTemplateFunction) failures.push('validation template functions were not found');
  if (!result.hasValidationPreview) failures.push('validation preview controls were not found');
  if (!result.hasValidationPreviewFunction) failures.push('validation preview functions were not found');
  if (!result.hasWalkthroughPersistenceFunction) failures.push('walkthrough persistence functions were not found');
  if (!result.hasAboutPanel) failures.push('about panel was not found');
  if (!result.hasAboutFunction) failures.push('about panel functions were not found');
  if (!result.hasAboutManifestLink) failures.push('about panel manifest link support was not found');
  if (!result.hasReleaseVerification) failures.push('release verification controls were not found');
  if (!result.hasReleaseVerificationFunction) failures.push('release verification function was not found');
  if (!result.hasContextPresetControls) failures.push('context preset controls were not found');
  if (!result.hasFallbackRoutingSetting) failures.push('fallback routing setting was not found');
  if (!result.hasWalkthroughFunction) failures.push('walkthrough function was not found');
  if (!result.hasMediaToolGuidance) failures.push('media tool guidance was not found');
  if (!result.hasRecoveryCopy) failures.push('recovery explanation copy was not found');
  if (!result.hasApplyCalibrationFunction) failures.push('apply calibration function was not found');
  if (!result.hasWeatherReplayEvalFunction) failures.push('weather replay eval function was not found');
  if (!result.hasSettingsCollapseFunction) failures.push('setupSettingsCollapse function was not found');
  if (!result.hasSettingsCollapseInit) failures.push('setupSettingsCollapse is not invoked at init');
  if (!result.hasSettingsOpenSectionsRead) failures.push('settingsOpenSections localStorage read was not found');
  if (!result.hasSettingsOpenSectionsWrite) failures.push('settingsOpenSections localStorage write was not found');
  if (!result.hasSettingsSearch) failures.push('panel-search / settingsSearch input was not found');
  if (result.apiKeyAlignment.error) {
    failures.push(`could not verify UI/preset alignment: ${result.apiKeyAlignment.error}`);
  } else if (result.apiKeyAlignment.orphans.length > 0) {
    failures.push(`UI Settings panel offers API key fields with no backend preset: ${result.apiKeyAlignment.orphans.join(', ')}. Add the backend in src/core/chatClientFactory.ts or remove the entry from REMOTE_API_KEY_FIELDS in ui/app.js.`);
  }
  if (duplicateIds.length > 0) failures.push(`duplicate ids found: ${duplicateIds.join(', ')}`);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function runMyceliumContextCardsSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('chatArea')) && typeof window.renderMyceliumContextCards === 'function');
    return await page.evaluate(async () => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (resource, init = {}) => {
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url === '/api/mycelium/last-route') {
          return Promise.resolve(new Response(JSON.stringify({
            episode: { id: 'ep1', query: 'help me launch a bakery', route: ['skill.zero-budget', 'memory.bakery-notes'], reward: 0.7, timestamp: new Date().toISOString() },
            nodes: [
              { id: 'skill.zero-budget', type: 'skill', label: 'zero-budget-growth-bible', summary: 'Zero-budget growth tactics for any business.', trust: 0.9, cost: 0.2, activation: 0.8 },
              { id: 'memory.bakery-notes', type: 'memory', label: 'Bakery launch notes', summary: 'Earlier conversation about Robyn\'s bakery launch checklist.', trust: 0.7, cost: 0.1, activation: 0.6 },
              { id: 'q.help-me-launch-a-bakery', type: 'query', label: 'help me launch a bakery', summary: '', trust: 1, cost: 0, activation: 1 },
            ],
            edges: [],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(resource, init);
      };
      try {
        await window.renderMyceliumContextCards('help me launch a bakery');
        const wrap = document.querySelector('.context-cards');
        const cards = wrap ? Array.from(wrap.querySelectorAll('.context-card')) : [];
        const labels = cards.map((card) => card.querySelector('.ctx-label')?.textContent || '');
        return {
          ok: Boolean(wrap)
            && cards.length === 2
            && labels.includes('zero-budget-growth-bible')
            && labels.includes('Bakery launch notes')
            && !labels.includes('help me launch a bakery'),
          cardCount: cards.length,
          labels,
        };
      } finally {
        window.fetch = originalFetch;
      }
    });
  } finally {
    await page.close();
  }
}

async function runInboxStripSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('inboxStrip')) && typeof window.loadInbox === 'function');
    return await page.evaluate(async () => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (resource, init = {}) => {
        const url = typeof resource === 'string' ? resource : resource?.url;
        if (url === '/api/inbox') {
          return Promise.resolve(new Response(JSON.stringify({
            total: 3,
            shown: 3,
            items: [
              { id: 'permission:p-1', kind: 'permission', title: 'Approve email_send', detail: 'Tool waiting on you', timestamp: new Date().toISOString(), priority: 100, action: { kind: 'open_tab', payload: 'tools' } },
              { id: 'plan_task:bracknell', kind: 'plan_task', title: 'finish bracknell delivery', detail: 'Pending plan task', timestamp: new Date(Date.now() - 60_000).toISOString(), priority: 60, action: { kind: 'open_tab', payload: 'autonomy' } },
              { id: 'automation_run:nightly:2026-05-09', kind: 'automation_run', title: 'nightly digest completed', detail: 'Open Runs to view output', timestamp: new Date(Date.now() - 120_000).toISOString(), priority: 30, action: { kind: 'open_tab', payload: 'runs' } },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(resource, init);
      };
      try {
        await window.loadInbox();
        const host = document.getElementById('inboxStrip');
        const items = host ? Array.from(host.querySelectorAll('.inbox-item')) : [];
        const titles = items.map((item) => item.querySelector('.inbox-title')?.textContent || '');
        const visible = host ? !host.classList.contains('initial-hidden') : false;
        return {
          ok: visible
            && items.length === 3
            && titles[0] === 'Approve email_send'
            && titles[2] === 'nightly digest completed'
            && Boolean(items[0].classList.contains('priority-high')),
          visible,
          itemCount: items.length,
          titles,
        };
      } finally {
        window.fetch = originalFetch;
      }
    });
  } finally {
    await page.close();
  }
}

async function runTopbarPetSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.getElementById('topbarPet')) && typeof window.updateTopbarPet === 'function');
    return await page.evaluate(() => {
      const el = document.getElementById('topbarPet');
      const observed = {};
      const sig = window._petSignals;
      // Hide the inbox strip so its items don't override idle/sleepy with
      // 'alert' (resolvePetState returns 'alert' when inbox has items).
      const inbox = document.getElementById('inboxStrip');
      const inboxRestore = inbox ? { display: inbox.style.display, hidden: inbox.classList.contains('initial-hidden') } : null;
      if (inbox) { inbox.classList.add('initial-hidden'); inbox.style.display = 'none'; }
      // Idle baseline: fresh activity, no recent error/tool call.
      sig.lastUserActivityAt = Date.now();
      sig.lastErrorAt = 0;
      sig.lastToolCallAt = 0;
      window.isSending = false;
      // Force a state recompute by clearing the cached last-state guard.
      window._petLastState = '';
      window.updateTopbarPet();
      observed.idle = { face: el.textContent, cls: el.className };
      // Working: simulate isSending + a recent tool call.
      window.isSending = true;
      sig.lastToolCallAt = Date.now();
      window.updateTopbarPet();
      observed.working = { face: el.textContent, cls: el.className };
      // Concerned: clear sending, mark a fresh error.
      window.isSending = false;
      sig.lastErrorAt = Date.now();
      window.updateTopbarPet();
      observed.concerned = { face: el.textContent, cls: el.className };
      // Sleepy: idle for >2 minutes and the prior error well into the past.
      sig.lastUserActivityAt = Date.now() - 180_000;
      sig.lastErrorAt = Date.now() - 60_000;
      window.updateTopbarPet();
      observed.sleepy = { face: el.textContent, cls: el.className };
      // Restore inbox visibility so later checks aren't affected.
      if (inbox && inboxRestore) {
        inbox.style.display = inboxRestore.display;
        if (!inboxRestore.hidden) inbox.classList.remove('initial-hidden');
      }
      return {
        ok: observed.working.cls.includes('pet-working')
          && observed.concerned.cls.includes('pet-concerned')
          && observed.sleepy.cls.includes('pet-sleepy')
          && observed.idle.cls.includes('pet-idle'),
        observed,
      };
    });
  } finally {
    await page.close();
  }
}

// Diagnostic wrapper: attaches pageerror logging and decorates evaluate /
// waitForFunction errors with the caller's source location so failures
// like "Cannot read properties of null" point to the failing check.
function instrumentBrowserDiagnostics(browser) {
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async function(...args) {
    const page = await origNewPage(...args);
    page.on('pageerror', (err) => console.error('[ui-smoke pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[ui-smoke console.error]', msg.text());
    });
    let stepCounter = 0;
    const wrap = (methodName) => {
      const orig = page[methodName].bind(page);
      page[methodName] = async function(...callArgs) {
        const stepNum = ++stepCounter;
        const callerLine = (new Error().stack || '').split('\n')[2]?.trim() || 'unknown';
        try {
          return await orig(...callArgs);
        } catch (err) {
          err.message = `[ui-smoke ${methodName} step ${stepNum}] failed at ${callerLine}\n  ${err.message}`;
          throw err;
        }
      };
    };
    wrap('evaluate');
    wrap('waitForFunction');
    return page;
  };
}

async function runPanelToggleSmoke(browser, targetUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.toggleLeft === 'function' && typeof window.toggleRight === 'function');
    return await page.evaluate(() => {
      const left = document.getElementById('leftPanel');
      const right = document.getElementById('rightPanel');
      if (!left || !right) return { ok: false, reason: 'panels not found' };
      const results = {};

      // Left panel: starts hidden (default for new users).
      results.leftStartsHidden = left.classList.contains('hidden');

      // Open left panel.
      window.toggleLeft();
      results.leftOpened = !left.classList.contains('hidden');

      // Close left panel.
      window.toggleLeft();
      results.leftClosed = left.classList.contains('hidden');

      // Right panel: starts hidden (has .hidden in markup).
      results.rightStartsHidden = right.classList.contains('hidden');

      // Open right panel.
      window.toggleRight();
      results.rightOpened = !right.classList.contains('hidden');

      // Close right panel via toggleRight.
      window.toggleRight();
      results.rightClosed = right.classList.contains('hidden');

      // Open right panel again, then close via Escape key.
      window.toggleRight();
      results.rightReopenedBeforeEscape = !right.classList.contains('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      results.rightClosedByEscape = right.classList.contains('hidden');

      // Backdrop: open left, check backdrop active.
      // Backdrop only activates on narrow viewports where panels are
      // fixed overlays, so skip the backdrop assertion at wide widths.
      const backdrop = document.getElementById('panelBackdrop');
      results.hasBackdrop = Boolean(backdrop);

      // dismissPanelBackdrop closes panels only at mobile widths (<=900)
      // where panels are full-screen overlays. Resize to a narrow viewport
      // and verify the dismiss closes an open panel.
      results.dismissBackdropCloses = false;
      if (typeof window.dismissPanelBackdrop === 'function') {
        window.toggleLeft(); // open left at current width
        // No assertion here; we re-verify after viewport resize below.
        results.dismissBackdropFnExists = true;
      }

      return {
        ok: results.leftStartsHidden
          && results.leftOpened
          && results.leftClosed
          && results.rightStartsHidden
          && results.rightOpened
          && results.rightClosed
          && results.rightReopenedBeforeEscape
          && results.rightClosedByEscape
          && results.hasBackdrop
          && results.dismissBackdropFnExists,
        results,
      };
    });
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});