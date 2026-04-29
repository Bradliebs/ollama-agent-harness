#!/usr/bin/env node

const targetUrl = process.argv[2] || process.env.HARNESS_UI_URL || 'http://127.0.0.1:4300/';

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    await runStaticSmoke();
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await page.click('#firstRunSetup button:has-text("Check setup")');
    await page.waitForFunction(() => !document.getElementById('firstRunHealth').classList.contains('initial-hidden'));
    await page.click('text=Verify install');
    await page.waitForFunction(() => document.getElementById('aboutPanel')?.textContent.includes('Version'));
    await page.evaluate(() => { if (document.getElementById('rightPanel')?.classList.contains('hidden')) toggleRight(); });
    await page.click('text=Run setup doctor');
    await page.waitForFunction(() => !document.getElementById('settingsDoctorHealth').classList.contains('initial-hidden'));
    await page.fill('#customProfileId', 'smoke-profile');
    await page.fill('#customProfileLabel', 'Smoke Profile');
    await page.fill('#customProfileDescription', 'Created by UI smoke.');
    await page.fill('#customProfileInstructions', 'Mention smoke validation.');
    await page.click('#saveProfileFromFormBtn');
    await page.waitForFunction(() => document.getElementById('outputValidationProfilesStatus')?.textContent.includes('custom profiles saved'));
    await page.click('text=Refresh trace exports');
    await page.evaluate(() => showLeftTab('palace', Array.from(document.querySelectorAll('.tab')).find((element) => element.textContent === 'Palace')));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    const palaceTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    await page.evaluate(() => showLeftTab('learning', document.querySelector('[onclick*="learning"]')));
    await page.waitForFunction(() => Boolean(document.getElementById('learningCandidateQueue')));
    const result = await page.evaluate((palaceWasVisible) => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
      return {
        title: document.title,
        mode: 'playwright',
        hasAppScript: Array.from(document.scripts).some((script) => script.src.endsWith('/app.js')),
        hasPermissionPanel: Boolean(document.getElementById('permissionPanel')),
        hasChatInput: Boolean(document.getElementById('chatInput')),
        hasTraceExports: Boolean(document.getElementById('traceExports')),
        hasTraceInspector: Boolean(document.getElementById('traceInspector')),
        hasRuntimeStorage: Boolean(document.getElementById('runtimeStorageStatus')),
        hasRoutingSettings: Boolean(document.getElementById('smallHelperModel')) && Boolean(document.getElementById('strongHelperModel')),
        hasMediaToolSettings: Boolean(document.getElementById('visionModel')) && Boolean(document.getElementById('audioTranscribeCommand')),
        hasSettingsDoctor: Boolean(document.getElementById('settingsAudioSamplePath')) && Boolean(document.getElementById('settingsDoctorHealth')),
        hasOutputValidationSettings: Boolean(document.getElementById('outputValidationProfile')) && Boolean(document.getElementById('outputValidationToggle')),
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
        learningTabVisible: getComputedStyle(document.getElementById('learningView')).display !== 'none',
        traceInspectButtons: document.querySelectorAll('#traceExports button').length,
        palaceAnchorButtons: document.querySelectorAll('.palace-anchor').length,
        hasLearningCandidateQueue: Boolean(document.getElementById('learningCandidateQueue')),
        hasCandidateProvenanceDetail: Boolean(document.getElementById('candidateProvenanceDetail')),
        hasEvalDatasetManager: Boolean(document.getElementById('evalDatasetManager')),
        hasEvalRunTrend: Boolean(document.getElementById('evalRunTrend')),
        hasOutputValidationTrend: Boolean(document.getElementById('outputValidationTrend')),
        hasOutputValidationTrendExport: Boolean(document.getElementById('downloadOutputValidationTrendBtn')),
        hasProfilePresetImportExport: Boolean(document.getElementById('downloadProfilePresetBtn')) && Boolean(document.getElementById('importProfilePresetBtn')) && Boolean(document.getElementById('profilePresetFileInput')),
        hasProfilePresetFunctions: typeof window.downloadOutputValidationProfilesPreset === 'function' && typeof window.importOutputValidationProfilesPreset === 'function' && typeof window.handleOutputValidationProfilesPresetFile === 'function',
        hasAboutPanel: Boolean(document.getElementById('aboutPanel')),
        hasAboutFunction: typeof window.loadAbout === 'function',
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
        hasFirstRunSetupFunction: typeof window.applyFirstRunSetup === 'function',
        hasFirstRunHealthFunction: typeof window.checkFirstRunHealth === 'function',
        hasOutputValidationSettingFunction: typeof window.updateOutputValidationSetting === 'function' && typeof window.toggleOutputValidation === 'function' && typeof window.saveOutputValidationProfiles === 'function' && typeof window.validateOutputValidationProfilesEditor === 'function' && typeof window.saveProfileFromForm === 'function',
        hasOutputValidationFormatter: typeof window.formatOutputValidation === 'function',
        hasOutputValidationGroupedRenderer: typeof window.appendOutputValidationItem === 'function',
        hasApplyCalibrationFunction: typeof window.applyRoutingCalibration === 'function',
        duplicateIds,
      };
    }, palaceTabVisible);

    const failures = [];
    if (result.title !== 'Ollama Agent Harness') failures.push(`Unexpected title: ${result.title}`);
    if (!result.hasAppScript) failures.push('ui/app.js script was not loaded');
    if (!result.hasPermissionPanel) failures.push('permission panel was not created');
    if (!result.hasChatInput) failures.push('chat input was not found');
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
    if (!result.learningTabVisible) failures.push('learning tab did not become visible');
    if (!result.hasLearningCandidateQueue) failures.push('learning candidate queue was not rendered');
    if (!result.hasCandidateProvenanceDetail) failures.push('candidate provenance detail panel was not rendered');
    if (!result.hasEvalDatasetManager) failures.push('eval dataset manager was not rendered');
    if (!result.hasEvalRunTrend) failures.push('eval run trend panel was not rendered');
    if (!result.hasOutputValidationTrend) failures.push('output validation trend panel was not rendered');
    if (!result.hasOutputValidationTrendExport) failures.push('output validation trend export button was not rendered');
    if (!result.hasProfilePresetImportExport) failures.push('profile preset import/export controls were not rendered');
    if (!result.hasProfilePresetFunctions) failures.push('profile preset import/export functions were not found');
    if (!result.hasAboutPanel) failures.push('about panel was not rendered');
    if (!result.hasAboutFunction) failures.push('about panel function was not found');
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
    if (!result.hasFirstRunSetupFunction) failures.push('first-run setup function was not found');
    if (!result.hasFirstRunHealthFunction) failures.push('first-run health function was not found');
    if (!result.hasOutputValidationSettingFunction) failures.push('output validation setting function was not found');
    if (!result.hasOutputValidationFormatter) failures.push('output validation formatter was not found');
    if (!result.hasOutputValidationGroupedRenderer) failures.push('grouped output validation renderer was not found');
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
  }
}

async function runStaticSmoke() {
  const pageResponse = await fetch(targetUrl);
  const html = await pageResponse.text();
  const appUrl = new URL('./app.js', targetUrl).toString();
  const appResponse = await fetch(appUrl);
  const appScript = await appResponse.text();
  const ids = Array.from(html.matchAll(/id="([^"]+)"/g)).map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const result = {
    ok: true,
    mode: 'static',
    url: targetUrl,
    title: /<title>Ollama Agent Harness<\/title>/.test(html) ? 'Ollama Agent Harness' : '',
    hasAppScript: html.includes('./app.js'),
    hasTraceExports: ids.includes('traceExports'),
    hasTraceInspector: ids.includes('traceInspector'),
    hasRuntimeStorage: ids.includes('runtimeStorageStatus'),
    hasRoutingSettings: ids.includes('smallHelperModel') && ids.includes('strongHelperModel'),
    hasMediaToolSettings: ids.includes('visionModel') && ids.includes('audioTranscribeCommand'),
    hasSettingsDoctor: ids.includes('settingsAudioSamplePath') && ids.includes('settingsDoctorHealth'),
    hasOutputValidationSettings: ids.includes('outputValidationProfile') && ids.includes('outputValidationToggle'),
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
    hasOutputValidationSettingFunction: appScript.includes('function updateOutputValidationSetting') && appScript.includes('function toggleOutputValidation') && appScript.includes('function saveOutputValidationProfiles') && appScript.includes('function validateOutputValidationProfilesEditor') && appScript.includes('function saveProfileFromForm'),
    hasOutputValidationFormatter: appScript.includes('function formatOutputValidation'),
    hasOutputValidationGroupedRenderer: appScript.includes('function appendOutputValidationItem'),
    hasOutputValidationTrendFunction: appScript.includes('function renderOutputValidationTrends'),
    hasOutputValidationTrendExportFunction: appScript.includes('function downloadOutputValidationTrend'),
    hasProfilePresetImportExport: ids.includes('downloadProfilePresetBtn') && ids.includes('importProfilePresetBtn') && ids.includes('profilePresetFileInput'),
    hasProfilePresetFunctions: appScript.includes('function downloadOutputValidationProfilesPreset') && appScript.includes('function importOutputValidationProfilesPreset') && appScript.includes('function handleOutputValidationProfilesPresetFile'),
    hasAboutPanel: ids.includes('aboutPanel'),
    hasAboutFunction: appScript.includes('function loadAbout') && appScript.includes('function renderAboutPanel'),
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
  if (!result.hasOutputValidationTrendFunction) failures.push('output validation trend renderer was not found');
  if (!result.hasOutputValidationTrendExportFunction) failures.push('output validation trend export function was not found');
  if (!result.hasProfilePresetImportExport) failures.push('profile preset import/export controls were not found');
  if (!result.hasProfilePresetFunctions) failures.push('profile preset import/export functions were not found');
  if (!result.hasAboutPanel) failures.push('about panel was not found');
  if (!result.hasAboutFunction) failures.push('about panel functions were not found');
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