#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');

const providedTargetUrl = process.argv[2] || process.env.HARNESS_UI_URL || '';
const targetUrl = providedTargetUrl || 'http://127.0.0.1:4300/';

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
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await page.evaluate(() => { const details = document.getElementById('welcomeFirstRun'); if (details) details.open = true; });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    await page.click('text=Verify install');
    await page.waitForFunction(() => document.getElementById('aboutPanel')?.textContent.includes('Version'));
    await page.evaluate(() => document.getElementById('verifyReleaseBtn')?.click());
    await page.waitForFunction(() => !document.getElementById('releaseVerificationPanel').classList.contains('initial-hidden'));
    await page.evaluate(() => { if (document.getElementById('rightPanel')?.classList.contains('hidden')) toggleRight(); });
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Run setup doctor'))?.click());
    await page.waitForFunction(() => !document.getElementById('settingsDoctorHealth').classList.contains('initial-hidden'));
    await page.waitForFunction(() => document.querySelectorAll('#outputValidationTemplates button').length > 0);
    await page.evaluate(() => document.querySelector('#outputValidationTemplates button')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationProfilesStatus')?.textContent.includes('Installed'));
    await page.fill('#outputValidationPreviewText', 'Implemented src/web/server.ts and ran npm test plus npm run typecheck.');
    await page.selectOption('#outputValidationProfile', 'coding-answer');
    await page.evaluate(() => document.getElementById('previewOutputValidationBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationPreviewResult')?.textContent.includes('coding-answer'));
    await page.fill('#outputValidationPreviewText', 'It will be cloudy.');
    await page.selectOption('#outputValidationProfile', 'factual-answer');
    await page.evaluate(() => document.getElementById('previewOutputValidationBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationPreviewResult')?.textContent.includes('Try:'));
    await page.fill('#customProfileId', 'smoke-profile');
    await page.fill('#customProfileLabel', 'Smoke Profile');
    await page.fill('#customProfileDescription', 'Created by UI smoke.');
    await page.fill('#customProfileInstructions', 'Mention smoke validation.');
    await page.evaluate(() => document.getElementById('saveProfileFromFormBtn')?.click());
    await page.waitForFunction(() => document.getElementById('outputValidationProfilesStatus')?.textContent.includes('custom profiles saved'));
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Refresh trace exports'))?.click());
    await page.evaluate(async () => {
      const data = await fetch('/api/capabilities').then((response) => response.json());
      const host = document.createElement('div');
      host.innerHTML = renderCapabilityAlignmentPanel({ items: data.capabilities, summary: data.summary });
      document.body.appendChild(host);
      window.__capabilityAlignmentSmoke = Boolean(document.getElementById('capabilityAlignmentPanel')) && document.getElementById('capabilityAlignmentPanel').textContent.includes('Live broker trading');
    });
    await page.evaluate(() => showLeftTab('skills', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('skills'"))));
    await page.waitForFunction(() => Boolean(document.getElementById('runtimeSkillSource')) && Boolean(document.getElementById('repoSkillSource')) && Boolean(document.getElementById('skillDiagnostics')) && Boolean(document.getElementById('skillAutomationPanel')));
    const skillsTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('skillList')).display !== 'none');
    await page.evaluate(() => showLeftTab('palace', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('palace'"))));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    const palaceTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    await page.evaluate(() => showLeftTab('discovery', Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('discovery'"))));
    await page.waitForFunction(() => Boolean(document.getElementById('discoveryPanel')));
    const discoveryTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('discoveryView')).display !== 'none');
    await page.evaluate(() => showLeftTab('learning', document.querySelector('[onclick*="learning"]')));
    await page.waitForFunction(() => Boolean(document.getElementById('learningCandidateQueue')));
    const learningWasVisible = await page.evaluate(() => getComputedStyle(document.getElementById('learningView')).display !== 'none');
    // Navigate remaining tabs to verify they render without errors
    for (const tab of ['files', 'memory', 'snapshots', 'rag', 'runs', 'workflows', 'mycelium']) {
      await page.evaluate((t) => showLeftTab(t, document.querySelector(`[onclick*="showLeftTab('${t}'"]`)), tab);
      await page.waitForTimeout(300);
    }
    // Navigate tools tab last so its dynamically-rendered panels don't
    // create duplicate IDs before the dedup check runs.
    await page.evaluate(() => showLeftTab('tools', document.querySelector('[onclick*="showLeftTab(\'tools\'"]')));
    await page.waitForTimeout(500);
    const result = await page.evaluate(({ palaceWasVisible, discoveryWasVisible, skillsWasVisible, learningWasVisible }) => {
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
        hasCapabilityAlignmentPanel: Boolean(window.__capabilityAlignmentSmoke),
        hasChatInput: Boolean(document.getElementById('chatInput')),
        hasTraceExports: Boolean(document.getElementById('traceExports')),
        hasTraceInspector: Boolean(document.getElementById('traceInspector')),
        hasRuntimeStorage: Boolean(document.getElementById('runtimeStorageStatus')),
        hasRuntimeSkillSource: Boolean(document.getElementById('runtimeSkillSource')),
        hasRepoSkillSource: Boolean(document.getElementById('repoSkillSource')),
        hasSkillDiagnostics: Boolean(document.getElementById('skillDiagnostics')),
        hasSkillAutomationPanel: Boolean(document.getElementById('skillAutomationPanel')) && typeof window.runSkillAutomation === 'function',
        hasOpenSkillsFunction: typeof window.openSkillsTab === 'function' && typeof window.appendOpenSkillsAction === 'function',
        hasDiscoveryView: Boolean(document.getElementById('discoveryView')),
        hasDiscoveryPanel: Boolean(document.getElementById('discoveryPanel')),
        hasModelCatalogPanel: Boolean(document.getElementById('modelCatalogPanel')),
        hasExtensionDiscoveryPanel: Boolean(document.getElementById('extensionDiscoveryPanel')),
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
        settingsDoctorVisible: !document.getElementById('settingsDoctorHealth').classList.contains('initial-hidden'),
        firstRunHealthVisible: !document.getElementById('firstRunHealth').classList.contains('initial-hidden'),
        hasContextDetails: Boolean(document.getElementById('contextDetails')),
        hasTraceEvalExamples: Boolean(document.getElementById('traceEvalExamples')),
        hasWeatherReplayEvalButton: Boolean(document.getElementById('createWeatherReplayEvalBtn')),
        hasBeginnerGuide: Boolean(document.getElementById('beginnerGuide')),
        hasWalkthroughChecklist: Boolean(document.getElementById('walkthroughChecklist')),
        hasWalkthroughFunction: typeof window.openWalkthroughTarget === 'function',
        hasFirstRunSetup: Boolean(document.getElementById('firstRunSetup')),
        hasFirstRunInputs: Boolean(document.getElementById('firstRunOllamaHost')) && Boolean(document.getElementById('firstRunVisionModel')) && Boolean(document.getElementById('firstRunAudioCommand')) && Boolean(document.getElementById('firstRunAudioSamplePath')),
        hasFirstRunHealth: Boolean(document.getElementById('firstRunHealth')),
        hasModelCapabilityHint: Boolean(document.getElementById('modelCapabilityHint')),
        hasAttachmentHint: Boolean(document.getElementById('attachmentHint')),
        hasMemoryPalace: Boolean(document.getElementById('memoryPalaceView')),
        hasPalaceDetail: Boolean(document.getElementById('palaceDetail')),
        palaceTabVisible: palaceWasVisible,
        discoveryTabVisible: discoveryWasVisible,
        skillsTabVisible: skillsWasVisible,
        learningTabVisible: learningWasVisible,
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
        releaseVerificationRendered: !document.getElementById('releaseVerificationPanel').classList.contains('initial-hidden'),
        guidedProfileSaved: document.getElementById('outputValidationProfilesStatus')?.textContent.includes('custom profiles saved'),
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
      };
    }, { palaceWasVisible: palaceTabVisible, discoveryWasVisible: discoveryTabVisible, skillsWasVisible: skillsTabVisible, learningWasVisible });

    const failures = [];
    if (result.title !== 'Ollama Agent Harness') failures.push(`Unexpected title: ${result.title}`);
    if (!result.hasAppScript) failures.push('ui/app.js script was not loaded');
    if (!result.hasChatHistoryApi) failures.push('chat history helper API was not available at runtime');
    if (!result.hasPermissionPanel) failures.push('permission panel was not created');
    if (!result.hasCapabilityAlignmentPanel) failures.push('capability alignment panel was not rendered');
    if (!result.hasChatInput) failures.push('chat input was not found');
    if (!result.hasTraceExports) failures.push('trace export panel was not found');
    if (!result.hasTraceInspector) failures.push('trace inspector panel was not found');
    if (!result.hasRuntimeStorage) failures.push('runtime storage panel was not found');
    if (!result.hasRuntimeSkillSource) failures.push('runtime skill source panel was not rendered');
    if (!result.hasRepoSkillSource) failures.push('repo skill source panel was not rendered');
    if (!result.hasSkillDiagnostics) failures.push('skill diagnostics panel was not rendered');
    if (!result.hasSkillAutomationPanel) failures.push('skill automation panel was not rendered');
    if (!result.hasOpenSkillsFunction) failures.push('open skills chat action functions were not found');
    if (!result.hasDiscoveryView) failures.push('discovery view was not found');
    if (!result.hasDiscoveryPanel) failures.push('discovery panel was not rendered');
    if (!result.hasModelCatalogPanel) failures.push('model catalog discovery panel was not rendered');
    if (!result.hasExtensionDiscoveryPanel) failures.push('extension discovery panel was not rendered');
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
    if (!result.hasWalkthroughChecklist) failures.push('walkthrough checklist was not found');
    if (!result.hasWalkthroughFunction) failures.push('walkthrough action function was not found');
    if (!result.hasFirstRunSetup) failures.push('first-run setup panel was not found');
    if (!result.hasFirstRunInputs) failures.push('first-run setup inputs were not found');
    if (!result.hasFirstRunHealth) failures.push('first-run health panel was not found');
    if (!result.hasModelCapabilityHint) failures.push('model capability hint was not found');
    if (!result.hasAttachmentHint) failures.push('attachment hint was not found');
    if (!result.hasMemoryPalace) failures.push('memory palace view was not found');
    if (result.palaceAnchorButtons > 0 && !result.hasPalaceDetail) failures.push('palace detail panel was not found');
    if (!result.palaceTabVisible) failures.push('palace tab did not become visible');
    if (!result.discoveryTabVisible) failures.push('discovery tab did not become visible');
    if (!result.skillsTabVisible) failures.push('skills tab did not become visible');
    if (!result.learningTabVisible) failures.push('learning tab did not become visible');
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

async function ensureTargetServer() {
  if (await canReachTarget()) return () => {};
  if (providedTargetUrl) {
    throw new Error(`Unable to reach ${targetUrl}. Start the Harness web server first, or omit the URL to let smoke:ui start the default local server.`);
  }

  const url = new URL(targetUrl);
  const serverArgs = fs.existsSync('dist/web/server.js')
    ? ['dist/web/server.js']
    : ['-r', 'ts-node/register', 'src/web/server.ts'];
  const server = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(),
    env: { ...process.env, PORT: url.port || '4300', NO_OPEN: '1' },
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
  while (Date.now() - startedAt < 15_000) {
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
    hasWalkthroughChecklist: ids.includes('walkthroughChecklist'),
    hasFirstRunSetup: ids.includes('firstRunSetup'),
    hasFirstRunInputs: ids.includes('firstRunOllamaHost') && ids.includes('firstRunVisionModel') && ids.includes('firstRunAudioCommand') && ids.includes('firstRunAudioSamplePath'),
    hasFirstRunHealth: ids.includes('firstRunHealth'),
    hasModelCapabilityHint: ids.includes('modelCapabilityHint'),
    hasAttachmentHint: ids.includes('attachmentHint'),
    hasMemoryPalace: ids.includes('memoryPalaceView'),
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
    hasWalkthroughFunction: appScript.includes('function openWalkthroughTarget'),
    hasMediaToolGuidance: appScript.includes('image_analyze') && appScript.includes('audio_transcribe'),
    hasRecoveryCopy: appScript.includes('Unfinished chat available') && appScript.includes('Fork starts a copy'),
    hasApplyCalibrationFunction: appScript.includes('function applyRoutingCalibration'),
    hasWeatherReplayEvalFunction: appScript.includes('function createWeatherReplayEval'),
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
  if (!result.hasWalkthroughChecklist) failures.push('walkthrough checklist was not found');
  if (!result.hasFirstRunSetup) failures.push('first-run setup panel was not found');
  if (!result.hasFirstRunInputs) failures.push('first-run setup inputs were not found');
  if (!result.hasFirstRunHealth) failures.push('first-run health panel was not found');
  if (!result.hasModelCapabilityHint) failures.push('model capability hint was not found');
  if (!result.hasAttachmentHint) failures.push('attachment hint was not found');
  if (!result.hasMemoryPalace) failures.push('memory palace view was not found');
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
  if (!result.hasWalkthroughFunction) failures.push('walkthrough function was not found');
  if (!result.hasMediaToolGuidance) failures.push('media tool guidance was not found');
  if (!result.hasRecoveryCopy) failures.push('recovery explanation copy was not found');
  if (!result.hasApplyCalibrationFunction) failures.push('apply calibration function was not found');
  if (!result.hasWeatherReplayEvalFunction) failures.push('weather replay eval function was not found');
  if (duplicateIds.length > 0) failures.push(`duplicate ids found: ${duplicateIds.join(', ')}`);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});