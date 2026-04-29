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
    await page.click('button[title="Settings"]');
    await page.click('text=Refresh trace exports');
    await page.click('text=Palace');
    const palaceTabVisible = await page.evaluate(() => getComputedStyle(document.getElementById('memoryPalaceView')).display !== 'none');
    await page.click('[onclick*="learning"]');
    const result = await page.evaluate((palaceWasVisible) => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
      return {
        title: document.title,
        hasAppScript: Array.from(document.scripts).some((script) => script.src.endsWith('/app.js')),
        hasPermissionPanel: Boolean(document.getElementById('permissionPanel')),
        hasChatInput: Boolean(document.getElementById('chatInput')),
        hasTraceExports: Boolean(document.getElementById('traceExports')),
        hasTraceInspector: Boolean(document.getElementById('traceInspector')),
        hasRuntimeStorage: Boolean(document.getElementById('runtimeStorageStatus')),
        hasRoutingSettings: Boolean(document.getElementById('smallHelperModel')) && Boolean(document.getElementById('strongHelperModel')),
        hasMediaToolSettings: Boolean(document.getElementById('visionModel')) && Boolean(document.getElementById('audioTranscribeCommand')),
        hasContextDetails: Boolean(document.getElementById('contextDetails')),
        hasTraceEvalExamples: Boolean(document.getElementById('traceEvalExamples')),
        hasWeatherReplayEvalButton: Boolean(document.getElementById('createWeatherReplayEvalBtn')),
        hasBeginnerGuide: Boolean(document.getElementById('beginnerGuide')),
        hasFirstRunSetup: Boolean(document.getElementById('firstRunSetup')),
        hasFirstRunInputs: Boolean(document.getElementById('firstRunOllamaHost')) && Boolean(document.getElementById('firstRunVisionModel')) && Boolean(document.getElementById('firstRunAudioCommand')),
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
    if (!result.hasContextDetails) failures.push('context details were not found');
    if (!result.hasTraceEvalExamples) failures.push('trace eval example panel was not found');
    if (!result.hasWeatherReplayEvalButton) failures.push('weather replay eval button was not found');
    if (!result.hasBeginnerGuide) failures.push('beginner guide was not found');
    if (!result.hasFirstRunSetup) failures.push('first-run setup panel was not found');
    if (!result.hasFirstRunInputs) failures.push('first-run setup inputs were not found');
    if (!result.hasFirstRunHealth) failures.push('first-run health panel was not found');
    if (!result.hasModelCapabilityHint) failures.push('model capability hint was not found');
    if (!result.hasAttachmentHint) failures.push('attachment hint was not found');
    if (!result.hasMemoryPalace) failures.push('memory palace view was not found');
    if (!result.hasPalaceDetail) failures.push('palace detail panel was not found');
    if (!result.palaceTabVisible) failures.push('palace tab did not become visible');
    if (!result.learningTabVisible) failures.push('learning tab did not become visible');
    if (!result.hasLearningCandidateQueue) failures.push('learning candidate queue was not rendered');
    if (!result.hasCandidateProvenanceDetail) failures.push('candidate provenance detail panel was not rendered');
    if (!result.hasEvalDatasetManager) failures.push('eval dataset manager was not rendered');
    if (!result.hasEvalRunTrend) failures.push('eval run trend panel was not rendered');
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
    hasContextDetails: ids.includes('contextDetails'),
    hasTraceEvalExamples: ids.includes('traceEvalExamples'),
    hasWeatherReplayEvalButton: ids.includes('createWeatherReplayEvalBtn'),
    hasBeginnerGuide: ids.includes('beginnerGuide'),
    hasFirstRunSetup: ids.includes('firstRunSetup'),
    hasFirstRunInputs: ids.includes('firstRunOllamaHost') && ids.includes('firstRunVisionModel') && ids.includes('firstRunAudioCommand'),
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
    hasFirstRunSetupFunction: appScript.includes('function applyFirstRunSetup'),
    hasFirstRunHealthFunction: appScript.includes('function checkFirstRunHealth'),
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
  if (!result.hasContextDetails) failures.push('context details were not found');
  if (!result.hasTraceEvalExamples) failures.push('trace eval example panel was not found');
  if (!result.hasWeatherReplayEvalButton) failures.push('weather replay eval button was not found');
  if (!result.hasBeginnerGuide) failures.push('beginner guide was not found');
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
  if (!result.hasFirstRunSetupFunction) failures.push('first-run setup function was not found');
  if (!result.hasFirstRunHealthFunction) failures.push('first-run health function was not found');
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