marked.setOptions({ breaks: true, gfm: true });

let isSending = false;
function saveChatSession() {
  window.HarnessChatHistory.saveChatSession({ chatMessages, currentChatId });
}
function loadPersistedChatSession() {
  return window.HarnessChatHistory.loadPersistedChatSession();
}
function outboundChatHistory() {
  return window.HarnessChatHistory.outboundChatHistory(chatMessages);
}
let chatMessages = [];
let currentChatId = null;
(() => {
  const persisted = loadPersistedChatSession();
  if (!persisted) return;
  chatMessages = persisted.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content);
  currentChatId = persisted.currentChatId || null;
})();
let lastSessionId = null;
let pendingFiles = [];
let permissionPollTimer = null;
let activeChatController = null;
let activeTraceExport = null;
let currentModelRouting = {};
let currentMediaTools = {};
let currentOutputValidation = { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: false };
let currentOutputValidationProfiles = [];
let currentOutputValidationTemplates = [];
let currentModelCatalog = { url: '', ttlHours: 24 };
let currentExtensionActivation = { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
const LAST_VALIDATION_PROMPT_KEY = 'harness.lastValidationPrompt';
let lastValidationPrompt = (() => {
  try { return localStorage.getItem(LAST_VALIDATION_PROMPT_KEY) || ''; } catch { return ''; }
})();
let currentWalkthrough = { completed: [] };
let availableModels = [];

window.addEventListener('DOMContentLoaded', () => {
  ensurePermissionPanel();
  loadModels();
  loadHistory();
  loadFiles();
  loadSettings();
  loadOutputValidationTemplates();
  loadDiscovery();
  loadAbout();
  loadTraceExports();
  loadRuntimeStorage();
  loadRecovery();
  startPermissionPolling();
  // Restore prior chat session if the user reloaded mid-conversation.
  if (chatMessages.length > 0) {
    const chatArea = document.getElementById('chatArea');
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    if (chatArea) for (const m of chatMessages) addMsg(m.role, m.content);
    // Round-trip into the server-side /api/history store so a persisted-but-unsaved
    // session also survives clearing localStorage. Save only if we have at least one
    // assistant turn (autoSaveChat already requires >= 2 messages).
    if (chatMessages.length >= 2) autoSaveChat();
  }
  document.getElementById('chatInput').focus();
});

async function loadModels() {
  const dot = document.getElementById('statusDot');
  const sel = document.getElementById('modelSelect');
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    if (d.error) { dot.className = 'status-dot'; sel.innerHTML = '<option>' + esc(d.error) + '</option>'; return; }
    dot.className = 'status-dot ok'; dot.title = 'Connected';
    const models = d.models || [];
    availableModels = models;
    if (!models.length) { sel.innerHTML = '<option value="">No models installed</option>'; return; }
    sel.innerHTML = '<option value="">— Select model —</option>' + models.map((m) => {
      const size = m.parameterSize ? ' (' + m.parameterSize + ')' : '';
      return '<option value="' + escAttr(m.name) + '">' + esc(m.name + size) + '</option>';
    }).join('');
    sel.disabled = false;
    sel.onchange = () => { renderModelCapabilityHint(); if (sel.value) { updateSetting('model', sel.value); document.getElementById('sendBtn').disabled = false; } };
    if (models.length === 1) { sel.value = models[0].name; sel.dispatchEvent(new Event('change')); }
    renderModelCapabilityHint();
  } catch {
    dot.className = 'status-dot';
    sel.innerHTML = '<option>Server not running</option>';
  }
}

function selectedModelDetails() {
  const selected = document.getElementById('modelSelect')?.value;
  return availableModels.find((model) => model.name === selected) || null;
}

function renderModelCapabilityHint() {
  const hint = document.getElementById('modelCapabilityHint');
  if (!hint) return;
  const model = selectedModelDetails();
  if (!model) {
    hint.textContent = 'Choose a model to see whether Harness detects text, image, or audio support.';
    renderAttachmentHint();
    return;
  }
  const capabilities = model.capabilities || { text: true, image: false, audio: false, notes: [] };
  const pills = [
    capabilityPill('Text', true),
    capabilityPill('Images', capabilities.image),
    capabilityPill('Audio', capabilities.audio),
  ].join('');
  const notes = (capabilities.notes || []).slice(0, 2).map(esc).join(' ');
  hint.innerHTML = '<strong>' + esc(model.name) + '</strong><div>' + pills + '</div><div>' + esc(notes || 'Harness detected a text chat model. Attachments are still available as local file paths for tools and analysis.') + '</div>' + getModelProfileSuggestion(model.name);
  renderAttachmentHint();
}

function capabilityPill(label, enabled) {
  return '<span class="capability-pill">' + (enabled ? '✓ ' : '○ ') + esc(label) + '</span>';
}

function getModelProfileSuggestion(modelName) {
  if (!modelName) return '';
  const modelLower = modelName.toLowerCase();
  // Check if any saved profile uses this model
  for (const [name, profile] of Object.entries(agentProfiles)) {
    if (profile.model && modelLower.includes(profile.model.toLowerCase().split(':')[0])) {
      return '<div style="margin-top:4px"><a href="#" onclick="loadAgentProfile(\'' + escAttr(name) + '\'); event.preventDefault();" style="color:var(--accent);font-size:11px">' + esc((profile.avatar || '🤖') + ' Load "' + name + '" profile for this model') + '</a></div>';
    }
  }
  // Suggest personality presets based on model type
  const MODEL_PERSONALITY_HINTS = {
    'codellama': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'deepseek-coder': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'qwen2.5-coder': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'llava': { preset: 'friendly', hint: 'Vision model — try the Friendly personality for image conversations' },
    'gemma': { preset: 'friendly', hint: 'Conversational model — try the Friendly personality' },
    'mistral': { preset: 'professional', hint: 'Balanced model — try the Professional personality' },
    'llama': { preset: 'mentor', hint: 'General model — try the Mentor personality for learning' },
  };
  for (const [prefix, config] of Object.entries(MODEL_PERSONALITY_HINTS)) {
    if (modelLower.includes(prefix) && !currentAgentName) {
      return '<div style="margin-top:4px;font-size:11px;color:var(--text-dim)">' + esc(config.hint) + ' <a href="#" onclick="applyPersonalityPreset(\'' + config.preset + '\'); event.preventDefault();" style="color:var(--accent)">Apply</a></div>';
    }
  }
  return '';
}

function renderAttachmentHint() {
  const hint = document.getElementById('attachmentHint');
  if (!hint) return;
  const model = selectedModelDetails();
  const hasImage = pendingFiles.some((file) => mediaKind(file) === 'image');
  const hasAudio = pendingFiles.some((file) => mediaKind(file) === 'audio');
  if (!model) {
    hint.textContent = 'Attach text, data, image, or audio files. Pick a model to see what it is likely to understand.';
    return;
  }
  const capabilities = model.capabilities || {};
  if (hasImage && !capabilities.image) {
    hint.textContent = 'Image attached. This model is not detected as a vision model, so Harness will provide the file path for tools or follow-up handling.';
    return;
  }
  if (hasAudio && !capabilities.audio) {
    hint.textContent = 'Audio attached. This model is not detected as audio-capable, so transcription tooling may be needed before chat analysis.';
    return;
  }
  if (pendingFiles.length > 3) {
    hint.innerHTML = esc(pendingFiles.length + ' files attached.') + ' <a href="#" onclick="suggestScanAllAttachments(event)" style="color:var(--accent)">Ask the model to scan all attachments</a> using <code>list_uploads</code>.';
    return;
  }
  hint.textContent = 'Attach text, data, image, or audio files. Harness shows the media type and passes the local file path into your message.';
}

function suggestScanAllAttachments(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const inp = document.getElementById('chatInput');
  if (!inp) return;
  const suggestion = 'Call list_uploads first to enumerate every attached file, then read and summarize each one in turn. Use the exact path returned by list_uploads when you call file_read, pdf_read, image_analyze, or audio_transcribe.';
  inp.value = inp.value ? inp.value.trim() + '\n\n' + suggestion : suggestion;
  autoSize(inp);
  inp.focus();
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    if (s.temperature !== undefined) { document.getElementById('tempSlider').value = s.temperature; document.getElementById('tempVal').textContent = s.temperature; }
    if (s.topP !== undefined) { document.getElementById('topPSlider').value = s.topP; document.getElementById('topPVal').textContent = s.topP; }
    if (s.systemPrompt) document.getElementById('sysPrompt').value = s.systemPrompt;
    hydratePersonality(s.agentPersonality || '');
    hydrateAgentName(s.agentName || '');
    hydrateAgentAvatar(s.agentAvatar || '');
    hydrateAgentProfiles(s.agentProfiles || {});
    if (s.ollamaHost) document.getElementById('ollamaHost').value = s.ollamaHost;
    if (s.summarizerModel) document.getElementById('summarizerModel').value = s.summarizerModel;
    if (s.contextMaxTokens) document.getElementById('contextMaxTokens').value = s.contextMaxTokens;
    renderContextDetails(s.context || { configuredMaxTokens: s.contextMaxTokens, detectedMaxTokens: null, effectiveMaxTokens: s.contextMaxTokens });
    currentModelRouting = s.modelRouting || {};
    currentMediaTools = s.mediaTools || {};
    currentOutputValidation = s.outputValidation || { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: false };
    currentOutputValidationProfiles = s.outputValidationProfiles || [];
    currentModelCatalog = s.modelCatalog || { url: '', ttlHours: 24 };
    currentExtensionActivation = s.extensionActivation || { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
    currentWalkthrough = s.walkthrough || { completed: [] };
    const small = document.getElementById('smallHelperModel');
    const def = document.getElementById('defaultHelperModel');
    const strong = document.getElementById('strongHelperModel');
    const confidence = document.getElementById('helperConfidenceThreshold');
    const vision = document.getElementById('visionModel');
    const audio = document.getElementById('audioTranscribeCommand');
    const pdfOcr = document.getElementById('pdfOcrCommand');
    const outputProfile = document.getElementById('outputValidationProfile');
    const outputToggle = document.getElementById('outputValidationToggle');
    const outputAutoToggle = document.getElementById('outputValidationAutoSelectToggle');
    const outputSkipLowSignalToggle = document.getElementById('outputValidationSkipLowSignalToggle');
    const catalogUrl = document.getElementById('modelCatalogUrl');
    const catalogTtl = document.getElementById('modelCatalogTtlHours');
    const extensionExecutableToggle = document.getElementById('extensionExecutableToggle');
    const extensionPermissionReviewToggle = document.getElementById('extensionPermissionReviewToggle');
    const extensionAllowedPluginNames = document.getElementById('extensionAllowedPluginNames');
    const firstRunHost = document.getElementById('firstRunOllamaHost');
    const firstRunVision = document.getElementById('firstRunVisionModel');
    const firstRunAudio = document.getElementById('firstRunAudioCommand');
    if (small) small.value = currentModelRouting.smallModel || '';
    if (def) def.value = currentModelRouting.defaultModel || '';
    if (strong) strong.value = currentModelRouting.strongModel || '';
    if (confidence && currentModelRouting.confidenceEscalationThreshold !== undefined) confidence.value = currentModelRouting.confidenceEscalationThreshold;
    if (vision) vision.value = currentMediaTools.visionModel || '';
    if (audio) audio.value = currentMediaTools.audioTranscribeCommand || '';
    if (pdfOcr) pdfOcr.value = currentMediaTools.pdfOcrCommand || '';
    if (catalogUrl) catalogUrl.value = currentModelCatalog.url || '';
    if (catalogTtl) catalogTtl.value = currentModelCatalog.ttlHours || 24;
    if (extensionExecutableToggle) extensionExecutableToggle.classList.toggle('active', currentExtensionActivation.executablePlugins === true);
    if (extensionPermissionReviewToggle) extensionPermissionReviewToggle.classList.toggle('active', currentExtensionActivation.requirePermissionReview !== false);
    if (extensionAllowedPluginNames) extensionAllowedPluginNames.value = (currentExtensionActivation.allowedPluginNames || []).join(', ');
    const uploadsDirInput = document.getElementById('uploadsDir');
    if (uploadsDirInput) uploadsDirInput.value = currentMediaTools.uploadsDir || '';
    const autoPruneInput = document.getElementById('uploadsAutoPruneDays');
    if (autoPruneInput) autoPruneInput.value = currentMediaTools.uploadsAutoPruneDays || 0;
    const lastPrunedEl = document.getElementById('uploadsLastPrunedAt');
    if (lastPrunedEl) lastPrunedEl.textContent = currentMediaTools.uploadsLastPrunedAt ? 'Last pruned ' + new Date(currentMediaTools.uploadsLastPrunedAt).toLocaleString() : 'Never pruned';
    renderOutputValidationProfileOptions(outputProfile, currentOutputValidationProfiles, currentOutputValidation.profile || 'oracle-prime');
    const profilesEditor = document.getElementById('outputValidationProfilesJson');
    if (profilesEditor) {
      profilesEditor.value = JSON.stringify({ profiles: s.customOutputValidationProfiles || [] }, null, 2);
      profilesEditor.oninput = validateOutputValidationProfilesEditor;
      validateOutputValidationProfilesEditor();
    }
    renderCustomProfilePicker();
    resetCustomProfileForm();
    refreshWalkthroughChecklist();
    if (outputToggle) outputToggle.classList.toggle('active', currentOutputValidation.enabled === true);
    if (outputAutoToggle) outputAutoToggle.classList.toggle('active', currentOutputValidation.autoSelect !== false);
    if (outputSkipLowSignalToggle) outputSkipLowSignalToggle.classList.toggle('active', currentOutputValidation.skipOnLowSignal === true);
    if (firstRunHost) firstRunHost.value = s.ollamaHost || 'http://localhost:11434';
    if (firstRunVision) firstRunVision.value = currentMediaTools.visionModel || '';
    if (firstRunAudio) firstRunAudio.value = currentMediaTools.audioTranscribeCommand || '';
    hydrateCuratorSettings(s.curator || {});
    hydrateAutomationSchedulerSettings(s.automationScheduler || {});
    document.querySelectorAll('.permission-mode-option').forEach((option) => option.classList.remove('active'));
    const modeIndex = s.permissionMode === 'dontAsk' ? 0 : s.permissionMode === 'acceptEdits' ? 1 : 2;
    const mode = document.querySelectorAll('.permission-mode-option')[modeIndex];
    if (mode) mode.classList.add('active');
  } catch {}
}

async function loadOutputValidationTemplates() {
  try {
    const response = await fetch('/api/output-validation/templates');
    const data = await response.json();
    currentOutputValidationTemplates = data.templates || [];
    renderOutputValidationTemplates();
  } catch {}
}

function renderOutputValidationTemplates() {
  const list = document.getElementById('outputValidationTemplates');
  if (!list) return;
  list.innerHTML = currentOutputValidationTemplates.map((template) => {
    const installed = currentCustomProfilesFromEditor().some((profile) => profile.profile === template.profile);
    const examples = template.examples ? '<div class="template-example"><span>Good</span>' + esc(template.examples.good || '') + '<span>Bad</span>' + esc(template.examples.bad || '') + '</div>' : '';
    return '<div class="template-item"><div><strong>' + esc(template.label || template.profile) + '</strong>' + esc(template.description || '') + '</div><button class="btn-sm" onclick="installOutputValidationTemplate(\'' + escAttr(template.profile) + '\')">' + (installed ? 'Reinstall' : 'Install') + '</button>' + examples + '</div>';
  }).join('') || '<div class="trace-meta">Templates unavailable.</div>';
}

async function installOutputValidationTemplate(profile) {
  const status = document.getElementById('outputValidationProfilesStatus');
  if (status) status.textContent = 'Installing template...';
  try {
    const response = await fetch('/api/output-validation/templates/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    currentOutputValidationProfiles = data.profiles || [];
    currentOutputValidation = { ...currentOutputValidation, profile: data.installed || profile };
    renderOutputValidationProfileOptions(document.getElementById('outputValidationProfile'), currentOutputValidationProfiles, currentOutputValidation.profile);
    writeCustomProfilesToEditor(data.customProfiles || []);
    renderOutputValidationTemplates();
    markWalkthroughStep('validation');
    if (status) status.textContent = 'Installed ' + (data.installed || profile) + ' into custom profiles.';
  } catch (error) {
    if (status) status.textContent = 'Could not install template: ' + (error instanceof Error ? error.message : String(error));
  }
}

async function previewOutputValidation() {
  const output = document.getElementById('outputValidationPreviewResult');
  const content = document.getElementById('outputValidationPreviewText')?.value || '';
  const profile = document.getElementById('outputValidationProfile')?.value || currentOutputValidation.profile || 'oracle-prime';
  if (!output) return;
  output.className = 'validation-preview-result';
  output.textContent = 'Running preview...';
  try {
    const response = await fetch('/api/output-validation/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, content }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    renderValidationPreviewResult(data.validation);
    markWalkthroughStep('validation');
  } catch (error) {
    output.className = 'validation-preview-result fail';
    output.textContent = 'Preview failed: ' + (error instanceof Error ? error.message : String(error));
  }
}

function renderValidationPreviewResult(validation) {
  const output = document.getElementById('outputValidationPreviewResult');
  if (!output) return;
  const findings = validation.findings || [];
  output.className = 'validation-preview-result ' + escAttr(validation.status || 'warn');
  const suggestions = Array.from(new Set(findings.map((finding) => finding.suggestion).filter(Boolean)));
  output.innerHTML = '<div><strong>' + esc(validation.profile) + ' ' + esc(validation.status) + '</strong> · score ' + esc(validation.score) + '</div>' +
    (findings.length ? findings.map((finding) => '<div>' + esc(finding.severity.toUpperCase()) + ': ' + esc(finding.code) + ' - ' + esc(finding.message) + '</div>').join('') : '<div>PASS: no findings</div>') +
    ((validation.missingSections || []).length ? '<div>Missing sections: ' + esc(validation.missingSections.join(', ')) + '</div>' : '') +
    (suggestions.length ? '<div><strong>Suggestions</strong></div>' + suggestions.map((suggestion) => '<div>Try: ' + esc(suggestion) + '</div>').join('') : '');
}

async function loadAbout() {
  const panel = document.getElementById('aboutPanel');
  if (panel) panel.textContent = 'Loading version information...';
  try {
    const response = await fetch('/api/about');
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    renderAboutPanel(data);
  } catch (error) {
    if (panel) panel.textContent = 'Version information unavailable: ' + (error instanceof Error ? error.message : String(error));
  }
}

function renderAboutPanel(data) {
  const panel = document.getElementById('aboutPanel');
  if (!panel) return;
  const releaseLink = data.releaseUrl ? '<a href="' + escAttr(data.releaseUrl) + '" target="_blank">release page</a>' : 'not packaged';
  const manifestLink = data.manifestUrl ? '<a href="' + escAttr(data.manifestUrl) + '" target="_blank">' + esc(data.manifestName || 'manifest') + '</a>' : (data.manifestName || 'not available in this install');
  const rows = [
    ['Version', data.version || 'unknown'],
    ['Commit', data.commit || 'not available in this install'],
    ['Asset', data.assetName || 'not available in this install'],
    ['Asset SHA-256', data.assetSha256 || 'see release page'],
    ['Manifest', manifestLink],
    ['Release', releaseLink],
  ];
  const validationDoc = '<div class="trace-detail" style="margin-top:8px"><strong>Validation profiles:</strong> Auto-select picks <code>oracle-prime</code> / <code>factual-answer</code> / <code>coding-answer</code> / <code>tool-result-summary</code> from prompt keywords. Vague prompts default to <code>oracle-prime</code> and can be skipped via <em>Skip validation on low-signal prompts</em>. See <code>docs/VALIDATION-PROFILES.md</code> for the full rules.</div>';
  panel.innerHTML = '<div class="about-grid">' + rows.map(([label, value]) => '<div><strong>' + esc(label) + '</strong> ' + String(value).replace(/^((?!<a ).)*$/, (text) => esc(text)) + '</div>').join('') + '</div>' + validationDoc;
}

async function verifyReleaseAsset() {
  const panel = document.getElementById('releaseVerificationPanel');
  if (!panel) return;
  panel.classList.remove('initial-hidden');
  panel.textContent = 'Checking release provenance...';
  try {
    const response = await fetch('/api/about/verify');
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    const releaseLink = data.releaseUrl ? '<a href="' + escAttr(data.releaseUrl) + '" target="_blank">release page</a>' : 'release page unavailable';
    panel.innerHTML = '<div><strong>' + esc(data.status === 'verified' ? 'Verified' : 'Needs comparison') + '</strong> ' + esc(data.message) + '</div>' +
      '<div><strong>Asset</strong> ' + esc(data.assetName || 'unknown') + '</div>' +
      '<div><strong>Expected SHA-256</strong> ' + esc(data.expectedSha256 || 'shown on GitHub release') + '</div>' +
      '<div><strong>Local archive SHA-256</strong> ' + esc(data.localArchiveSha256 || 'no local archive found at ' + (data.localArchivePath || 'release folder')) + '</div>' +
      '<div><strong>Release</strong> ' + releaseLink + '</div>';
    markWalkthroughStep('about');
  } catch (error) {
    panel.textContent = 'Release verification unavailable: ' + (error instanceof Error ? error.message : String(error));
  }
}

function openWalkthroughTarget(target) {
  if (target === 'learning') {
    const tab = document.querySelector('[onclick*="learning"]');
    if (tab) showLeftTab('learning', tab);
    return;
  }
  ensureRightPanelVisible();
  const targetId = target === 'setup' ? 'ollamaHost' : target === 'validation' ? 'customProfileId' : 'aboutPanel';
  const element = document.getElementById(targetId);
  if (element) element.scrollIntoView({ block: 'center' });
  if (target === 'about') loadAbout();
}

function walkthroughCompleted(step) {
  return (currentWalkthrough.completed || []).includes(step);
}

function markWalkthroughStep(step) {
  if (walkthroughCompleted(step)) return;
  currentWalkthrough = { completed: [...(currentWalkthrough.completed || []), step] };
  updateSetting('walkthrough', currentWalkthrough);
  refreshWalkthroughChecklist();
}

function refreshWalkthroughChecklist() {
  const checklist = document.getElementById('walkthroughChecklist');
  if (checklist) checklist.innerHTML = walkthroughChecklistMarkup();
}

function walkthroughChecklistMarkup() {
  const steps = [
    ['setup', 'Check setup', 'Confirm Ollama, optional vision, and optional audio helpers.'],
    ['validation', 'Create or preview validation', 'Install a template, save a profile, or preview an answer.'],
    ['learning', 'Export results', 'Download validation trends from the Learning tab.'],
    ['about', 'Verify install', 'Check the running version and release provenance.'],
  ];
  return steps.map(([id, title, description], index) => {
    const done = walkthroughCompleted(id);
    return '<div class="walkthrough-step' + (done ? ' done' : '') + '"><div class="walkthrough-dot">' + (done ? '✓' : index + 1) + '</div><div><strong>' + esc(title) + '</strong>' + esc(description) + '</div><button class="btn-sm" onclick="openWalkthroughTarget(\'' + escAttr(id) + '\')">' + (done ? 'Open' : 'Start') + '</button></div>';
  }).join('');
}

function ensureRightPanelVisible() {
  const panel = document.getElementById('rightPanel');
  if (panel?.classList.contains('hidden')) panel.classList.remove('hidden');
}

function renderOutputValidationProfileOptions(select, profiles, selected) {
  if (!select) return;
  const knownProfiles = profiles.length ? profiles : [
    { profile: 'oracle-prime', label: 'Oracle Prime', description: 'Full reasoning contract.' },
    { profile: 'factual-answer', label: 'Factual Answer', description: 'Direct factual answers.' },
    { profile: 'coding-answer', label: 'Coding Answer', description: 'Engineering summaries.' },
    { profile: 'tool-result-summary', label: 'Tool Result Summary', description: 'Command/tool summaries.' },
  ];
  select.innerHTML = knownProfiles.map((profile) => '<option value="' + escAttr(profile.profile) + '" title="' + escAttr(profile.description || profile.label || profile.profile) + '">' + esc(profile.label || profile.profile) + '</option>').join('');
  select.value = selected;
}

function currentCustomProfilesFromEditor() {
  const editor = document.getElementById('outputValidationProfilesJson');
  if (!editor) return [];
  try {
    const parsed = JSON.parse(editor.value || '{"profiles":[]}');
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function writeCustomProfilesToEditor(profiles) {
  const editor = document.getElementById('outputValidationProfilesJson');
  if (!editor) return;
  editor.value = JSON.stringify({ profiles }, null, 2);
  validateOutputValidationProfilesEditor();
  renderCustomProfilePicker();
}

function renderCustomProfilePicker(selected) {
  const picker = document.getElementById('customProfilePicker');
  if (!picker) return;
  const profiles = currentCustomProfilesFromEditor();
  picker.innerHTML = '<option value="">New profile</option>' + profiles.map((profile) => '<option value="' + escAttr(profile.profile || '') + '">' + esc(profile.label || profile.profile || 'Untitled profile') + '</option>').join('');
  picker.value = selected || '';
}

function resetCustomProfileForm() {
  const fields = {
    customProfileId: '',
    customProfileLabel: '',
    customProfileDescription: '',
    customProfileInstructions: '',
    customProfileWarnBelow: '',
    customProfileFailBelow: '',
  };
  for (const [id, value] of Object.entries(fields)) {
    const field = document.getElementById(id);
    if (field) field.value = value;
  }
  const picker = document.getElementById('customProfilePicker');
  if (picker) picker.value = '';
  const checks = document.getElementById('customProfileChecks');
  if (checks) checks.innerHTML = '';
  addCustomProfileCheck({ code: 'has-outcome', severity: 'fail', message: 'Mention whether the work passed or failed.', requiresAny: ['passed', 'failed'], scorePenalty: 0.2 });
}

function loadSelectedCustomProfile() {
  const selected = document.getElementById('customProfilePicker')?.value || '';
  const profile = currentCustomProfilesFromEditor().find((item) => item.profile === selected);
  if (!profile) { resetCustomProfileForm(); return; }
  document.getElementById('customProfileId').value = profile.profile || '';
  document.getElementById('customProfileLabel').value = profile.label || '';
  document.getElementById('customProfileDescription').value = profile.description || '';
  document.getElementById('customProfileInstructions').value = profile.instructions || '';
  document.getElementById('customProfileWarnBelow').value = profile.warnBelowScore ?? '';
  document.getElementById('customProfileFailBelow').value = profile.failBelowScore ?? '';
  const checks = document.getElementById('customProfileChecks');
  if (checks) checks.innerHTML = '';
  (profile.checks || []).forEach((check) => addCustomProfileCheck(check));
  if (!profile.checks?.length) addCustomProfileCheck();
}

function addCustomProfileCheck(check = {}) {
  const checks = document.getElementById('customProfileChecks');
  if (!checks) return;
  const row = document.createElement('div');
  row.className = 'profile-check-row';
  row.innerHTML = '<div><label>Check code</label><input data-field="code" placeholder="has-outcome" value="' + escAttr(check.code || '') + '"></div>' +
    '<div><label>Severity</label><select data-field="severity"><option value="fail">fail</option><option value="warn">warn</option><option value="pass">pass</option></select></div>' +
    '<div class="wide"><label>Message</label><input data-field="message" placeholder="Mention the outcome." value="' + escAttr(check.message || '') + '"></div>' +
    '<div class="wide"><label>Requires any</label><input data-field="requiresAny" placeholder="passed, failed" value="' + escAttr((check.requiresAny || []).join(', ')) + '"></div>' +
    '<div class="wide"><label>Requires all</label><input data-field="requiresAll" placeholder="release, validation" value="' + escAttr((check.requiresAll || []).join(', ')) + '"></div>' +
    '<div class="wide"><label>Forbids any</label><input data-field="forbidsAny" placeholder="todo, placeholder" value="' + escAttr((check.forbidsAny || []).join(', ')) + '"></div>' +
    '<div><label>Min length</label><input data-field="minLength" type="number" min="1" max="200000" value="' + escAttr(check.minLength ?? '') + '"></div>' +
    '<div><label>Max length</label><input data-field="maxLength" type="number" min="1" max="200000" value="' + escAttr(check.maxLength ?? '') + '"></div>' +
    '<div><label>Score penalty</label><input data-field="scorePenalty" type="number" min="0" max="1" step="0.05" value="' + escAttr(check.scorePenalty ?? '') + '"></div>' +
    '<button class="btn-sm danger" type="button" onclick="this.closest(\'.profile-check-row\').remove()">Remove</button>';
  checks.appendChild(row);
  row.querySelector('[data-field="severity"]').value = check.severity || 'fail';
}

async function saveProfileFromForm() {
  const status = document.getElementById('outputValidationProfilesStatus');
  try {
    const profile = collectCustomProfileForm();
    const profiles = currentCustomProfilesFromEditor().filter((item) => item.profile !== profile.profile);
    profiles.push(profile);
    writeCustomProfilesToEditor(profiles);
    await saveOutputValidationProfiles();
    renderCustomProfilePicker(profile.profile);
    markWalkthroughStep('validation');
  } catch (error) {
    if (status) status.textContent = 'Profile form needs attention: ' + (error instanceof Error ? error.message : String(error));
  }
}

function collectCustomProfileForm() {
  const profile = document.getElementById('customProfileId')?.value.trim() || '';
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(profile)) throw new Error('Profile id must look like brief-summary.');
  const checks = Array.from(document.querySelectorAll('#customProfileChecks .profile-check-row')).map(collectCustomProfileCheck).filter(Boolean);
  if (checks.length === 0) throw new Error('Add at least one check.');
  const result = {
    profile,
    label: document.getElementById('customProfileLabel')?.value.trim() || profile,
    description: document.getElementById('customProfileDescription')?.value.trim() || 'Custom deterministic output validation profile.',
    instructions: document.getElementById('customProfileInstructions')?.value.trim() || 'Satisfy the custom validation checks for this response.',
    checks,
  };
  const warnBelowScore = optionalNumberFromField('customProfileWarnBelow');
  const failBelowScore = optionalNumberFromField('customProfileFailBelow');
  if (warnBelowScore !== undefined) result.warnBelowScore = warnBelowScore;
  if (failBelowScore !== undefined) result.failBelowScore = failBelowScore;
  return result;
}

function collectCustomProfileCheck(row) {
  const value = (field) => row.querySelector('[data-field="' + field + '"]')?.value.trim() || '';
  const code = value('code');
  const message = value('message');
  if (!code && !message) return null;
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(code)) throw new Error('Each check needs a code like has-outcome.');
  if (!message) throw new Error('Each check needs a message.');
  const check = { code, severity: value('severity') || 'warn', message };
  for (const field of ['requiresAny', 'requiresAll', 'forbidsAny']) {
    const terms = value(field).split(',').map((term) => term.trim()).filter(Boolean);
    if (terms.length > 0) check[field] = terms;
  }
  for (const field of ['minLength', 'maxLength']) {
    const parsed = optionalNumberValue(value(field), 1, 200000, field);
    if (parsed !== undefined) check[field] = Math.floor(parsed);
  }
  const scorePenalty = optionalNumberValue(value('scorePenalty'), 0, 1, 'score penalty');
  if (scorePenalty !== undefined) check.scorePenalty = scorePenalty;
  return check;
}

function optionalNumberFromField(id) {
  const value = document.getElementById(id)?.value.trim() || '';
  return optionalNumberValue(value, 0, 1, id.replace('customProfile', '').replace('Below', ' below score').toLowerCase());
}

function optionalNumberValue(value, min, max, label) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(label + ' must be from ' + min + ' to ' + max + '.');
  return Math.round(parsed * 100) / 100;
}

function renderContextDetails(context) {
  const details = document.getElementById('contextDetails');
  if (!details) return;
  const configured = context.configuredMaxTokens || context.effectiveMaxTokens || 0;
  const detected = context.detectedMaxTokens || 0;
  const effective = context.effectiveMaxTokens || configured;
  details.innerHTML = '<div><strong>Configured</strong> ' + esc(configured || 'unknown') + ' tokens</div><div><strong>Detected</strong> ' + (detected ? esc(detected) + ' tokens' : 'not detected yet') + '</div><div><strong>Effective</strong> ' + esc(effective || 'unknown') + ' tokens</div>';
}

function updateSetting(k, v) {
  const request = fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [k]: v }) });
  if (k === 'ollamaHost') loadModels();
  return request;
}

const PERSONALITY_PRESETS = {
  professional: 'You are a precise, formal professional. Use structured language, clear headers, and avoid casual phrasing. Present information systematically with evidence and reasoning.',
  friendly: 'You are a warm, encouraging assistant who explains things clearly with relatable examples. Use a conversational tone, celebrate wins, and gently guide through challenges.',
  concise: 'You are extremely concise. Minimal prose. Lead with code, commands, or direct answers. Skip pleasantries. Use bullet points over paragraphs.',
  mentor: 'You are a patient mentor who teaches as you work. Explain your reasoning, point out why you chose one approach over another, and help the user learn from each interaction.',
  creative: 'You are imaginative and creative. Explore multiple approaches before settling on one. Use analogies, think outside the box, and suggest novel solutions the user might not have considered.',
  pirate: 'Arr! You be a capable and thorough AI pirate. You do the work properly and completely, but you speak like a seasoned buccaneer. Sprinkle in nautical metaphors. Call bugs "barnacles" and good code "seaworthy."',
};

function hydratePersonality(text) {
  const el = document.getElementById('personalityText');
  const sel = document.getElementById('personalityPreset');
  if (el) el.value = text;
  if (sel) {
    const match = Object.entries(PERSONALITY_PRESETS).find(([, v]) => v === text);
    sel.value = match ? match[0] : text ? 'custom' : '';
  }
}

function applyPersonalityPreset(preset) {
  const text = PERSONALITY_PRESETS[preset] || '';
  const el = document.getElementById('personalityText');
  if (el) el.value = text;
  if (preset !== 'custom') updateSetting('agentPersonality', text);
}

let currentAgentName = '';

function hydrateAgentName(name) {
  currentAgentName = name;
  const el = document.getElementById('agentNameInput');
  if (el) el.value = name;
  updateTopbarName(name);
  document.title = name ? name + ' — Ollama Agent Harness' : 'Ollama Agent Harness';
}

function updateAgentName(name) {
  currentAgentName = name.trim().slice(0, 100);
  updateSetting('agentName', currentAgentName);
  updateTopbarName(currentAgentName);
  document.title = currentAgentName ? currentAgentName + ' — Ollama Agent Harness' : 'Ollama Agent Harness';
}

function updateTopbarName(name) {
  const logo = document.getElementById('topbarLogo');
  const avatar = currentAgentAvatar || '🤖';
  if (logo) logo.textContent = name ? avatar + ' ' + name : avatar + ' Harness';
}

let currentAgentAvatar = '';

function hydrateAgentAvatar(avatar) {
  currentAgentAvatar = avatar;
  highlightAvatarPick(avatar);
  updateTopbarName(currentAgentName);
}

function setAgentAvatar(emoji) {
  currentAgentAvatar = emoji;
  updateSetting('agentAvatar', emoji);
  highlightAvatarPick(emoji);
  updateTopbarName(currentAgentName);
}

function highlightAvatarPick(active) {
  document.querySelectorAll('.avatar-pick').forEach((btn) => {
    btn.style.outline = btn.textContent.trim() === active ? '2px solid var(--accent)' : 'none';
  });
}

function getAgentAvatar() {
  return currentAgentAvatar || '🤖';
}

let agentProfiles = {};

function hydrateAgentProfiles(profiles) {
  agentProfiles = profiles || {};
  const sel = document.getElementById('profileSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Load saved profile...</option>';
  for (const name of Object.keys(agentProfiles).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = (agentProfiles[name].avatar || '🤖') + ' ' + name;
    sel.appendChild(opt);
  }
}

function saveAgentProfile() {
  const name = currentAgentName || prompt('Profile name:');
  if (!name) return;
  const model = document.getElementById('modelSelect')?.value || '';
  agentProfiles[name] = {
    name: currentAgentName,
    avatar: currentAgentAvatar,
    personality: document.getElementById('personalityText')?.value || '',
    model,
  };
  updateSetting('agentProfiles', agentProfiles);
  hydrateAgentProfiles(agentProfiles);
  alert('Profile "' + name + '" saved.');
}

function loadAgentProfile(profileName) {
  if (!profileName || !agentProfiles[profileName]) return;
  const profile = agentProfiles[profileName];
  if (profile.name) { updateAgentName(profile.name); document.getElementById('agentNameInput').value = profile.name; }
  if (profile.avatar) setAgentAvatar(profile.avatar);
  if (profile.personality !== undefined) {
    const el = document.getElementById('personalityText');
    if (el) el.value = profile.personality;
    updateSetting('agentPersonality', profile.personality);
    hydratePersonality(profile.personality);
  }
  if (profile.model) {
    const sel = document.getElementById('modelSelect');
    if (sel) { sel.value = profile.model; updateSetting('model', profile.model); }
  }
}

function deleteAgentProfile() {
  const sel = document.getElementById('profileSelect');
  const name = sel?.value;
  if (!name) { alert('Select a profile to delete.'); return; }
  if (!confirm('Delete profile "' + name + '"?')) return;
  delete agentProfiles[name];
  updateSetting('agentProfiles', agentProfiles);
  hydrateAgentProfiles(agentProfiles);
}

function exportAgentProfiles() {
  if (Object.keys(agentProfiles).length === 0) { alert('No profiles to export.'); return; }
  const blob = new Blob([JSON.stringify(agentProfiles, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agent-profiles-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
}

function importAgentProfiles(files) {
  if (!files || files.length === 0) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (typeof imported !== 'object' || imported === null) { alert('Invalid profiles file.'); return; }
      const count = Object.keys(imported).length;
      if (!confirm('Import ' + count + ' profile(s)? Existing profiles with the same name will be overwritten.')) return;
      Object.assign(agentProfiles, imported);
      updateSetting('agentProfiles', agentProfiles);
      hydrateAgentProfiles(agentProfiles);
      alert('Imported ' + count + ' profile(s).');
    } catch { alert('Invalid JSON file.'); }
  };
  reader.readAsText(files[0]);
  document.getElementById('profileImportFile').value = '';
}

function updateRoutingSetting(k, v) {
  const next = { ...currentModelRouting };
  if (k === 'confidenceEscalationThreshold' || k.endsWith('Threshold')) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) next[k] = parsed;
  } else if (String(v).trim()) {
    next[k] = String(v).trim();
  } else {
    delete next[k];
  }
  currentModelRouting = next;
  updateSetting('modelRouting', next);
}

function updateModelCatalogSetting(k, v) {
  const next = { ...currentModelCatalog };
  if (k === 'ttlHours') {
    const parsed = Number(v);
    next.ttlHours = Number.isFinite(parsed) ? Math.max(1, Math.min(720, Math.floor(parsed))) : 24;
  } else {
    next[k] = String(v || '').trim();
  }
  currentModelCatalog = next;
  updateSetting('modelCatalog', next).then(loadDiscovery);
}

function toggleExtensionExecutablePlugins(el) {
  currentExtensionActivation = { ...currentExtensionActivation, executablePlugins: !currentExtensionActivation.executablePlugins };
  if (el) el.classList.toggle('active', currentExtensionActivation.executablePlugins === true);
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function toggleExtensionPermissionReview(el) {
  currentExtensionActivation = { ...currentExtensionActivation, requirePermissionReview: currentExtensionActivation.requirePermissionReview === false };
  if (el) el.classList.toggle('active', currentExtensionActivation.requirePermissionReview !== false);
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function updateExtensionAllowedPlugins(value) {
  currentExtensionActivation = { ...currentExtensionActivation, allowedPluginNames: String(value || '').split(',').map((item) => item.trim()).filter(Boolean) };
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function updateMediaToolSetting(k, v) {
  const next = { ...currentMediaTools };
  if (String(v).trim()) next[k] = String(v).trim();
  else delete next[k];
  currentMediaTools = next;
  updateSetting('mediaTools', next);
}

let currentCuratorSettings = {};
function hydrateCuratorSettings(curator) {
  currentCuratorSettings = curator || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) { if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value; } };
  set('curatorEnabled', currentCuratorSettings.enabled);
  set('curatorIntervalHours', currentCuratorSettings.intervalHours);
  set('curatorIdleMinutes', currentCuratorSettings.idleThresholdMinutes);
  set('curatorStaleDays', currentCuratorSettings.staleDays);
  set('curatorMinViews', currentCuratorSettings.minViewsBeforeArchive);
  set('curatorMaxArchive', currentCuratorSettings.maxArchivePerRun);
  set('curatorEnableLlm', currentCuratorSettings.enableLlmPhase);
}

async function updateCuratorSetting(key, value) {
  const next = { ...currentCuratorSettings, [key]: value };
  currentCuratorSettings = next;
  const status = document.getElementById('curatorSettingsStatus');
  if (status) { status.classList.remove('initial-hidden'); status.textContent = 'Saving…'; }
  try {
    await updateSetting('curator', next);
    if (status) status.textContent = 'Saved.';
    // Refresh the Skills tab Curator panel if it is open.
    if (typeof loadSkills === 'function' && document.getElementById('curatorPanel')) loadSkills();
  } catch (error) {
    if (status) status.textContent = 'Save failed: ' + (error.message || error);
  }
}

let currentAutomationSchedulerSettings = {};
function hydrateAutomationSchedulerSettings(settings) {
  currentAutomationSchedulerSettings = settings || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) { if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value; } };
  set('automationSchedulerEnabled', currentAutomationSchedulerSettings.enabled !== false);
  set('automationSchedulerIdleMinutes', currentAutomationSchedulerSettings.idleThresholdMinutes || 2);
}

async function updateAutomationSchedulerSetting(key, value) {
  const next = { ...currentAutomationSchedulerSettings, [key]: value };
  currentAutomationSchedulerSettings = next;
  const status = document.getElementById('automationSchedulerSettingsStatus');
  if (status) { status.classList.remove('initial-hidden'); status.textContent = 'Saving…'; }
  try {
    await updateSetting('automationScheduler', next);
    if (status) status.textContent = 'Saved.';
  } catch (error) {
    if (status) status.textContent = 'Save failed: ' + (error.message || error);
  }
}

async function runUploadsCleanup() {
  const status = document.getElementById('uploadsCleanupStatus');
  const daysInput = document.getElementById('uploadsPruneDays');
  const days = Math.max(0, Math.min(3650, parseInt(daysInput?.value || '30', 10) || 0));
  if (status) {
    status.classList.remove('initial-hidden');
    status.textContent = 'Pruning uploads older than ' + days + ' day(s)…';
  }
  try {
    const response = await fetch('/api/uploads/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanDays: days }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Cleanup failed');
    const removed = Array.isArray(data.removed) ? data.removed.length : 0;
    const bytes = data.removedBytes || 0;
    if (status) status.textContent = 'Removed ' + removed + ' file(s), ' + bytes + ' bytes.';
    await loadSettings();
    await loadUploadsList();
  } catch (error) {
    if (status) status.textContent = 'Cleanup failed: ' + (error.message || error);
  }
}

async function loadUploadsList() {
  const el = document.getElementById('uploadsList');
  if (!el) return;
  el.textContent = 'Loading...';
  try {
    const response = await fetch('/api/uploads');
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) {
      el.textContent = '(no uploads in ' + (data.directory || 'uploads directory') + ')';
      return;
    }
    const totalKb = ((data.totalBytes || 0) / 1024).toFixed(1);
    let html = '<div>' + esc(data.directory || '') + ' · ' + files.length + ' file(s) · ' + totalKb + ' KB</div>';
    html += '<table class="uploads-list-table"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>';
    for (const file of files) {
      const sizeKb = (file.size / 1024).toFixed(1);
      html += '<tr><td>' + esc(file.name) + '</td><td>' + sizeKb + ' KB</td><td>' + esc(new Date(file.modified).toLocaleString()) + '</td>' +
        '<td><button class="btn-sm" onclick="deleteUpload(' + JSON.stringify(file.name).replace(/"/g, '&quot;') + ')">Delete</button></td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (error) {
    el.textContent = 'Failed to load uploads: ' + (error.message || error);
  }
}

async function deleteUpload(name) {
  if (!name) return;
  if (!confirm('Delete upload "' + name + '"?')) return;
  try {
    const response = await fetch('/api/uploads/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + response.status));
    }
    await loadUploadsList();
  } catch (error) {
    alert('Delete failed: ' + (error.message || error));
  }
}

function updateOutputValidationSetting() {
  const profile = document.getElementById('outputValidationProfile')?.value || 'oracle-prime';
  currentOutputValidation = { ...currentOutputValidation, profile };
  updateSetting('outputValidation', currentOutputValidation);
}

function toggleOutputValidation(el) {
  currentOutputValidation = { ...currentOutputValidation, enabled: !currentOutputValidation.enabled };
  if (el) el.classList.toggle('active', currentOutputValidation.enabled);
  updateSetting('outputValidation', currentOutputValidation);
}

function toggleOutputValidationAutoSelect(el) {
  currentOutputValidation = { ...currentOutputValidation, autoSelect: currentOutputValidation.autoSelect === false };
  if (el) el.classList.toggle('active', currentOutputValidation.autoSelect !== false);
  updateSetting('outputValidation', currentOutputValidation);
}

function toggleOutputValidationSkipLowSignal(el) {
  currentOutputValidation = { ...currentOutputValidation, skipOnLowSignal: !currentOutputValidation.skipOnLowSignal };
  if (el) el.classList.toggle('active', currentOutputValidation.skipOnLowSignal === true);
  updateSetting('outputValidation', currentOutputValidation);
}

async function saveOutputValidationProfiles() {
  const editor = document.getElementById('outputValidationProfilesJson');
  const status = document.getElementById('outputValidationProfilesStatus');
  if (!editor) return;
  const localValidation = validateOutputValidationProfilesEditor();
  if (!localValidation.ok) return;
  try {
    const parsed = JSON.parse(editor.value || '{"profiles":[]}');
    const response = await fetch('/api/output-validation/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
    const data = await response.json();
    if (data.error) throw new Error(data.error + renderProfileSchemaErrors(data.errors));
    currentOutputValidationProfiles = data.profiles || [];
    renderOutputValidationProfileOptions(document.getElementById('outputValidationProfile'), currentOutputValidationProfiles, currentOutputValidation.profile || 'oracle-prime');
    writeCustomProfilesToEditor(data.customProfiles || []);
    renderOutputValidationTemplates();
    if (status) status.textContent = (data.customProfiles || []).length + ' custom profiles saved to ' + (data.path || '.harness/output-validation-profiles.json') + '.';
  } catch (error) {
    if (status) status.textContent = 'Could not save profiles: ' + (error instanceof Error ? error.message : String(error));
  }
}

function downloadOutputValidationProfilesPreset() {
  const profiles = currentCustomProfilesFromEditor();
  const status = document.getElementById('outputValidationProfilesStatus');
  const payload = JSON.stringify({ profiles }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = 'output-validation-profiles.json';
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  if (status) status.textContent = profiles.length + ' custom profiles prepared for download.';
}

function importOutputValidationProfilesPreset() {
  document.getElementById('profilePresetFileInput')?.click();
}

async function handleOutputValidationProfilesPresetFile(files) {
  const status = document.getElementById('outputValidationProfilesStatus');
  const file = files && files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const profiles = Array.isArray(parsed) ? parsed : parsed.profiles;
    if (!Array.isArray(profiles)) throw new Error('Preset file must contain a profiles array.');
    writeCustomProfilesToEditor(profiles);
    const validation = validateOutputValidationProfilesEditor();
    if (!validation.ok) throw new Error(validation.errors.slice(0, 3).join(' | '));
    await saveOutputValidationProfiles();
    if (status) status.textContent = profiles.length + ' profiles imported and saved.';
  } catch (error) {
    if (status) status.textContent = 'Could not import preset: ' + (error instanceof Error ? error.message : String(error));
  } finally {
    const input = document.getElementById('profilePresetFileInput');
    if (input) input.value = '';
  }
}

function validateOutputValidationProfilesEditor() {
  const editor = document.getElementById('outputValidationProfilesJson');
  const status = document.getElementById('outputValidationProfilesStatus');
  if (!editor) return { ok: true, errors: [] };
  const errors = [];
  try {
    const parsed = JSON.parse(editor.value || '{"profiles":[]}');
    const profiles = Array.isArray(parsed) ? parsed : Array.isArray(parsed.profiles) ? parsed.profiles : null;
    if (!profiles) errors.push('profiles: expected an array or an object with a profiles array');
    else profiles.forEach((profile, profileIndex) => validateProfileEditorProfile(profile, profileIndex, errors));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (status) status.textContent = errors.length > 0 ? 'Profile schema errors: ' + errors.slice(0, 5).join(' | ') : 'Profile JSON looks valid.';
  renderCustomProfilePicker(document.getElementById('customProfilePicker')?.value || '');
  return { ok: errors.length === 0, errors };
}

function validateProfileEditorProfile(profile, profileIndex, errors) {
  if (!profile || typeof profile !== 'object') { errors.push('profiles[' + profileIndex + ']: expected an object'); return; }
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(String(profile.profile || ''))) errors.push('profiles[' + profileIndex + '].profile: invalid profile id');
  if (!Array.isArray(profile.checks) || profile.checks.length === 0) errors.push('profiles[' + profileIndex + '].checks: add at least one check');
  for (const key of ['warnBelowScore', 'failBelowScore']) {
    if (profile[key] !== undefined && (!Number.isFinite(Number(profile[key])) || Number(profile[key]) < 0 || Number(profile[key]) > 1)) errors.push('profiles[' + profileIndex + '].' + key + ': expected 0 to 1');
  }
  (profile.checks || []).forEach((check, checkIndex) => validateProfileEditorCheck(check, profileIndex, checkIndex, errors));
}

function validateProfileEditorCheck(check, profileIndex, checkIndex, errors) {
  const path = 'profiles[' + profileIndex + '].checks[' + checkIndex + ']';
  if (!check || typeof check !== 'object') { errors.push(path + ': expected an object'); return; }
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(String(check.code || ''))) errors.push(path + '.code: invalid check code');
  if (!String(check.message || '').trim()) errors.push(path + '.message: required');
  if (check.severity !== undefined && !['pass', 'warn', 'fail'].includes(check.severity)) errors.push(path + '.severity: expected pass, warn, or fail');
  for (const key of ['requiresAny', 'requiresAll', 'forbidsAny']) {
    if (check[key] !== undefined && (!Array.isArray(check[key]) || check[key].some((term) => typeof term !== 'string'))) errors.push(path + '.' + key + ': expected string array');
  }
  for (const key of ['minLength', 'maxLength']) {
    if (check[key] !== undefined && (!Number.isFinite(Number(check[key])) || Number(check[key]) < 1 || Number(check[key]) > 200000)) errors.push(path + '.' + key + ': expected 1 to 200000');
  }
  if (check.scorePenalty !== undefined && (!Number.isFinite(Number(check.scorePenalty)) || Number(check.scorePenalty) < 0 || Number(check.scorePenalty) > 1)) errors.push(path + '.scorePenalty: expected 0 to 1');
}

function renderProfileSchemaErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return ' ' + errors.slice(0, 5).map((error) => (error.path || 'profiles') + ': ' + (error.message || 'Invalid value.')).join(' | ');
}

async function checkSettingsHealth() {
  const detail = document.getElementById('settingsDoctorHealth');
  const host = document.getElementById('ollamaHost')?.value.trim() || 'http://localhost:11434';
  const visionModel = document.getElementById('visionModel')?.value.trim() || '';
  const audioTranscribeCommand = document.getElementById('audioTranscribeCommand')?.value.trim() || '';
  const audioSamplePath = document.getElementById('settingsAudioSamplePath')?.value.trim() || '';
  if (detail) {
    detail.classList.remove('initial-hidden');
    detail.textContent = 'Checking setup...';
  }
  try {
    const params = new URLSearchParams({ ollamaHost: host, visionModel, audioTranscribeCommand, audioSamplePath });
    const pdfOcrCommand = document.getElementById('pdfOcrCommand')?.value.trim() || '';
    if (pdfOcrCommand) params.set('pdfOcrCommand', pdfOcrCommand);
    const response = await fetch('/api/setup/health?' + params.toString());
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (detail) detail.innerHTML = renderSetupHealthRow('Ollama', data.ollama) + renderSetupHealthRow('Vision', data.vision) + renderSetupHealthRow('Audio', data.audio) + (data.pdfOcr ? renderSetupHealthRow('PDF OCR', data.pdfOcr) : '');
  } catch (error) {
    if (detail) detail.innerHTML = '<div><strong>Setup</strong> ' + esc(error.message || error) + '</div>';
  }
}

async function applyFirstRunSetup() {
  const status = document.getElementById('firstRunStatus');
  const host = document.getElementById('firstRunOllamaHost')?.value.trim() || 'http://localhost:11434';
  const visionModel = document.getElementById('firstRunVisionModel')?.value.trim() || '';
  const audioTranscribeCommand = document.getElementById('firstRunAudioCommand')?.value.trim() || '';
  const mediaTools = { visionModel, audioTranscribeCommand };
  if (status) status.textContent = 'Saving setup...';
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollamaHost: host, mediaTools }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    currentMediaTools = data.mediaTools || mediaTools;
    document.getElementById('ollamaHost').value = data.ollamaHost || host;
    const vision = document.getElementById('visionModel');
    const audio = document.getElementById('audioTranscribeCommand');
    const pdfOcr = document.getElementById('pdfOcrCommand');
    if (vision) vision.value = currentMediaTools.visionModel || '';
    if (audio) audio.value = currentMediaTools.audioTranscribeCommand || '';
    if (pdfOcr) pdfOcr.value = currentMediaTools.pdfOcrCommand || '';
    if (status) status.textContent = 'Saved. Models will refresh from the configured Ollama host.';
    markWalkthroughStep('setup');
    await loadModels();
  } catch (error) {
    if (status) status.textContent = 'Setup failed: ' + (error.message || error);
  }
}

async function checkFirstRunHealth() {
  const status = document.getElementById('firstRunStatus');
  const detail = document.getElementById('firstRunHealth');
  const host = document.getElementById('firstRunOllamaHost')?.value.trim() || 'http://localhost:11434';
  const visionModel = document.getElementById('firstRunVisionModel')?.value.trim() || '';
  const audioTranscribeCommand = document.getElementById('firstRunAudioCommand')?.value.trim() || '';
  const audioSamplePath = document.getElementById('firstRunAudioSamplePath')?.value.trim() || '';
  if (status) status.textContent = 'Checking setup...';
  try {
    const params = new URLSearchParams({ ollamaHost: host, visionModel, audioTranscribeCommand, audioSamplePath });
    const response = await fetch('/api/setup/health?' + params.toString());
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (detail) {
      detail.classList.remove('initial-hidden');
      detail.innerHTML = renderSetupHealthRow('Ollama', data.ollama) + renderSetupHealthRow('Vision', data.vision) + renderSetupHealthRow('Audio', data.audio) + (data.pdfOcr ? renderSetupHealthRow('PDF OCR', data.pdfOcr) : '');
    }
    if (status) status.textContent = data.ollama?.ok ? 'Setup check finished.' : 'Setup check found an Ollama connection issue.';
    markWalkthroughStep('setup');
  } catch (error) {
    if (detail) {
      detail.classList.remove('initial-hidden');
      detail.innerHTML = '<div><strong>Setup</strong> ' + esc(error.message || error) + '</div>';
    }
    if (status) status.textContent = 'Setup check failed.';
  }
}

function renderSetupHealthRow(label, result) {
  const ok = result?.ok ? '✓' : '○';
  return '<div><strong>' + esc(label) + '</strong> ' + ok + ' ' + esc(result?.message || 'not checked') + '</div>';
}

function setMode(m, el) {
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  el.classList.add('active');
  updateSetting('permissionMode', m);
}

async function enableFullAutonomy() {
  // Set dontAsk mode
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  const dontAskOption = document.querySelectorAll('.permission-mode-option')[0];
  if (dontAskOption) dontAskOption.classList.add('active');
  await updateSetting('permissionMode', 'dontAsk');

  // Enable all disabled tools
  try {
    const toolsData = await fetch('/api/tools').then((r) => r.json());
    const disabled = toolsData.disabled || [];
    for (const name of disabled) {
      await fetch('/api/tools/' + encodeURIComponent(name) + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
    }
  } catch { /* best effort */ }

  // Refresh the tools dashboard if visible
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
  alert('Full autonomy enabled. All tools unlocked. All gated capabilities will auto-grant on next chat. Kill switch (Ctrl+Shift+K) is your emergency stop.');
}

async function handleFileAttach(fileList) {
  for (const file of fileList) {
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': file.name }, body: file });
      const data = await res.json();
      if (data.error) { alert('Upload failed: ' + data.error); continue; }
      pendingFiles.push(data);
      showAttached();
    } catch (e) { alert('Upload failed: ' + e.message); }
  }
  document.getElementById('fileInput').value = '';
}

function showAttached() {
  const el = document.getElementById('attachedFiles');
  if (!pendingFiles.length) { el.style.display = 'none'; renderAttachmentHint(); return; }
  el.style.display = 'flex';
  el.innerHTML = pendingFiles.map((f, i) => {
    const streamBtn = mediaKind(f) === 'pdf'
      ? ' <button onclick="streamPdfExtract(' + i + ')" title="Stream PDF extraction" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:14px">⇩</button>'
      : '';
    return '<span title="' + escAttr(mediaKind(f)) + ' attachment" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:12px;display:flex;align-items:center;gap:4px">' + mediaIcon(f) + ' ' + esc(mediaKind(f)) + ': ' + esc(f.name) + streamBtn + ' <button onclick="removeAttached(' + i + ')" title="Remove attachment" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:14px">✕</button></span>';
  }).join('');
  renderAttachmentHint();
}

async function streamPdfExtract(index) {
  const file = pendingFiles[index];
  if (!file) return;
  const dialog = document.createElement('div');
  dialog.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';
  dialog.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;width:80%;max-width:800px;max-height:80vh;display:flex;flex-direction:column;gap:8px"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Streaming pages from ' + esc(file.name) + '</strong><button id="closePdfStream" style="background:none;border:none;color:var(--text);font-size:18px;cursor:pointer">✕</button></div><div id="pdfStreamLog" style="flex:1;overflow:auto;font-family:var(--mono);font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px"></div><div id="pdfStreamStatus" style="font-size:12px;color:var(--muted)">Connecting…</div></div>';
  document.body.appendChild(dialog);
  const log = dialog.querySelector('#pdfStreamLog');
  const status = dialog.querySelector('#pdfStreamStatus');
  const close = () => { try { source.close(); } catch {} dialog.remove(); };
  dialog.querySelector('#closePdfStream').onclick = close;
  const source = new EventSource('/api/pdf/extract?path=' + encodeURIComponent(file.path));
  let pages = 0;
  source.addEventListener('page', (e) => {
    try {
      const data = JSON.parse(e.data);
      pages++;
      const block = document.createElement('div');
      block.innerHTML = '<div style="color:var(--accent);margin-top:6px">--- Page ' + data.pageNum + ' ---</div><div style="white-space:pre-wrap">' + esc(data.text || '(empty)') + '</div>';
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
      status.textContent = 'Streamed ' + pages + ' page(s)…';
    } catch {}
  });
  source.addEventListener('done', (e) => {
    try { const data = JSON.parse(e.data); status.textContent = 'Done. ' + data.pages + ' pages.'; } catch {}
    source.close();
  });
  source.addEventListener('error', (e) => {
    let msg = 'Stream error.';
    try { msg = 'Error: ' + (JSON.parse(e.data).message || msg); } catch {}
    status.textContent = msg;
    source.close();
  });
}

function mediaKind(file) { return file.mediaKind || (file.mimeType || '').split('/')[0] || 'file'; }
function mediaIcon(file) {
  const kind = mediaKind(file);
  if (kind === 'image') return '🖼️';
  if (kind === 'audio') return '🎧';
  if (kind === 'pdf') return '📕';
  if (kind === 'data') return '▦';
  if (kind === 'text') return '¶';
  return '📄';
}
function removeAttached(i) { pendingFiles.splice(i, 1); showAttached(); }
function handleKey(e) {
  // Slash palette intercepts navigation keys when visible.
  if (slashPaletteState.visible) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashSelection(-1); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applySelectedSlashCommand(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); hideSlashPalette(); return; }
    if (e.key === 'Tab')       { e.preventDefault(); applySelectedSlashCommand(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}
function autoSize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  // Re-evaluate slash palette every keystroke so it appears as soon as the
  // user types `/` and disappears the moment the prefix becomes invalid.
  maybeShowSlashPalette(el.value);
}
function sendTip(el) { document.getElementById('chatInput').value = el.textContent; sendMessage(); }

async function sendMessage() {
  if (isSending && activeChatController) {
    activeChatController.abort();
    return;
  }
  const inp = document.getElementById('chatInput');
  let text = inp.value.trim();
  const model = document.getElementById('modelSelect').value;
  let attachmentsForTurn = [];
  if (pendingFiles.length > 0) {
    attachmentsForTurn = pendingFiles.map((f) => ({ name: f.name, path: f.path, mediaKind: mediaKind(f), size: f.size, mimeType: f.mimeType }));
    const fileInfo = pendingFiles.map((f) => '- ' + mediaKind(f) + ': name="' + f.name + '" path="' + f.path + '"').join('\n');
    const mediaConfig = '[Media tools: visionModel=' + (currentMediaTools.visionModel || model || 'not configured') + '; audioTranscribeCommand=' + (currentMediaTools.audioTranscribeCommand ? 'configured' : 'not configured') + '; pdfOcrCommand=' + (currentMediaTools.pdfOcrCommand ? 'configured' : 'not configured') + ']';
    text = (text ? text + '\n\n' : '') + '[Selected model: ' + model + ']\n' + mediaConfig + '\n[Attached files]\n' + fileInfo + '\n\nIMPORTANT: When you call file_read, pdf_read, image_analyze, or audio_transcribe for an attachment, you MUST pass the exact "path" string above (do not strip the .harness/uploads/ prefix and do not pass only the filename). Call list_uploads first if you are unsure which attachments are available. Please analyze the attached file(s). For image attachments, use image_analyze with the configured vision model when available, otherwise use the selected model if it supports vision. For audio attachments, use audio_transcribe first, then analyze the transcript. For PDF attachments, use pdf_read (and pdf_metadata when document properties matter); set ocr=true if the first read returns no extractable text. If a required media tool is not configured, say that clearly.';
    pendingFiles = [];
    showAttached();
  }

  if (!text || isSending) return;
  if (!model) { alert('Select a model first.'); return; }
  const skipOnceEl = document.getElementById('skipValidationOnce');
  const skipValidationOnce = !!(skipOnceEl && skipOnceEl.checked);
  if (!skipValidationOnce) await maybeSuggestOutputValidationProfile(text);
  lastValidationPrompt = text;
  try { localStorage.setItem(LAST_VALIDATION_PROMPT_KEY, text.slice(0, 500)); } catch {}
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
  addMsg('user', text);
  chatMessages.push({ role: 'user', content: text });
  saveChatSession();
  inp.value = '';
  inp.style.height = 'auto';
  isSending = true;
  activeChatController = new AbortController();
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = false;
  sendBtn.textContent = '■';
  sendBtn.title = 'Stop';
  const thinkEl = addThinking();
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model, skipValidation: skipValidationOnce, history: outboundChatHistory(), attachments: attachmentsForTurn }), signal: activeChatController.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let assistantText = '';
    let msgEl = null;
    let toolBox = null;
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        switch (ev.type) {
          case 'text':
            thinkEl.remove();
            if (!msgEl) msgEl = addMsg('assistant', '');
            assistantText += ev.content;
            renderMd(msgEl.querySelector('.msg-content'), assistantText);
            scrollBottom();
            break;
          case 'tool_call':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🔧', ev.call.name, JSON.stringify(ev.call.input).slice(0, 80), false);
            break;
          case 'tool_result':
            if (toolBox) appendToolItem(toolBox, ev.result.success ? '✅' : '❌', '', ev.result.output.slice(0, 120), !ev.result.success);
            refreshSkillSurfacesAfterToolResult(ev.call, ev.result, toolBox);
            break;
          case 'usage':
            // Fold per-LLM-call usage into the running session totals (topbar
            // HUD) and stash the latest values so we can paint the assistant
            // message footer once the turn finishes.
            sessionUsage.calls += 1;
            sessionUsage.promptTokens += ev.promptTokens || 0;
            sessionUsage.completionTokens += ev.completionTokens || 0;
            sessionUsage.totalDurationMs += ev.totalDurationMs || 0;
            sessionUsage.lastModel = ev.model;
            updateSessionHud();
            // Per-message footer reflects the most recent LLM call only —
            // multi-turn sequences accumulate into the topbar instead.
            currentTurnUsage = {
              model: ev.model,
              promptTokens: ev.promptTokens || 0,
              completionTokens: ev.completionTokens || 0,
              totalDurationMs: ev.totalDurationMs || 0,
            };
            break;
          case 'context':
            updateContextHud(ev.pressure, ev.strategy, ev.qualityScore, ev.autosaved);
            if (ev.strategy !== 'budget_reduction' || ev.autosaved) {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '🧠', 'context', ev.strategy + ' freed ~' + ev.tokensFreed + ' tokens' + (ev.autosaved ? ' · checkpoint saved' : ''), false);
            }
            break;
          case 'output_validation':
            toolBox = ensureToolBox(toolBox);
            appendOutputValidationItem(toolBox, ev.validation);
            break;
          case 'output_validation_profile':
            toolBox = ensureToolBox(toolBox);
            appendOutputValidationProfileItem(toolBox, ev);
            break;
          case 'history_trimmed':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '✂️', 'history trimmed', ev.droppedTurns + ' older turn(s) dropped to fit ~' + ev.historyTokenBudget + '-token budget · ' + ev.keptTurns + ' kept', false);
            break;
          case 'uploads_fallback':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'uploads fallback', (ev.tool ? ev.tool + ' ' : '') + 'requested "' + ev.requested + '" → resolved to ' + ev.resolved, false);
            break;
          case 'uploads_fallback_summary':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'uploads fallback summary', ev.suppressed + ' duplicate event(s) suppressed across ' + ev.unique + ' unique fallback(s)', false);
            break;
          case 'uploads_fallback_advice':
            toolBox = ensureToolBox(toolBox);
            appendUploadsFallbackAdvice(toolBox, ev);
            break;
          case 'error':
            thinkEl.remove();
            addMsg('assistant', '⚠️ ' + ev.message);
            break;
        }
      }
    }
    if (thinkEl.parentNode) thinkEl.remove();
    if (assistantText) chatMessages.push({ role: 'assistant', content: assistantText });
    if (msgEl && currentTurnUsage) {
      attachMessageMeta(msgEl, currentTurnUsage);
      currentTurnUsage = null;
    }
    saveChatSession();
    autoSaveChat();
    loadSettings();
  } catch (e) {
    if (thinkEl.parentNode) thinkEl.remove();
    if (e.name === 'AbortError') addMsg('assistant', 'Stopped.');
    else addMsg('assistant', '⚠️ ' + e.message);
  }
  isSending = false;
  activeChatController = null;
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('sendBtn').textContent = '➤';
  document.getElementById('sendBtn').title = 'Send';
  const skipOnceReset = document.getElementById('skipValidationOnce');
  if (skipOnceReset) skipOnceReset.checked = false;
  document.getElementById('chatInput').focus();
}

function refreshSkillSurfacesAfterToolResult(call, result, toolBox) {
  if (!result || result.success !== true || !call || !call.name) return;
  const skillMutatingTools = ['create_skill', 'promote_pattern', 'improve_skill'];
  const output = String(result.output || '');
  const wroteSkillFile = /(?:^|[\\/.])\.harness[\\/]skills[\\/].*SKILL\.md/i.test(output);
  if (!skillMutatingTools.includes(call.name) && !wroteSkillFile) return;
  loadSkills();
  loadDiscovery();
  appendOpenSkillsAction(toolBox);
}

function appendOpenSkillsAction(toolBox) {
  if (!toolBox) return;
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.innerHTML = '<span>↗</span><span class="tool-name">skill saved</span><span class="tool-detail">Available in the Skills tab.</span><button id="openSkillsAfterSaveBtn" class="btn-sm" onclick="openSkillsTab()">Open Skills</button>';
  toolBox.appendChild(item);
  scrollBottom();
}

function openSkillsTab() {
  const tab = Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('skills'"));
  if (tab) showLeftTab('skills', tab);
}

async function maybeSuggestOutputValidationProfile(text) {
  if (!currentOutputValidation.enabled || currentOutputValidation.autoSelect === false) return;
  try {
    const response = await fetch('/api/output-validation/suggest-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    const suggestion = await response.json();
    if (!suggestion.profile) return;
    currentOutputValidation = { ...currentOutputValidation, profile: suggestion.profile };
    const profileSelect = document.getElementById('outputValidationProfile');
    if (profileSelect) profileSelect.value = suggestion.profile;
    await updateSetting('outputValidation', currentOutputValidation);
  } catch {}
}

function formatOutputValidation(validation) {
  const firstFinding = validation.findings && validation.findings[0] ? ' · ' + validation.findings[0].message : '';
  return validation.profile + ' ' + validation.status + ' · score ' + validation.score + firstFinding;
}

function appendUploadsFallbackAdvice(toolBox, event) {
  const item = document.createElement('div');
  item.className = 'tool-item';
  const tools = Array.isArray(event.tools) && event.tools.length > 0 ? event.tools.join(', ') : 'a tool';
  const findingMsg = (event.message || 'Bare-filename attachment access detected.') + ' Tools affected: ' + tools + '.';
  item.innerHTML = '<span>🧪</span><span class="tool-name">attachment usage</span>' +
    '<span class="validation-groups">' +
    '<strong>uploads-fallback warn · ' + esc(String(event.unique || 0)) + ' unique</strong>' +
    '<div class="validation-group">WARN: bare-filename-attachment - ' + esc(findingMsg) + ' Try: Call list_uploads first or pass the exact .harness/uploads/ path.</div>' +
    '</span>' +
    '<span class="profile-feedback" style="margin-left:6px">' +
    '<button class="btn-sm" data-vote="dismiss" title="Acknowledge and hide this advice for this turn">Dismiss</button>' +
    '</span>';
  const dismissBtn = item.querySelector('button[data-vote="dismiss"]');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => { item.style.display = 'none'; });
  }
  toolBox.appendChild(item);
  scrollBottom();
}

function appendOutputValidationItem(toolBox, validation) {
  const item = document.createElement('div');
  item.className = 'tool-item' + (validation.status === 'fail' ? ' error' : '');
  const findings = validation.findings || [];
  const groups = ['fail', 'warn', 'pass'].map((severity) => {
    const items = findings.filter((finding) => finding.severity === severity);
    if (items.length === 0 && severity !== 'pass') return '';
    if (severity === 'pass' && findings.length > 0) return '';
    if (severity === 'pass') return '<div class="validation-group">PASS: no findings</div>';
    return '<div class="validation-group">' + severity.toUpperCase() + ': ' + items.map((finding) => esc(finding.code) + ' - ' + esc(finding.message) + (finding.suggestion ? ' Try: ' + esc(finding.suggestion) : '')).join(' · ') + '</div>';
  }).join('');
  item.innerHTML = '<span>🧪</span><span class="tool-name">output validation</span><span class="validation-groups"><strong>' + esc(validation.profile) + ' ' + esc(validation.status) + ' · score ' + esc(String(validation.score)) + '</strong>' + groups + '</span>';
  toolBox.appendChild(item);
  scrollBottom();
}

function appendOutputValidationProfileItem(toolBox, event) {
  const item = document.createElement('div');
  item.className = 'tool-item';
  const reason = event.reason || '';
  const label = /no strong signal|validation skipped/i.test(reason) ? 'Defaulted to ' : 'Auto-selected ';
  const profile = event.profile || 'default';
  const source = event.source || 'auto-selected';
  item.innerHTML = '<span>🧭</span><span class="tool-name">validation profile</span>' +
    '<span class="tool-detail">' + label + esc(profile) + '. ' + esc(reason) + '</span>' +
    '<span class="profile-feedback" style="margin-left:6px">' +
    '<button class="btn-sm" data-vote="up" title="This profile fits the prompt">👍</button>' +
    '<button class="btn-sm" data-vote="down" title="This profile does not fit the prompt">👎</button>' +
    '</span>';
  const wrapper = item.querySelector('.profile-feedback');
  if (wrapper) {
    wrapper.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => sendProfileFeedback(button, profile, button.getAttribute('data-vote'), source, reason));
    });
  }
  toolBox.appendChild(item);
  scrollBottom();
}

async function sendProfileFeedback(button, profile, vote, selectionSource, selectionReason) {
  const wrapper = button.parentElement;
  if (wrapper) wrapper.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await fetch('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, vote, selectionSource, selectionReason, prompt: lastValidationPrompt }),
    });
    if (wrapper) wrapper.innerHTML = '<span class="tool-detail">' + (vote === 'up' ? 'Thanks — recorded as good.' : 'Thanks — recorded as a miss.') + '</span>';
  } catch {
    if (wrapper) wrapper.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

function ensureToolBox(toolBox) {
  if (toolBox) return toolBox;
  const box = document.createElement('div');
  box.className = 'tool-activity';
  document.getElementById('chatArea').appendChild(box);
  return box;
}

function appendToolItem(toolBox, icon, name, detail, isError) {
  const item = document.createElement('div');
  item.className = 'tool-item' + (isError ? ' error' : '');
  item.innerHTML = '<span>' + icon + '</span>' + (name ? '<span class="tool-name">' + esc(name) + '</span>' : '') + '<span class="tool-detail">' + esc(detail) + '</span>';
  toolBox.appendChild(item);
  scrollBottom();
}

function updateContextHud(pressure, strategy, qualityScore, autosaved) {
  const pct = Math.round((pressure || 0) * 100);
  const fill = document.getElementById('contextFill');
  const label = document.getElementById('contextLabel');
  fill.style.width = Math.min(100, pct) + '%';
  fill.className = 'context-fill' + (pct > 85 ? ' hot' : pct > 65 ? ' warn' : '');
  label.textContent = 'Context ' + pct + '%' + (strategy ? ' · ' + strategy : '') + (qualityScore !== undefined ? ' · Q' + Math.round(qualityScore * 100) : '') + (autosaved ? ' · saved' : '');
}

function ensurePermissionPanel() {
  if (document.getElementById('permissionPanel')) return;
  const panel = document.createElement('div');
  panel.id = 'permissionPanel';
  panel.className = 'permission-panel hidden';
  document.querySelector('.main-panel').appendChild(panel);
}

function startPermissionPolling() {
  if (permissionPollTimer) clearInterval(permissionPollTimer);
  pollPermissions();
  permissionPollTimer = setInterval(pollPermissions, 1000);
}

async function pollPermissions() {
  try {
    const r = await fetch('/api/permissions/pending');
    const d = await r.json();
    renderPermissionPrompts(d.prompts || []);
  } catch {}
}

function renderPermissionPrompts(prompts) {
  const panel = document.getElementById('permissionPanel');
  if (!prompts.length) { panel.className = 'permission-panel hidden'; panel.innerHTML = ''; return; }
  panel.className = 'permission-panel';
  panel.innerHTML = prompts.map((prompt) => '<div class="permission-card"><div><div class="permission-title">Approve tool: ' + esc(prompt.call.name) + '</div><div class="permission-reason">' + esc(prompt.reason || 'Permission required') + '</div><code>' + esc(JSON.stringify(prompt.call.input).slice(0, 180)) + '</code></div><div class="permission-actions"><button class="btn-sm" onclick="resolvePermission(\'' + prompt.id + '\',true)">Approve</button><button class="btn-sm danger" onclick="resolvePermission(\'' + prompt.id + '\',false)">Deny</button></div></div>').join('');
}

async function resolvePermission(id, allowed) {
  await fetch('/api/permissions/' + encodeURIComponent(id) + '/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed }) });
  pollPermissions();
}

async function loadRecovery() {
  try {
    const r = await fetch('/api/sessions/recover');
    const d = await r.json();
    if (!d.sessions || !d.sessions.length) return;
    const area = document.getElementById('chatArea');
    const s = d.sessions[0];
    const banner = document.createElement('div');
    banner.className = 'recovery-banner';
    banner.innerHTML = '<span><strong>Unfinished chat available:</strong> ' + esc(s.title || s.sessionId) + ' · ' + esc(s.status || 'running') + '<br>Resume continues it. Fork starts a copy so the original stays unchanged.</span><div style="display:flex;gap:6px"><button class="btn-sm" title="Continue this session" onclick="recoverSession(\'' + escAttr(s.sessionId) + '\')">Resume chat</button><button class="btn-sm" title="Start from a copy of this session" onclick="forkSession(\'' + escAttr(s.sessionId) + '\')">Fork copy</button></div>';
    area.prepend(banner);
  } catch {}
}

async function recoverSession(id) {
  try {
    const r = await fetch('/api/sessions/' + id);
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    lastSessionId = id;
    chatMessages = [];
    document.getElementById('chatArea').innerHTML = '';
    for (const m of d.messages || []) {
      if (m.role === 'system') addMsg('assistant', m.content);
      else { addMsg(m.role, m.content); chatMessages.push({ role: m.role, content: m.content }); }
    }
    loadHistory();
  } catch (e) { alert(e.message); }
}

async function forkSession(id) {
  const model = document.getElementById('modelSelect').value;
  if (!model) { alert('Select a model first.'); return; }
  try {
    const r = await fetch('/api/sessions/' + id + '/fork', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    lastSessionId = d.sessionId;
    alert('Forked session ' + d.sessionId);
  } catch (e) { alert(e.message); }
}

function addMsg(role, text) {
  const area = document.getElementById('chatArea');
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const av = role === 'user' ? 'Y' : getAgentAvatar();
  const label = role === 'user' ? 'You' : (currentAgentName || 'Assistant');
  el.innerHTML = '<div class="msg-avatar">' + av + '</div><div class="msg-body"><div class="msg-role">' + esc(label) + '</div><div class="msg-content"></div></div>';
  if (role === 'user') el.querySelector('.msg-content').textContent = text;
  else renderMd(el.querySelector('.msg-content'), text);
  area.appendChild(el);
  scrollBottom();
  return el;
}

function renderMd(el, text) {
  if (!text) { el.innerHTML = ''; return; }
  el.innerHTML = marked.parse(text);
  el.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => { navigator.clipboard.writeText(pre.textContent.replace('Copy', '').trim()); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); };
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

function addThinking() { const area = document.getElementById('chatArea'); const el = document.createElement('div'); el.className = 'thinking'; el.innerHTML = '<div class="dots"><span></span><span></span><span></span></div> Thinking...'; area.appendChild(el); scrollBottom(); return el; }
function scrollBottom() { const a = document.getElementById('chatArea'); a.scrollTop = a.scrollHeight; }

// ─── Per-message metadata footer + session totals HUD ──────────────────
// Folds the new `usage` SSE event into a small dim footer under the
// finished assistant message and a running total in the topbar HUD.
// All accumulators reset when the user starts a new chat (`newChat`).

let sessionUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, lastModel: null };
let currentTurnUsage = null;

function resetSessionUsage() {
  sessionUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, lastModel: null };
  currentTurnUsage = null;
  updateSessionHud();
}

function formatTokensCompact(n) {
  if (!n) return '0t';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'kt';
  return n + 't';
}

function formatDurationCompact(ms) {
  if (!ms) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'm' + (s ? s + 's' : '');
}

function updateSessionHud() {
  const hud = document.getElementById('sessionHud');
  const tokensEl = document.getElementById('sessionHudTokens');
  const timeEl = document.getElementById('sessionHudTime');
  if (!hud || !tokensEl || !timeEl) return;
  const totalTokens = (sessionUsage.promptTokens || 0) + (sessionUsage.completionTokens || 0);
  tokensEl.textContent = formatTokensCompact(totalTokens);
  timeEl.textContent = formatDurationCompact(sessionUsage.totalDurationMs || 0);
  hud.classList.toggle('empty', sessionUsage.calls === 0);
  hud.title = sessionUsage.calls === 0
    ? 'Session totals (this conversation) — no LLM calls yet'
    : 'Session totals: ' + sessionUsage.calls + ' call(s) · '
      + sessionUsage.promptTokens + ' prompt tokens · '
      + sessionUsage.completionTokens + ' completion tokens · '
      + formatDurationCompact(sessionUsage.totalDurationMs)
      + (sessionUsage.lastModel ? ' · last model: ' + sessionUsage.lastModel : '');
}

function attachMessageMeta(msgEl, usage) {
  if (!msgEl || !usage) return;
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;
  // Replace any prior footer to stay idempotent if the loop somehow yields
  // a second usage event for the same message.
  const existing = body.querySelector('.msg-meta');
  if (existing) existing.remove();
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const tokensTotal = (usage.promptTokens || 0) + (usage.completionTokens || 0);
  meta.innerHTML =
    '<span class="meta-pill">' + esc(usage.model || '?') + '</span>'
    + '<span class="meta-sep">·</span>'
    + '<span title="' + (usage.promptTokens || 0) + ' prompt + ' + (usage.completionTokens || 0) + ' completion">'
    + formatTokensCompact(tokensTotal) + '</span>'
    + '<span class="meta-sep">·</span>'
    + '<span>' + formatDurationCompact(usage.totalDurationMs || 0) + '</span>';
  body.appendChild(meta);
}

// ─── Slash command palette ─────────────────────────────────────────────
// Opens when the composer's first character is `/`. Up/down to navigate,
// Enter to apply (replaces the input), Esc/Tab also work. Commands are
// declared once here and map to existing UI actions.

const SLASH_COMMANDS = [
  { cmd: '/files',       desc: 'Open the Files tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('files'); },
    fallback: '' },
  { cmd: '/skills',      desc: 'Open the Skills tab',
    apply: () => { hideSlashPalette(); openSkillsTab(); },
    fallback: '' },
  { cmd: '/memory',      desc: 'Open the Memory tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('memory'); },
    fallback: '' },
  { cmd: '/history',     desc: 'Open the History tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('history'); },
    fallback: '' },
  { cmd: '/learning',    desc: 'Open the Learning (🧠) tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('learning'); },
    fallback: '' },
  { cmd: '/discover',    desc: 'Open the Discover tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('discover'); },
    fallback: '' },
  { cmd: '/palace',      desc: 'Open the Memory Palace tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('palace'); },
    fallback: '' },
  { cmd: '/snapshots',   desc: 'Open the Snapshots tab (skills + memory backups)',
    apply: () => { hideSlashPalette(); openLeftTabByName('snapshots'); },
    fallback: '' },
  { cmd: '/rag',         desc: 'Open the Local RAG tab (build + search local indexes)',
    apply: () => { hideSlashPalette(); openLeftTabByName('rag'); },
    fallback: '' },
  { cmd: '/tools',       desc: 'Open the Local Tools dashboard (status of everything)',
    apply: () => { hideSlashPalette(); openLeftTabByName('tools'); },
    fallback: '' },
  { cmd: '/voice',       desc: 'Toggle voice input (browser STT)',
    apply: () => { hideSlashPalette(); toggleVoiceInput(); },
    fallback: '' },
  { cmd: '/new',         desc: 'Start a new chat (clears the current conversation)',
    apply: () => { hideSlashPalette(); newChat(); },
    fallback: '' },
  { cmd: '/export',      desc: 'Export the current chat as Markdown',
    apply: () => { hideSlashPalette(); exportChat(); },
    fallback: '' },
  { cmd: '/settings',    desc: 'Toggle the settings panel',
    apply: () => { hideSlashPalette(); toggleRight(); },
    fallback: '' },
  { cmd: '/stop',        desc: 'Stop the current agent run',
    apply: () => { hideSlashPalette(); if (activeChatController) activeChatController.abort(); },
    fallback: '' },
];

const slashPaletteState = { visible: false, index: 0, filtered: [] };

function maybeShowSlashPalette(value) {
  if (!value || !value.startsWith('/')) {
    if (slashPaletteState.visible) hideSlashPalette();
    return;
  }
  // Hide once the user types past the command name (a space marks args mode).
  if (value.includes(' ')) { hideSlashPalette(); return; }
  const prefix = value.toLowerCase();
  const filtered = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(prefix));
  if (filtered.length === 0) { hideSlashPalette(); return; }
  slashPaletteState.filtered = filtered;
  slashPaletteState.index = 0;
  slashPaletteState.visible = true;
  renderSlashPalette();
}

function renderSlashPalette() {
  const palette = document.getElementById('slashPalette');
  const list = document.getElementById('slashPaletteList');
  if (!palette || !list) return;
  palette.classList.remove('hidden');
  list.innerHTML = '';
  slashPaletteState.filtered.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'slash-palette-item' + (i === slashPaletteState.index ? ' active' : '');
    item.setAttribute('role', 'option');
    item.innerHTML = '<span class="sp-cmd">' + esc(c.cmd) + '</span><span class="sp-desc">' + esc(c.desc) + '</span>';
    item.onmouseenter = () => { slashPaletteState.index = i; renderSlashPalette(); };
    item.onclick = () => applySelectedSlashCommand();
    list.appendChild(item);
  });
}

function moveSlashSelection(delta) {
  if (!slashPaletteState.visible) return;
  const n = slashPaletteState.filtered.length;
  if (n === 0) return;
  slashPaletteState.index = (slashPaletteState.index + delta + n) % n;
  renderSlashPalette();
}

function applySelectedSlashCommand() {
  if (!slashPaletteState.visible) return;
  const choice = slashPaletteState.filtered[slashPaletteState.index];
  if (!choice) return;
  const inp = document.getElementById('chatInput');
  if (inp) { inp.value = choice.fallback || ''; autoSize(inp); inp.focus(); }
  try { choice.apply(); } catch (e) { console.warn('slash command failed', e); }
}

function hideSlashPalette() {
  slashPaletteState.visible = false;
  slashPaletteState.filtered = [];
  const palette = document.getElementById('slashPalette');
  if (palette) palette.classList.add('hidden');
}

function openLeftTabByName(name) {
  // Maps friendly slash-command names to (a) the dispatch key showLeftTab
  // expects and (b) a substring that uniquely identifies the tab DOM node
  // (text content or emoji). Falls back to a literal text match for
  // unknown names so adding new tabs doesn't require touching this map.
  const TAB_MAP = {
    history: { key: 'history', text: 'chats' },
    chats: { key: 'history', text: 'chats' },
    files: { key: 'files', text: 'files' },
    skills: { key: 'skills', text: 'skills' },
    memory: { key: 'memory', text: 'memory' },
    palace: { key: 'palace', text: 'palace' },
    discover: { key: 'discovery', text: 'discover' },
    discovery: { key: 'discovery', text: 'discover' },
    learning: { key: 'learning', text: 'learning' },
    snapshots: { key: 'snapshots', text: 'snaps' },
    snaps: { key: 'snapshots', text: 'snaps' },
    rag: { key: 'rag', text: 'rag' },
    tools: { key: 'tools', text: 'tools' },
  };
  const lookup = TAB_MAP[name.toLowerCase()] || { key: name, text: name.toLowerCase() };
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const tab = tabs.find((t) => (t.textContent || '').toLowerCase().includes(lookup.text.toLowerCase()));
  if (tab) showLeftTab(lookup.key, tab);
}

async function loadHistory() {
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    for (const c of d.chats || []) {
      const el = document.createElement('div');
      el.className = 'history-item' + (c.id === currentChatId ? ' active' : '');
      el.innerHTML = '<div><div class="history-title">' + esc(c.title) + '</div><div class="history-date">' + c.messageCount + ' msgs</div></div><button class="history-del" onclick="event.stopPropagation();deleteChat(\'' + c.id + '\')">🗑</button>';
      el.onclick = () => loadChat(c.id);
      list.appendChild(el);
    }
  } catch {}
}

async function loadChat(id) { try { const r = await fetch('/api/history/' + id); const d = await r.json(); currentChatId = id; chatMessages = d.messages || []; document.getElementById('chatArea').innerHTML = ''; for (const m of chatMessages) addMsg(m.role, m.content); saveChatSession(); loadHistory(); } catch {} }
async function autoSaveChat() { if (chatMessages.length < 2) return; const title = chatMessages[0].content.slice(0, 60); try { const r = await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentChatId, title, messages: chatMessages }) }); const d = await r.json(); if (!currentChatId) currentChatId = d.id; saveChatSession(); loadHistory(); } catch {} }
async function deleteChat(id) { await fetch('/api/history/' + id, { method: 'DELETE' }); if (id === currentChatId) newChat(); loadHistory(); }
function newChat() { currentChatId = null; chatMessages = []; resetSessionUsage(); saveChatSession(); document.getElementById('chatArea').innerHTML = welcomeMarkup(); renderModelCapabilityHint(); loadSettings(); loadHistory(); }
function getPersonalityGreeting(name, personalityText) {
  const p = personalityText.toLowerCase();
  if (p.includes('pirate')) return { headline: 'Ahoy! Captain ' + name + ' at yer service!', subtitle: 'Set course for yer next task, matey. I can navigate files, chart code, search the seven seas of the web, and remember every port we visit.' };
  if (p.includes('mentor')) return { headline: name + ' here — ready to learn together', subtitle: 'Ask me anything and I\'ll walk you through the reasoning. We\'ll read files, write code, and build understanding step by step.' };
  if (p.includes('concise')) return { headline: name, subtitle: 'Ready. Ask anything.' };
  if (p.includes('creative')) return { headline: 'Let\'s create something new with ' + name, subtitle: 'I love exploring possibilities. Throw me a challenge — code, research, design, or something nobody\'s tried before.' };
  if (p.includes('friendly')) return { headline: 'Hey! ' + name + ' here 👋', subtitle: 'So glad you\'re here! I can help with files, code, web searches, skills, and more. What sounds fun to work on?' };
  if (p.includes('professional')) return { headline: name + ' — Technical Assistant', subtitle: 'Select a model above, then submit your request. Capabilities include file operations, code generation, shell commands, web research, and skill management.' };
  if (name !== 'Harness') return { headline: 'Meet ' + name, subtitle: 'Pick a model above, then ask me anything. I can read files, write code, run commands, search the web, create skills, and remember things across sessions.' };
  return { headline: 'What can I help you build?', subtitle: 'Pick a model above, then ask me anything. I can read files, write code, run commands, search the web, create skills, and remember things across sessions.' };
}

function welcomeMarkup() {
  // Mirrors the redesigned hero in index.html so /new and /reset render
  // the same modern welcome card the page boots into.
  const name = currentAgentName || 'Harness';
  const personalityText = document.getElementById('personalityText')?.value || '';
  const greeting = getPersonalityGreeting(name, personalityText);
  return ''
    + '<div class="welcome" id="welcome">'
    + '<div class="welcome-hero">'
    + '<div class="welcome-eyebrow">Local-first AI agent · Ollama</div>'
    + '<h2>' + esc(greeting.headline) + '</h2>'
    + '<p>' + esc(greeting.subtitle) + '</p>'
    + '</div>'
    + '<div class="quick-suggestions">'
    + '<div class="quick-card" onclick="sendTip(this.querySelector(\'.qc-title\'))"><div class="qc-icon">📂</div><div class="qc-body"><div class="qc-title">List files in this project</div><div class="qc-desc">Tour what\'s here. I\'ll group by folder.</div></div></div>'
    + '<div class="quick-card" onclick="sendTip(this.querySelector(\'.qc-title\'))"><div class="qc-icon">🔍</div><div class="qc-body"><div class="qc-title">Search for TODO in my code</div><div class="qc-desc">Find loose ends across the whole tree.</div></div></div>'
    + '<div class="quick-card" onclick="sendTip(this.querySelector(\'.qc-title\'))"><div class="qc-icon">🐍</div><div class="qc-body"><div class="qc-title">Help me write a Python script</div><div class="qc-desc">Generate, run, and iterate locally.</div></div></div>'
    + '<div class="quick-card" onclick="sendTip(this.querySelector(\'.qc-title\'))"><div class="qc-icon">⚡</div><div class="qc-body"><div class="qc-title">Create a skill for code review</div><div class="qc-desc">Save a reusable agent capability.</div></div></div>'
    + '<div class="quick-card" onclick="openLeftTabByName(\'snapshots\')"><div class="qc-icon">📦</div><div class="qc-body"><div class="qc-title">Snapshot my skills + memory</div><div class="qc-desc">Reversible backups before risky edits.</div></div></div>'
    + '<div class="quick-card" onclick="openLeftTabByName(\'rag\')"><div class="qc-icon">🔎</div><div class="qc-body"><div class="qc-title">Index my files for semantic search</div><div class="qc-desc">Build a local RAG index in seconds.</div></div></div>'
    + '</div>'
    + '<div class="welcome-tools">'
    + '<strong>Try also:</strong>'
    + '<span class="welcome-tool-chip" onclick="openLeftTabByName(\'tools\')">🛠 Local Tools</span>'
    + '<span class="welcome-tool-chip" onclick="openLeftTabByName(\'memory\')">🧠 Memory</span>'
    + '<span class="welcome-tool-chip" onclick="openLeftTabByName(\'skills\')">⚡ Skills</span>'
    + '<span class="welcome-tool-chip" onclick="toggleVoiceInput()">🎤 Voice input</span>'
    + '<span class="welcome-tool-chip" onclick="document.getElementById(\'chatInput\').focus(); document.getElementById(\'chatInput\').value=\'/\'; autoSize(document.getElementById(\'chatInput\'));">/ slash commands</span>'
    + '</div>'
    + '<div class="model-capability-hint" id="modelCapabilityHint">Choose a model to see whether Harness detects text, image, or audio support.</div>'
    + '<details class="welcome-disclosure" id="welcomeFirstRun">'
    + '<summary>New here? Quick guided tour (2 minutes)</summary>'
    + '<div class="welcome-disclosure-body">'
    + '<div class="guided-tour" id="guidedTour" style="margin-bottom:12px">'
    + '<div class="guide-step" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--accent)">'
    + '<span style="font-size:18px;line-height:1">①</span>'
    + '<div><strong>Pick a model</strong><br>Look at the dropdown at the top of the page. Select a model (e.g. <code>llama3.2</code>). If none appear, make sure Ollama is running.</div>'
    + '</div>'
    + '<div class="guide-step" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--accent)">'
    + '<span style="font-size:18px;line-height:1">②</span>'
    + '<div><strong>Send your first message</strong><br>Type something in the box below and press Enter. Try: <a href="#" onclick="sendTip({textContent:\'What files are in this project?\'}); event.preventDefault()" style="color:var(--accent)">"What files are in this project?"</a></div>'
    + '</div>'
    + '<div class="guide-step" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--accent)">'
    + '<span style="font-size:18px;line-height:1">③</span>'
    + '<div><strong>Explore the sidebar</strong><br>Click the tabs on the left to see your <strong>Files</strong>, <strong>Skills</strong>, <strong>Memory</strong>, and <strong>Tools</strong>. Each tab shows a different part of the system.</div>'
    + '</div>'
    + '<div class="guide-step" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--accent)">'
    + '<span style="font-size:18px;line-height:1">④</span>'
    + '<div><strong>Give your agent a personality</strong><br>Open <strong>Settings</strong> (⚙ top-right) → <strong>Agent Identity</strong>. Give it a name and pick a personality. Try "Pirate" for fun!</div>'
    + '</div>'
    + '<div class="guide-step" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;padding:8px;background:var(--surface2);border-radius:8px;border-left:3px solid #50c878">'
    + '<span style="font-size:18px;line-height:1">✅</span>'
    + '<div><strong>You\'re ready!</strong><br>That\'s the basics. The agent can search the web, write code, create skills, and remember things. Just ask it in plain English.</div>'
    + '</div>'
    + '</div>'
    + '<div class="beginner-guide" id="beginnerGuide"><div class="guide-item"><strong>Ask</strong>Use plain English for project questions, code changes, searches, and local tasks.</div><div class="guide-item"><strong>Attach</strong>Drop files below. Images and audio show model support hints before you send.</div><div class="guide-item"><strong>Recover</strong>Resume continues unfinished work; Fork starts a copy for a different direction.</div></div>'
    + '<div class="walkthrough-checklist" id="walkthroughChecklist">' + walkthroughChecklistMarkup() + '</div>'
    + '<div class="first-run-setup" id="firstRunSetup"><h3>First-run setup</h3><p>Set the local Ollama host and optional media helpers before your first chat.</p><div class="first-run-grid"><div><label for="firstRunOllamaHost">Ollama host</label><input id="firstRunOllamaHost" type="text" value="http://localhost:11434"></div><div><label for="firstRunVisionModel">Vision model</label><input id="firstRunVisionModel" type="text" placeholder="llava"></div><div><label for="firstRunAudioCommand">Audio command</label><input id="firstRunAudioCommand" type="text" placeholder="whisper &quot;{input}&quot; --model base"></div><div><label for="firstRunAudioSamplePath">Audio test file</label><input id="firstRunAudioSamplePath" type="text" placeholder=".harness/uploads/sample.wav"></div></div><div class="first-run-actions"><button class="btn-sm" onclick="applyFirstRunSetup()">Save setup</button><button class="btn-sm" onclick="checkFirstRunHealth()">Check setup</button><span class="first-run-status" id="firstRunStatus">Optional. You can change these later in Settings.</span></div><div class="trace-detail initial-hidden" id="firstRunHealth"></div></div>'
    + '</div>'
    + '</details>'
    + '</div>';
}
function exportChat() { if (!chatMessages.length) { alert('No messages.'); return; } let md = '# Chat Export\n\n'; for (const m of chatMessages) md += '## ' + (m.role === 'user' ? 'You' : 'Assistant') + '\n\n' + m.content + '\n\n---\n\n'; const blob = new Blob([md], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chat-' + new Date().toISOString().slice(0, 10) + '.md'; a.click(); }

async function loadFiles(dir) {
  try {
    const url = '/api/files' + (dir ? '?path=' + encodeURIComponent(dir) : '');
    const r = await fetch(url);
    const d = await r.json();
    const tree = document.getElementById('fileTree');
    tree.innerHTML = '';
    if (dir) { const up = document.createElement('div'); up.className = 'file-item'; up.innerHTML = '<span class="file-icon">⬆</span> ..'; up.onclick = () => loadFiles(d.cwd.split(/[\\/]/).slice(0, -1).join('/')); tree.appendChild(up); }
    for (const item of d.items || []) { const el = document.createElement('div'); el.className = 'file-item'; el.innerHTML = '<span class="file-icon">' + (item.type === 'dir' ? '📁' : '📄') + '</span>' + esc(item.name); el.onclick = () => { if (item.type === 'dir') loadFiles(item.path); else { document.getElementById('chatInput').value = 'Read the file ' + item.name; sendMessage(); } }; tree.appendChild(el); }
  } catch {}
}

async function loadSkills() { try { const r = await fetch('/api/skills'); const d = await r.json(); const usageR = await fetch('/api/skills/usage').then((r) => r.json()).catch(() => ({ records: [] })); const curatorR = await fetch('/api/curator').then((r) => r.json()).catch(() => null); const usageMap = new Map((usageR.records || []).map((rec) => [rec.name, rec])); const list = document.getElementById('skillList'); list.innerHTML = ''; const runtime = (d.sources || []).find((source) => source.source === 'runtime') || { skills: d.skills || [], diagnostics: [], mutable: true }; const repo = (d.sources || []).find((source) => source.source === 'repo') || { skills: [], diagnostics: [], mutable: false }; let html = renderCuratorPanel(curatorR); html += renderSkillAutomationPanel(runtime, repo); html += '<div id="runtimeSkillSource" class="trace-list"><div class="trace-title">Runtime Skills</div>'; if (!runtime.skills || !runtime.skills.length) html += '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No runtime skills yet.<br><br>Ask the agent to <strong>"create a skill for..."</strong> and it will build one automatically.</div>'; else html += runtime.skills.map((s) => renderRuntimeSkillItem(s, usageMap.get(s.name))).join(''); html += '</div>' + renderSkillDiagnostics(runtime.diagnostics || []); html += '<div id="repoSkillSource" class="trace-list"><div class="trace-title">Repo Skills</div>' + ((repo.skills || []).length ? repo.skills.map(renderRepoSkillItem).join('') : '<div class="trace-meta">No repo skills found in .github/skills.</div>') + '</div>'; list.innerHTML = html; if (curatorR && curatorR.proposals) loadCuratorProposals(); } catch {} }

function renderSkillAutomationPanel(runtime, repo) {
  const runtimeSkipped = (runtime.diagnostics || []).length;
  const repoAvailable = (repo.skills || []).length;
  return '<div id="skillAutomationPanel" class="trace-item" style="margin-bottom:8px">'
    + '<div class="trace-title">Skill automation</div>'
    + '<div class="trace-meta">Checks ' + repoAvailable + ' repo skill(s) and ' + runtimeSkipped + ' runtime diagnostic(s). Missing repo skills are installed; missing runtime SKILL.md files get starter scaffolds.</div>'
    + '<button class="btn-sm full-width-button" onclick="runSkillAutomation()">Auto repair and install skills</button>'
    + '<div id="skillAutomationResult" class="trace-meta"></div>'
    + '</div>';
}

function renderRuntimeSkillItem(s, usage) {
  const u = usage || {};
  const id = s.id || s.name;
  const pinned = u.pinned ? ' 📌' : '';
  const archived = u.archived ? ' <span class="capability-pill" style="border-color:#888;color:#888">archived</span>' : '';
  const useInfo = (u.useCount || u.viewCount) ? ' · used ' + (u.useCount || 0) + ' / viewed ' + (u.viewCount || 0) : '';
  const lastUsed = u.lastUsedAt ? ' · last ' + new Date(u.lastUsedAt).toLocaleDateString() : '';
  const pinBtn = '<button class="sk-install" onclick="event.stopPropagation();togglePinSkill(\'' + escAttr(s.name) + '\', ' + (!u.pinned) + ')" title="' + (u.pinned ? 'Unpin' : 'Pin (curator will not archive)') + '">' + (u.pinned ? 'Unpin' : 'Pin') + '</button>';
  return '<div class="skill-item" onclick="useSkillFromList(\'' + escAttr(s.name) + '\')"><div class="sk-name">' + esc(s.name) + pinned + '</div><div class="sk-desc">' + esc(s.description) + '</div><div class="sk-meta"><span>' + esc(s.domain) + useInfo + lastUsed + archived + '</span><span>' + pinBtn + ' <button class="sk-del" onclick="event.stopPropagation();deleteSkill(\'' + escAttr(id) + '\')">🗑</button></span></div></div>';
}

async function togglePinSkill(name, pinned) {
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(name) + '/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
    const data = await r.json();
    if (data.error) { alert('Pin failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { alert('Pin failed: ' + (error.message || error)); }
}

function renderCuratorPanel(curator) {
  if (!curator) return '';
  const settings = curator.settings || {};
  const enabled = settings.enabled;
  const stateBadge = enabled
    ? '<span class="rag-backend-badge" style="background:rgba(80,200,120,.12);border-color:#50c878;color:#50c878">curator: on</span>'
    : '<span class="rag-backend-badge">curator: off</span>';
  const lastRun = settings.lastRunAt ? new Date(settings.lastRunAt).toLocaleString() : 'never';
  const lastActivity = curator.lastUserActivityAt ? new Date(curator.lastUserActivityAt).toLocaleString() : '?';
  const runningBadge = curator.schedulerRunning ? ' <span class="capability-pill" style="border-color:#5bb0ff;color:#5bb0ff">scheduler running</span>' : '';
  const recentLog = (curator.log || []).slice(-5).reverse().map((entry) => '<div class="trace-meta" style="font-size:10px">' + esc(JSON.stringify(entry)) + '</div>').join('');
  const proposalsBlock = curator.proposals
    ? '<div id="curatorProposalsContainer" style="margin-top:6px"><div class="trace-meta">LLM merge proposals available — loading…</div></div>'
    : '';
  const archived = Array.isArray(curator.archived) ? curator.archived : [];
  const archivedBlock = archived.length === 0 ? '' : '<details style="margin-top:6px"><summary class="trace-meta" style="cursor:pointer">📦 Archived skills (' + archived.length + ')</summary><div style="margin-top:4px">'
    + archived.map((name) => '<div class="trace-row" style="display:flex;align-items:center;gap:6px;padding:4px 0"><span style="flex:1">' + esc(name) + '</span><button class="btn-sm" onclick="restoreArchivedSkill(\'' + escAttr(name) + '\')">Restore</button></div>').join('')
    + '</div></details>';
  return '<div id="curatorPanel" class="trace-item" style="margin-bottom:8px">'
    + '<div class="trace-title">🧹 Skill Curator ' + stateBadge + runningBadge + '</div>'
    + '<div class="trace-meta">Maintenance every ' + (settings.intervalHours || 168) + 'h after ' + (settings.idleThresholdMinutes || 120) + ' min idle. Last run: ' + esc(lastRun) + '. Last activity: ' + esc(lastActivity) + '.</div>'
    + '<div class="trace-meta">Stale threshold: ' + (settings.staleDays || 60) + ' days · max archive/run: ' + (settings.maxArchivePerRun || 5) + ' · LLM phase: ' + (settings.enableLlmPhase ? 'on' : 'off') + '</div>'
    + '<div class="inline-actions" style="margin-top:6px">'
    +   '<button class="btn-sm" onclick="curatorPreview()">Preview</button> '
    +   '<button class="btn-sm" onclick="curatorRunNow()">Run now</button> '
    +   '<button class="btn-sm" onclick="curatorToggle(' + (!enabled) + ')">' + (enabled ? 'Disable' : 'Enable') + ' scheduler</button>'
    + '</div>'
    + '<div id="curatorPreviewOutput" style="margin-top:6px"></div>'
    + archivedBlock
    + (recentLog ? '<details style="margin-top:6px"><summary class="trace-meta" style="cursor:pointer">Recent log</summary>' + recentLog + '</details>' : '')
    + proposalsBlock
    + '</div>';
}

async function restoreArchivedSkill(name) {
  if (!confirm('Restore archived skill "' + name + '" back to the runtime library?')) return;
  try {
    const response = await fetch('/api/curator/restore/' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (data.error) { alert('Restore failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { alert('Restore failed: ' + (error.message || error)); }
}

async function curatorPreview() {
  const out = document.getElementById('curatorPreviewOutput');
  if (out) out.textContent = 'Previewing…';
  try {
    const r = await fetch('/api/curator/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (data.error) { if (out) out.textContent = 'Preview failed: ' + data.error; return; }
    if (out) out.innerHTML = renderCuratorSummary(data.summary);
  } catch (error) { if (out) out.textContent = 'Preview failed: ' + (error.message || error); }
}

async function curatorRunNow() {
  if (!confirm('Run the curator now? This may archive stale, unpinned skills.')) return;
  const out = document.getElementById('curatorPreviewOutput');
  if (out) out.textContent = 'Running curator…';
  try {
    const r = await fetch('/api/curator/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (data.error) { if (out) out.textContent = 'Run failed: ' + data.error; return; }
    if (out) out.innerHTML = renderCuratorSummary(data.summary);
    setTimeout(loadSkills, 600);
  } catch (error) { if (out) out.textContent = 'Run failed: ' + (error.message || error); }
}

async function curatorToggle(enable) {
  try {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ curator: { enabled: enable } }) });
    await loadSkills();
  } catch (error) { alert('Toggle failed: ' + (error.message || error)); }
}

function renderCuratorSummary(summary) {
  if (!summary) return '<div class="trace-meta">(no summary)</div>';
  const candidates = (summary.staleCandidates || []).map((a) => '<div class="trace-meta" style="font-size:11px">' + esc(a.kind) + ' · ' + esc(a.skill) + ' · ' + esc(a.reason) + '</div>').join('');
  const archived = (summary.archived || []).map((a) => '<div class="trace-meta" style="font-size:11px;color:#ffb050">' + esc(a.kind) + ' · ' + esc(a.skill) + ' · ' + esc(a.reason) + '</div>').join('');
  const dryBadge = summary.dryRun ? ' <span class="capability-pill">dry-run</span>' : '';
  const llmNote = summary.llmSkipped ? '<div class="trace-meta">LLM phase skipped: ' + esc(summary.llmSkipped) + '</div>' : '';
  return '<div class="trace-item" style="background:var(--surface)"><div class="trace-title">Curator summary' + dryBadge + '</div>'
    + '<div class="trace-meta">' + (summary.staleCandidates?.length || 0) + ' candidate(s), ' + (summary.archived?.length || 0) + ' archived</div>'
    + (archived ? '<div style="margin-top:4px">' + archived + '</div>' : '')
    + (candidates ? '<details style="margin-top:4px"><summary class="trace-meta" style="cursor:pointer">All candidates</summary>' + candidates + '</details>' : '')
    + llmNote
    + '</div>';
}

async function loadCuratorProposals() {
  const container = document.getElementById('curatorProposalsContainer');
  if (!container) return;
  try {
    const data = await fetch('/api/curator/proposals').then((r) => r.json());
    const proposals = data.proposals || [];
    if (proposals.length === 0) {
      container.innerHTML = '<div class="trace-meta">LLM proposals file present but no parseable clusters. <button class="btn-sm" onclick="dismissCuratorProposals()">Clear</button></div>';
      return;
    }
    const rows = proposals.map((p, i) => {
      const skillList = p.mergeSkills.map(esc).join(', ');
      const rationale = p.rationale ? '<div class="trace-meta">' + esc(p.rationale) + '</div>' : '';
      return '<div class="trace-item">'
        + '<div class="trace-title">Cluster: ' + esc(p.heading) + '</div>'
        + '<div class="trace-meta">Merge: ' + skillList + '</div>'
        + (p.proposedDescription ? '<div class="trace-meta">' + esc(p.proposedDescription) + '</div>' : '')
        + rationale
        + '<div class="inline-actions" style="margin-top:6px">'
        +   '<button class="btn-sm" onclick="applyCuratorProposal(' + i + ', true)">Preview</button> '
        +   '<button class="btn-sm primary" onclick="applyCuratorProposal(' + i + ', false)">Apply merge</button>'
        + '</div>'
        + '<div class="trace-meta" id="curatorProposalResult' + i + '"></div>'
        + '</div>';
    }).join('');
    container.innerHTML = '<div class="trace-title" style="padding:0 4px">🧪 LLM Merge Proposals (' + proposals.length + ')</div>'
      + '<div class="trace-list">' + rows + '</div>'
      + '<div class="inline-actions" style="margin-top:4px"><button class="btn-sm" onclick="dismissCuratorProposals()">Dismiss all</button></div>';
    window._curatorProposals = proposals;
  } catch (error) {
    container.innerHTML = '<div class="trace-meta">Failed to load proposals: ' + esc(error.message || error) + '</div>';
  }
}

async function applyCuratorProposal(index, dryRun) {
  const proposal = (window._curatorProposals || [])[index];
  if (!proposal) return;
  const result = document.getElementById('curatorProposalResult' + index);
  if (!dryRun && !confirm('Apply merge "' + proposal.heading + '"? This writes a new umbrella skill and archives ' + proposal.mergeSkills.length + ' source skill(s).')) return;
  if (result) result.textContent = dryRun ? 'Previewing…' : 'Applying…';
  try {
    const response = await fetch('/api/curator/proposals/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal, dryRun }),
    });
    const data = await response.json();
    if (data.error) { if (result) result.textContent = 'Failed: ' + data.error; return; }
    const r = data.result;
    if (result) {
      result.textContent = (dryRun ? '[preview] ' : '') + 'umbrella=' + r.umbrellaName + ' · archived=' + r.archived.length + (r.skipped.length ? ' · skipped (pinned)=' + r.skipped.join(', ') : '');
    }
    if (!dryRun) setTimeout(loadSkills, 600);
  } catch (error) {
    if (result) result.textContent = 'Failed: ' + (error.message || error);
  }
}

async function dismissCuratorProposals() {
  if (!confirm('Clear all current LLM merge proposals?')) return;
  try {
    await fetch('/api/curator/proposals', { method: 'DELETE' });
    await loadSkills();
  } catch (error) { alert('Dismiss failed: ' + (error.message || error)); }
}
function renderRepoSkillItem(s) { const id = s.id || s.name; return '<div class="skill-item"><div class="sk-name">' + esc(s.name) + '</div><div class="sk-desc">' + esc(s.description) + '</div><div class="sk-meta"><span>' + esc(s.domain || 'repo') + '</span><span>read-only</span><button class="sk-install" onclick="installRepoSkill(\'' + escAttr(id) + '\', \'' + escAttr(s.name) + '\')">Install to runtime</button></div></div>'; }
function renderSkillDiagnostics(diagnostics) { if (!diagnostics || diagnostics.length === 0) return '<div id="skillDiagnostics" class="trace-list"><div class="trace-title">Skill Diagnostics</div><div class="trace-meta">No skipped runtime skill folders.</div></div>'; return '<div id="skillDiagnostics" class="trace-list"><div class="trace-title">Skill Diagnostics</div>' + diagnostics.map((item) => '<div class="trace-item"><div class="trace-title">' + esc(item.name) + '</div><div class="trace-meta">' + esc(item.reason) + ' · ' + esc(item.message) + '</div><div class="trace-meta">' + esc(item.filePath) + '</div>' + renderSkillDiagnosticActions(item) + '</div>').join('') + '</div>'; }
function renderSkillDiagnosticActions(item) { const actions = ['<button class="btn-sm" onclick="copySkillDiagnosticPath(\'' + escAttr(item.filePath) + '\')">Copy path</button>']; if (item.reason === 'missing-skill-file') actions.push('<button class="btn-sm" onclick="scaffoldSkill(\'' + escAttr(item.name) + '\')">Create starter SKILL.md</button>'); return '<div class="skill-diagnostic-actions">' + actions.join(' ') + '</div>'; }
function useSkillFromList(name) { document.getElementById('chatInput').value = 'Use the skill: ' + name; sendMessage(); }
async function deleteSkill(name) { if (!confirm('Delete skill "' + name + '"?')) return; await fetch('/api/skills/' + name, { method: 'DELETE' }); loadSkills(); }
async function installRepoSkill(id, displayName) {
  const label = displayName || id;
  if (!confirm('Install repo skill "' + label + '" into runtime .harness/skills?')) return;
  try {
    let response = await fetch('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: id }) });
    if (response.status === 409) {
      if (!confirm('Runtime skill "' + label + '" already exists. Overwrite it?')) return;
      response = await fetch('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: id, overwrite: true }) });
    }
    const data = await response.json();
    if (data.error) { alert('Install failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { alert('Install failed: ' + (error.message || error)); }
}
async function runSkillAutomation() {
  if (!confirm('Run skill automation now? It installs missing repo skills and scaffolds runtime folders missing SKILL.md. Existing skills are skipped.')) return;
  const out = document.getElementById('skillAutomationResult');
  if (out) out.textContent = 'Running skill automation...';
  try {
    const response = await fetch('/api/skills/automation/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (data.error) { if (out) out.textContent = 'Automation failed: ' + data.error; return; }
    const installed = (data.installed || []).length;
    const scaffolded = (data.scaffolded || []).length;
    const skipped = (data.skipped || []).length;
    if (out) out.textContent = 'Installed ' + installed + ', scaffolded ' + scaffolded + ', skipped ' + skipped + '.';
    await loadSkills();
  } catch (error) { if (out) out.textContent = 'Automation failed: ' + (error.message || error); }
}
async function scaffoldSkill(name) {
  if (!confirm('Create a starter SKILL.md for "' + name + '"?')) return;
  try {
    const response = await fetch('/api/skills/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (data.error) { alert('Scaffold failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { alert('Scaffold failed: ' + (error.message || error)); }
}
function copySkillDiagnosticPath(filePath) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(filePath).catch(() => {});
}

async function loadMemory() { try { const r = await fetch('/api/memory'); const d = await r.json(); const view = document.getElementById('memoryView'); if (!d.decisions && !d.patterns && !d.notes) { view.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No memories yet.<br><br>The agent saves decisions, patterns, and notes here as it learns.</div>'; return; } let html = ''; if (d.decisions) html += '<div class="mem-section"><h5>Decisions</h5><pre>' + esc(d.decisions) + '</pre></div>'; if (d.patterns) html += '<div class="mem-section"><h5>Patterns</h5><pre>' + esc(d.patterns) + '</pre></div>'; if (d.notes) html += '<div class="mem-section"><h5>Notes</h5><pre>' + esc(d.notes) + '</pre></div>'; view.innerHTML = html; } catch {} }

async function loadMemoryPalace() { try { const response = await fetch('/api/memory/palace'); const data = await response.json(); const view = document.getElementById('memoryPalaceView'); if (!data.rooms || !data.rooms.length) { view.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No palace rooms yet.</div>'; return; } view.innerHTML = '<div class="palace-grid">' + data.rooms.map((room) => '<div class="palace-room"><div class="palace-title">' + esc(room.title) + '</div><div class="palace-meta">' + room.entryCount + ' memories · ' + room.sessions.length + ' sessions</div>' + room.anchors.map((anchor) => '<button class="palace-anchor" onclick="loadPalaceEntry(\'' + escAttr(anchor.id) + '\')"><strong>' + esc(anchor.kind) + '</strong> · ' + esc(anchor.text) + '</button>').join('') + '</div>').join('') + '</div><div id="palaceDetail" class="palace-detail initial-hidden"></div>'; } catch (error) { document.getElementById('memoryPalaceView').textContent = error.message; } }

async function loadDiscovery() { const view = document.getElementById('discoveryView'); if (!view) return; view.innerHTML = '<div class="trace-meta">Loading discovery...</div>'; try { const response = await fetch('/api/discovery'); const data = await response.json(); if (data.error) throw new Error(data.error); view.innerHTML = renderDiscoveryPanel(data); } catch (error) { view.innerHTML = '<div class="trace-meta">Discovery unavailable: ' + esc(error.message || error) + '</div>'; } }

function renderDiscoveryPanel(data) {
  return '<div id="discoveryPanel" class="trace-list">' + renderModelCatalogPanel(data.modelCatalog || {}) + renderExtensionDiscoveryPanel(data.extensions || {}) + renderAutomationDiscoveryPanel(data.automations || {}) + renderSessionSearchDiscoveryPanel(data.sessionSearch || {}) + renderCuratorDiscoveryPanel(data.curator || {}) + '</div>';
}

function renderCuratorDiscoveryPanel(curator) {
  const enabled = curator.enabled;
  const stateColor = enabled ? '#50c878' : '#888';
  const lastRun = curator.lastRunAt ? new Date(curator.lastRunAt).toLocaleString() : 'never';
  const events = (curator.recentEvents || []).slice(-5).reverse();
  const eventsRows = events.map((e) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '?';
    const phase = esc(e.phase || 'curator');
    const action = e.action ? ' · ' + esc(e.action) : '';
    const skill = e.skill ? ' · ' + esc(e.skill) : '';
    const note = e.error ? ' · err: ' + esc(e.error) : e.umbrella ? ' · umbrella: ' + esc(e.umbrella) : '';
    return '<div class="trace-meta" style="font-size:11px">' + esc(ts) + ' · ' + phase + action + skill + note + '</div>';
  }).join('');
  return '<div id="curatorDiscoveryPanel" class="trace-item">'
    + '<div class="trace-title">Skill Curator <span class="capability-pill" style="border-color:' + stateColor + ';color:' + stateColor + '">' + (enabled ? 'enabled' : 'disabled') + '</span>' + (curator.schedulerRunning ? ' <span class="capability-pill" style="border-color:#5bb0ff;color:#5bb0ff">running</span>' : '') + '</div>'
    + '<div class="trace-meta">Interval: ' + (curator.intervalHours || 168) + 'h · Idle threshold: ' + (curator.idleThresholdMinutes || 120) + ' min · Last run: ' + esc(lastRun) + '</div>'
    + (eventsRows ? '<div style="margin-top:6px">' + eventsRows + '</div>' : '<div class="trace-meta">No curator events yet.</div>')
    + '<button class="btn-sm full-width-button" onclick="openLeftTabByName(\'skills\')">Open Skills tab</button>'
    + '</div>';
}

function renderModelCatalogPanel(modelCatalog) {
  const manifest = modelCatalog.manifest || { providers: {} };
  const status = modelCatalog.status || {};
  const providers = Object.entries(manifest.providers || {}).map(([name, provider]) => '<div class="trace-row"><strong>' + esc(name) + '</strong><div class="trace-meta">' + (provider.models || []).length + ' model(s)</div>' + (provider.models || []).slice(0, 5).map((model) => '<div class="trace-meta">' + esc(model.id) + ' · ' + esc(model.description || '') + '</div>').join('') + '</div>').join('');
  return '<div id="modelCatalogPanel" class="trace-item"><div class="trace-title">Model Catalog</div><div class="trace-meta">' + esc(status.exists ? (status.fresh ? 'cached and fresh' : 'cached but stale') : 'using built-in catalog') + '</div>' + (providers || '<div class="trace-meta">No catalog providers found.</div>') + '<button class="btn-sm full-width-button" onclick="refreshModelCatalog()">Refresh catalog</button></div>';
}

function renderExtensionDiscoveryPanel(extensions) {
  const manifests = extensions.manifests || [];
  const rows = manifests.map((manifest) => '<div class="trace-row"><strong>' + esc(manifest.kind) + ': ' + esc(manifest.name) + '</strong><div class="trace-meta">' + esc(manifest.description || manifest.filePath || '') + '</div><div class="trace-meta">Activation: ' + esc(manifest.activation?.status || 'unknown') + ' · ' + esc(manifest.activation?.reason || '') + '</div>' + renderInlineList('Tools', manifest.providesTools) + renderInlineList('Hooks', manifest.providesHooks) + renderInlineList('Triggers', manifest.triggers) + '</div>').join('');
  const skills = extensions.skills || {};
  const runtimeSummary = skills.runtime ? '<div class="trace-meta">Runtime skills: ' + (skills.runtime.total || 0) + ' loaded · ' + (skills.runtime.diagnosticCount || 0) + ' skipped</div>' : '';
  const repoSummary = skills.repo ? '<div class="trace-meta">Repo skills: ' + (skills.repo.total || 0) + ' available · ' + (skills.repo.diagnosticCount || 0) + ' malformed</div>' : '';
  const diagnosticRows = renderDiscoverySkillDiagnostics(skills);
  const skillsAction = (skills.runtime || skills.repo) ? '<button class="btn-sm full-width-button" onclick="openSkillsTab()">Open Skills tab</button>' : '';
  return '<div id="extensionDiscoveryPanel" class="trace-item"><div class="trace-title">Extensions</div><div class="trace-meta">' + manifests.length + ' manifest(s) discovered</div>' + runtimeSummary + repoSummary + diagnosticRows + (rows || '<div class="trace-meta">No extension manifests found.</div>') + skillsAction + '</div>';
}

function renderDiscoverySkillDiagnostics(skills) {
  const sources = skills.sources || [];
  const diagnostics = sources.flatMap((source) => (source.diagnostics || []).map((item) => ({ ...item, source: source.source })));
  if (diagnostics.length === 0) return '<div class="trace-meta">Skill diagnostics: clean.</div>';
  const rows = diagnostics.slice(0, 5).map((item) => '<div class="trace-meta" style="font-size:11px">' + esc(item.source || 'skills') + ' · ' + esc(item.name) + ' · ' + esc(item.reason) + '</div>').join('');
  const more = diagnostics.length > 5 ? '<div class="trace-meta">+' + (diagnostics.length - 5) + ' more diagnostic(s) in the Skills tab.</div>' : '';
  return '<details style="margin:6px 0"><summary class="trace-meta" style="cursor:pointer">Skill diagnostics (' + diagnostics.length + ')</summary>' + rows + more + '</details>';
}

function renderAutomationDiscoveryPanel(automations) {
  const due = automations.due || [];
  const rows = due.slice(0, 8).map((job) => '<div class="trace-row"><strong>' + esc(job.name) + '</strong><div class="trace-meta">' + esc(job.schedule?.display || '') + ' · next ' + esc(job.nextRunAt || '') + '</div></div>').join('');
  return '<div id="automationDiscoveryPanel" class="trace-item"><div class="trace-title">Automations</div><div class="trace-meta">' + (automations.total || 0) + ' job(s), ' + due.length + ' due</div>' + (rows || '<div class="trace-meta">No due automations.</div>') + '</div>';
}

function renderSessionSearchDiscoveryPanel(status) {
  return '<div id="sessionSearchDiscoveryPanel" class="trace-item"><div class="trace-title">Session Search Index</div><div class="trace-meta">' + esc(status.exists ? (status.fresh ? 'fresh' : 'stale') : 'not built') + ' · ' + (status.entryCount || 0) + ' entries · ' + (status.sessionCount || 0) + ' sessions</div><div class="trace-meta">Last rebuilt: ' + esc(status.rebuiltAt || 'never') + '</div><button id="rebuildSessionSearchIndexBtn" class="btn-sm full-width-button" onclick="rebuildSessionSearchIndex()">Rebuild search index</button></div>';
}

function renderInlineList(label, values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  return list.length ? '<div class="trace-meta">' + esc(label) + ': ' + esc(list.join(', ')) + '</div>' : '';
}

async function refreshModelCatalog() { const status = document.getElementById('modelCatalogSettingsStatus'); if (status) status.textContent = 'Refreshing catalog...'; try { const response = await fetch('/api/models/catalog/refresh', { method: 'POST' }); const data = await response.json(); if (data.error) throw new Error(data.error); if (status) status.textContent = 'Catalog refreshed: ' + Object.keys(data.manifest?.providers || {}).length + ' provider(s).'; await loadDiscovery(); } catch (error) { if (status) status.textContent = 'Catalog refresh failed: ' + (error.message || error); } }

async function rebuildSessionSearchIndex() { const view = document.getElementById('sessionSearchDiscoveryPanel'); if (view) view.querySelector('.trace-meta').textContent = 'Rebuilding search index...'; try { const response = await fetch('/api/sessions/search-index/rebuild', { method: 'POST' }); const data = await response.json(); if (data.error) throw new Error(data.error); await loadDiscovery(); } catch (error) { alert('Search index rebuild failed: ' + (error.message || error)); } }

async function loadPalaceEntry(id) { const detail = document.getElementById('palaceDetail'); if (!detail) return; detail.classList.remove('initial-hidden'); detail.textContent = 'Loading memory entry...'; try { const entryResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id)); const entryData = await entryResponse.json(); if (entryData.error) { detail.textContent = entryData.error; return; } const contextResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id) + '/context?window=3'); const contextData = await contextResponse.json(); const entry = entryData.entry; const transcriptRows = (contextData.events || []).map((event) => '<div class="transcript-row' + (event.isAnchor ? ' anchor' : '') + '"><div><strong>' + esc(event.kind) + '</strong> · ' + esc(event.timestamp) + '</div><div style="white-space:pre-wrap;color:var(--text)">' + esc(event.text || '[empty]') + '</div></div>').join(''); detail.innerHTML = '<div><strong>Session</strong> ' + esc(entry.sessionId) + '</div><div><strong>Event</strong> ' + esc(entry.id) + '</div><div><strong>Kind</strong> ' + esc(entry.kind) + '</div><div><strong>Time</strong> ' + esc(entry.timestamp) + '</div><div style="margin-top:6px;white-space:pre-wrap;color:var(--text)">' + esc(entry.text) + '</div><div style="margin-top:10px"><strong>Transcript Context</strong>' + (transcriptRows || '<div class="transcript-row">No transcript context found.</div>') + '</div>'; } catch (error) { detail.textContent = error.message; } }

function showLeftTab(tab, el) { document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active')); el.classList.add('active'); document.getElementById('historyList').style.display = tab === 'history' ? 'block' : 'none'; document.getElementById('fileTree').style.display = tab === 'files' ? 'block' : 'none'; document.getElementById('skillList').style.display = tab === 'skills' ? 'block' : 'none'; document.getElementById('memoryView').style.display = tab === 'memory' ? 'block' : 'none'; document.getElementById('memoryPalaceView').style.display = tab === 'palace' ? 'block' : 'none'; document.getElementById('discoveryView').style.display = tab === 'discovery' ? 'block' : 'none'; document.getElementById('learningView').style.display = tab === 'learning' ? 'block' : 'none'; const sn = document.getElementById('snapshotsView'); if (sn) sn.style.display = tab === 'snapshots' ? 'block' : 'none'; const rg = document.getElementById('ragView'); if (rg) rg.style.display = tab === 'rag' ? 'block' : 'none'; const td = document.getElementById('toolsDashboardView'); if (td) td.style.display = tab === 'tools' ? 'block' : 'none'; const rn = document.getElementById('runsView'); if (rn) rn.style.display = tab === 'runs' ? 'block' : 'none'; const wf = document.getElementById('workflowsView'); if (wf) wf.style.display = tab === 'workflows' ? 'block' : 'none'; const my = document.getElementById('myceliumView'); if (my) my.style.display = tab === 'mycelium' ? 'block' : 'none'; if (tab === 'files') loadFiles(); if (tab === 'skills') loadSkills(); if (tab === 'memory') loadMemory(); if (tab === 'palace') loadMemoryPalace(); if (tab === 'discovery') loadDiscovery(); if (tab === 'learning') loadLearning(); if (tab === 'snapshots') loadSnapshots(); if (tab === 'rag') loadRagTab(); if (tab === 'tools') loadToolsDashboard(); if (tab === 'runs') loadRuns(); if (tab === 'workflows') loadWorkflows(); if (tab === 'mycelium') loadMycelium(); }
function toggleLeft() { document.getElementById('leftPanel').classList.toggle('hidden'); }
function toggleRight() { document.getElementById('rightPanel').classList.toggle('hidden'); }

async function pullModel() { const name = document.getElementById('pullName').value.trim(); if (!name) return; const prog = document.getElementById('pullProgress'); prog.textContent = 'Starting...'; try { const res = await fetch('/api/models/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const p = line.slice(6); if (p === '[DONE]') { prog.textContent = 'Done!'; loadModels(); return; } try { const d = JSON.parse(p); if (d.error) { prog.textContent = 'Error: ' + d.error; return; } if (d.status) { const pct = d.completed && d.total ? ' (' + Math.round(d.completed / d.total * 100) + '%)' : ''; prog.textContent = d.status + pct; } } catch {} } } } catch (e) { prog.textContent = 'Failed: ' + e.message; } }

async function loadLearning() { try { const r = await fetch('/api/learning'); const d = await r.json(); const view = document.getElementById('learningView'); let html = '<div style="padding:4px 0"><h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin-bottom:8px">🧠 Self-Learning Status</h5>'; html += '<div style="display:flex;gap:4px;margin-bottom:8px"><input id="semanticQuery" placeholder="Search session memory" style="flex:1;padding:6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px"><button class="btn-sm" onclick="searchSemanticMemory()">Search</button></div><div id="semanticResults"></div>'; html += '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Total tool calls tracked: <strong style="color:var(--text)">' + ((d.totalToolCalls) || 0) + '</strong></div>'; if (d.toolBreakdown && Object.keys(d.toolBreakdown).length > 0) { html += '<div style="margin-bottom:12px">'; for (const [tool, count] of Object.entries(d.toolBreakdown || {})) html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(tool) + '</span><span style="color:var(--accent)">' + count + '</span></div>'; html += '</div>'; } const patterns = d.patterns || []; if (patterns.length > 0) { html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Detected Patterns</h5>'; for (const p of patterns.slice(0, 5)) html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:4px;font-size:11px"><div style="color:var(--accent);font-weight:600">' + esc(p.toolSequence.join(' → ')) + '</div><div style="color:var(--text-dim)">' + p.occurrences + 'x across sessions' + (p.promoted ? ' ✅ promoted' : '') + '</div></div>'; } const reflections = d.reflections || []; if (reflections.length > 0) { html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Recent Reflections</h5>'; for (const item of reflections.slice(-3)) { html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;padding:6px;background:var(--surface2);border-radius:6px"><div>Success: ' + Math.round(item.successRate * 100) + '% | Tools: ' + item.toolsUsed.join(', ') + '</div>'; if (item.insights.length) html += '<div style="color:var(--warning);margin-top:2px">' + esc(item.insights.join('; ')) + '</div>'; html += '</div>'; } } if (d.evolvedPrompt) html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Evolved Instructions</h5><pre style="font-size:10px;background:var(--surface2);padding:6px;border-radius:6px;white-space:pre-wrap;color:var(--text-dim)">' + esc(d.evolvedPrompt) + '</pre>'; html += '</div>'; view.innerHTML = html; renderLearningManager(d); } catch { document.getElementById('learningView').innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No learning data yet. Start chatting and the agent will begin tracking patterns.</div>'; } }

function renderLearningManager(data) {
  const view = document.getElementById('learningView');
  if (!view) return;
  view.innerHTML += renderRoutingMetrics(data) + renderCandidateQueue(data) + renderOutputValidationTrends(data) + renderProfileFeedbackTrends(data) + renderContextLossTrend(data) + renderEvalDatasetManager(data);
}

function renderOutputValidationTrends(data) {
  const trend = data.outputValidationTrend || { totalResults: 0, byProfile: {}, bySelectionSource: {}, byStatus: {}, latestFailures: [] };
  const profileRows = Object.entries(trend.byProfile || {}).map(([profile, bucket]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(profile) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const sourceRows = Object.entries(trend.bySelectionSource || {}).map(([source, bucket]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(source) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const statusRows = Object.entries(trend.byStatus || {}).map(([status, count]) => '<span class="trace-pill">' + esc(status) + ': ' + count + '</span>').join('');
  const failures = (trend.latestFailures || []).map((failure) => '<div class="trace-meta">' + esc(failure.profile) + ' · ' + esc(failure.selectionSource || 'unknown') + ' · ' + esc(failure.task) + ' · ' + esc(failure.message) + (failure.checks?.length ? ' · ' + esc(failure.checks.join(', ')) : '') + '</div>').join('');
  return '<div id="outputValidationTrend" class="trace-list"><div class="trace-title">Output Validation Trends</div><div class="trace-meta">' + trend.totalResults + ' validation results recorded</div><button id="downloadOutputValidationTrendBtn" class="btn-sm full-width-button" onclick="downloadOutputValidationTrend()">Download validation trends</button><div style="margin-top:6px"><strong>By profile</strong>' + (profileRows || '<div class="trace-meta">No validation runs yet</div>') + '</div><div id="outputValidationSourceTrend" style="margin-top:6px"><strong>By selection source</strong>' + (sourceRows || '<div class="trace-meta">No source data yet</div>') + '</div>' + (statusRows ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">' + statusRows + '</div>' : '') + (failures ? '<div style="margin-top:6px"><strong>Recent findings</strong>' + failures + '</div>' : '') + '</div>';
}

function downloadOutputValidationTrend() {
  markWalkthroughStep('learning');
  window.location.href = '/api/learning/output-validation-trends/download';
}

function renderContextLossTrend(data) {
  const trend = data.contextLossTrend || { total: 0, recent: [] };
  if (trend.total === 0) return '';
  const rows = (trend.recent || []).map((entry) => '<div class="trace-meta">⚠️ ' + esc(entry.task) + ' <span style="color:var(--text-dim)">(' + esc((entry.createdAt || '').slice(0, 19)) + ')</span></div>').join('');
  return '<div id="contextLossTrend" class="trace-list"><div class="trace-title">Assistant Context Loss</div>' +
    '<div class="trace-meta" style="color:var(--warn,#c98900)"><strong>' + trend.total + '</strong> assistant reply(ies) shared no significant token with the prior turn.</div>' +
    '<div style="margin-top:6px"><strong>Recent</strong>' + rows + '</div>' +
    '<div class="trace-meta" style="margin-top:6px">Tag: <code>assistant-context-loss</code>. See <code>.harness/evals/trace-runs.jsonl</code> for full traces.</div>' +
    '</div>';
}

function renderProfileFeedbackTrends(data) {
  const trend = data.profileFeedbackTrend || { totalVotes: 0, byProfile: {}, insights: [], recentVotes: [], dailyApproval: [] };
  const profileRows = Object.entries(trend.byProfile || {}).map(([profile, bucket]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(profile) + '</span><span>👍 ' + bucket.up + ' · 👎 ' + bucket.down + ' · ' + Math.round((bucket.approvalRate || 0) * 100) + '% approve</span></div>').join('');
  const insightRows = (trend.insights || []).map((insight) => '<div class="trace-meta" style="color:' + (insight.severity === 'warn' ? 'var(--warn,#c98900)' : 'var(--text-dim)') + '"><strong>' + esc(insight.severity.toUpperCase()) + ':</strong> ' + esc(insight.message) + '</div>').join('');
  const recentRows = (trend.recentVotes || []).map((vote) => '<div class="trace-meta">' + (vote.vote === 'up' ? '👍' : '👎') + ' ' + esc(vote.profile) + ' · ' + esc(vote.task) + '</div>').join('');
  const sparkline = renderApprovalSparkline(trend.dailyApproval || []);
  return '<div id="profileFeedbackTrend" class="trace-list"><div class="trace-title">Validation Profile Feedback</div>' +
    '<div class="trace-meta">' + trend.totalVotes + ' vote(s) recorded</div>' +
    (sparkline ? '<div style="margin-top:6px"><strong>Approval rate over time</strong>' + sparkline + '</div>' : '') +
    '<div style="margin-top:6px"><strong>By profile</strong>' + (profileRows || '<div class="trace-meta">No feedback yet — use 👍 / 👎 on the validation profile event in chat.</div>') + '</div>' +
    (insightRows ? '<div style="margin-top:6px"><strong>Calibration insights</strong>' + insightRows + '</div>' : '') +
    (recentRows ? '<div style="margin-top:6px"><strong>Recent votes</strong>' + recentRows + '</div>' : '') +
    '<div style="margin-top:8px"><button class="btn-sm" onclick="replayProfileFeedback()">Replay down-votes through suggester</button></div>' +
    '<div id="profileFeedbackReplayResult" class="trace-meta initial-hidden" style="margin-top:6px"></div>' +
    '</div>';
}

function renderApprovalSparkline(daily) {
  if (!daily || daily.length < 2) return '';
  const w = 220;
  const h = 32;
  const pad = 2;
  const points = daily.map((d, i) => {
    const x = pad + (i / (daily.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (d.approvalRate || 0)) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const lastPct = Math.round((daily[daily.length - 1].approvalRate || 0) * 100);
  const title = daily.map((d) => d.date + ': ' + Math.round((d.approvalRate || 0) * 100) + '% (' + d.up + '/' + d.total + ')').join(' · ');
  return '<svg width="' + w + '" height="' + h + '" style="display:block;margin-top:4px" role="img" aria-label="Approval rate sparkline">' +
    '<title>' + esc(title) + '</title>' +
    '<polyline points="' + points + '" fill="none" stroke="var(--accent,#4ea1ff)" stroke-width="1.5" />' +
    '</svg><div class="trace-meta">Latest: ' + lastPct + '% across ' + daily.length + ' day(s)</div>';
}

async function replayProfileFeedback() {
  const out = document.getElementById('profileFeedbackReplayResult');
  if (!out) return;
  out.classList.remove('initial-hidden');
  out.textContent = 'Replaying…';
  try {
    const res = await fetch('/api/output-validation/feedback-replay');
    const data = await res.json();
    const lines = (data.replays || []).slice(0, 10).map((replay) => {
      const icon = replay.status === 'fixed' ? '✅' : (replay.status === 'still-misclassified' ? '❌' : '⚠️');
      return icon + ' ' + esc(replay.originalProfile) + ' → ' + esc(replay.suggestedProfile) + (replay.prompt ? ' · ' + esc(replay.prompt.slice(0, 80)) : ' (no prompt captured)');
    }).join('<br/>');
    out.innerHTML = '<strong>' + data.totalDownVotes + ' down-vote(s):</strong> ' + data.fixed + ' fixed · ' + data.stillMisclassified + ' still misclassified · ' + data.noPrompt + ' missing prompt' + (lines ? '<br/>' + lines : '');
  } catch (err) {
    out.textContent = 'Replay failed: ' + (err && err.message ? err.message : err);
  }
}

function renderRoutingMetrics(data) {
  const summary = data.routingSummary || { total: 0, successRate: 0, escalationRate: 0, byTier: {}, topReasons: [] };
  const calibration = data.routingCalibration || { recommendations: [], suggestedPolicy: {} };
  const tiers = Object.entries(summary.byTier || {}).map(([tier, bucket]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(tier) + '</span><span>' + bucket.count + ' · ' + Math.round(bucket.successRate * 100) + '%</span></div>').join('');
  const recommendations = (calibration.recommendations || []).map((item) => '<div class="trace-meta">' + esc(item) + '</div>').join('');
  const suggested = Object.entries(calibration.suggestedPolicy || {}).map(([key, value]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(key) + '</span><span>' + esc(value) + '</span></div>').join('');
  const applyDisabled = suggested ? '' : ' disabled';
  return '<div id="routingMetricsPanel" class="trace-item"><div class="trace-title">Routing Metrics</div><div class="trace-meta">' + summary.total + ' runs · ' + Math.round((summary.successRate || 0) * 100) + '% success · ' + Math.round((summary.escalationRate || 0) * 100) + '% escalated</div>' + (tiers || '<div class="trace-meta">No tier metrics yet</div>') + '<div style="margin-top:6px"><strong>Calibration</strong>' + (recommendations || '<div class="trace-meta">No calibration suggestions yet</div>') + (suggested ? '<div style="margin-top:4px">' + suggested + '</div>' : '') + '<button id="applyCalibrationBtn" class="btn-sm full-width-button"' + applyDisabled + ' onclick="applyRoutingCalibration()">Apply calibration</button></div></div>';
}

function renderCandidateQueue(data) {
  const candidates = data.candidates || [];
  const rows = candidates.slice(-8).reverse().map((candidate) => {
    const disabled = candidate.reviewStatus !== 'pending' || !candidate.accepted;
    const status = candidate.reviewStatus || 'pending';
    return '<div class="trace-item"><div class="trace-title">Candidate · ' + esc(status) + '</div><div class="trace-meta">Quality ' + Math.round((candidate.qualityScore || 0) * 100) + '% · ' + esc(candidate.toolNames?.join(', ') || 'no tools') + '</div><div style="font-size:11px;color:var(--text);white-space:pre-wrap;margin-top:4px">' + esc((candidate.prompt || '').slice(0, 180)) + '</div><div style="display:flex;gap:4px;margin-top:6px"><button class="btn-sm" onclick="inspectLearningCandidate(\'' + escAttr(candidate.id) + '\')">Details</button><button class="btn-sm" ' + (disabled ? 'disabled' : '') + ' onclick="reviewLearningCandidate(\'' + escAttr(candidate.id) + '\',\'promote\')">Promote</button><button class="btn-sm danger" ' + (candidate.reviewStatus !== 'pending' ? 'disabled' : '') + ' onclick="reviewLearningCandidate(\'' + escAttr(candidate.id) + '\',\'reject\')">Reject</button></div></div>';
  }).join('');
  return '<div id="learningCandidateQueue" class="trace-list"><div class="trace-title">Learning Candidate Review</div>' + (rows || '<div class="trace-meta">No candidates yet</div>') + '<div id="candidateProvenanceDetail" class="trace-item initial-hidden"></div></div>';
}

function renderEvalDatasetManager(data) {
  const examples = data.evalExamples || [];
  const trend = data.evalRunTrend || { totalRuns: 0, averagePassRate: 0 };
  const latest = trend.latest ? '<div class="trace-meta">Latest run: ' + trend.latest.passed + '/' + trend.latest.total + ' passed · ' + Math.round((trend.latest.passRate || 0) * 100) + '%</div>' : '<div class="trace-meta">No eval runs yet</div>';
  const latestFailures = renderLatestRunFailures(trend.latest);
  const tagRows = Object.entries(trend.byTag || {}).slice(0, 5).map(([tag, bucket]) => '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(tag) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const rows = examples.slice(-8).reverse().map((example) => '<div class="trace-item"><div class="trace-title">Eval · ' + esc(example.status) + (example.mode === 'replay' ? ' · replay' : '') + '</div><div class="trace-meta">' + esc(example.task) + '</div><div class="trace-meta">' + esc((example.tags || []).join(', ')) + '</div>' + renderReplaySourceLinks(example) + '<div style="display:flex;gap:4px;margin-top:6px"><button class="btn-sm" onclick="tagEvalExample(\'' + escAttr(example.id) + '\',\'' + escAttr((example.tags || []).join(', ')) + '\')">Tag</button><button class="btn-sm danger" onclick="deleteEvalExample(\'' + escAttr(example.id) + '\')">Delete</button></div></div>').join('');
  return '<div id="evalDatasetManager" class="trace-list"><div class="trace-title">Eval Dataset</div><button id="runEvalDatasetBtn" class="btn-sm full-width-button" onclick="runEvalDataset(\'stored\')">Run stored evals</button><button id="runLiveReplayDatasetBtn" class="btn-sm full-width-button" onclick="runEvalDataset(\'live\')">Run live replay evals</button><button class="btn-sm full-width-button" onclick="downloadEvalDataset()">Download JSONL</button><div id="evalRunTrend" class="trace-item"><div class="trace-title">Eval Trends</div><div class="trace-meta">' + trend.totalRuns + ' runs · ' + Math.round((trend.averagePassRate || 0) * 100) + '% average pass rate</div>' + latest + tagRows + latestFailures + '</div>' + (rows || '<div class="trace-meta">No eval examples yet</div>') + '</div>';
}

function renderLatestRunFailures(run) {
  const failed = (run?.results || []).filter((result) => result.status === 'fail').slice(0, 4);
  if (failed.length === 0) return '';
  return '<div id="latestReplayFailures" style="margin-top:6px"><strong>Latest failures</strong>' + failed.map((result) => '<div class="trace-meta">' + esc(result.task) + ' · ' + esc(result.message) + renderReplayResultLinks(result.links) + '</div>').join('') + '</div>';
}

function renderReplayResultLinks(links) {
  if (!links) return '';
  const rendered = [];
  if (links.traceUrl) rendered.push('<a href="' + escAttr(links.traceUrl) + '" target="_blank">trace</a>');
  if (links.sessionUrl) rendered.push('<a href="' + escAttr(links.sessionUrl) + '" target="_blank">session</a>');
  if (!rendered.length && !links.context) return '';
  return '<span> · Source: ' + rendered.join(' · ') + (links.context ? ' · ' + esc(links.context) : '') + '</span>';
}

function renderReplaySourceLinks(example) {
  const links = [];
  if (example.sourceTraceId) links.push('<a href="/api/traces/exports/' + encodeURIComponent(example.sourceTraceId) + '" target="_blank">trace</a>');
  if (example.sourceSessionId) links.push('<a href="/api/sessions/' + encodeURIComponent(example.sourceSessionId) + '" target="_blank">session</a>');
  if (!links.length && !example.sourceContext) return '';
  return '<div class="trace-meta">Source: ' + links.join(' · ') + (example.sourceContext ? ' · ' + esc(example.sourceContext) : '') + '</div>';
}

async function applyRoutingCalibration() {
  const response = await fetch('/api/learning/routing/apply-calibration', { method: 'POST' });
  const data = await response.json();
  if (data.error) { alert(data.error); return; }
  currentModelRouting = data.settings?.modelRouting || currentModelRouting;
  await loadSettings();
  await loadLearning();
}

async function inspectLearningCandidate(id) {
  const detail = document.getElementById('candidateProvenanceDetail');
  if (!detail) return;
  detail.classList.remove('initial-hidden');
  detail.textContent = 'Loading candidate provenance...';
  const response = await fetch('/api/learning/candidates/' + encodeURIComponent(id) + '/provenance');
  const data = await response.json();
  if (data.error) { detail.textContent = data.error; return; }
  const events = (data.events || []).map((event) => '<div class="trace-row"><strong>' + esc(event.kind) + '</strong><div>' + esc(event.type) + ' · ' + esc(event.timestamp) + '</div><div style="white-space:pre-wrap;color:var(--text)">' + esc(event.summary) + '</div></div>').join('');
  detail.innerHTML = '<div class="trace-title">Candidate Provenance</div><div class="trace-meta">' + esc(data.candidate.sessionId) + ' · ' + (data.events || []).length + ' source events</div>' + (events || '<div class="trace-meta">No source events found</div>') + ((data.missingEventIds || []).length ? '<div class="trace-meta">Missing source ids: ' + esc(data.missingEventIds.join(', ')) + '</div>' : '');
}

async function runEvalDataset(mode) {
  const selectedModel = document.getElementById('modelSelect')?.value;
  if (mode === 'live' && !selectedModel) { alert('Select a model before running live replay evals.'); return; }
  const response = await fetch('/api/evals/trace-examples/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode || 'stored', model: selectedModel }) });
  const data = await response.json();
  if (data.error) { alert(data.error); return; }
  await loadLearning();
}

async function reviewLearningCandidate(id, action) {
  const reason = action === 'reject' ? prompt('Reason for rejection', 'Not useful enough') : undefined;
  if (action === 'reject' && reason === null) return;
  const response = await fetch('/api/learning/candidates/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, reason }) });
  const data = await response.json();
  if (data.error) { alert(data.error); return; }
  await loadLearning();
}

async function tagEvalExample(id, currentTags) {
  const input = prompt('Tags, comma separated', currentTags || '');
  if (input === null) return;
  const response = await fetch('/api/evals/trace-examples/' + encodeURIComponent(id) + '/tags', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: input.split(',') }) });
  const data = await response.json();
  if (data.error) { alert(data.error); return; }
  await loadLearning();
  await loadTraceEvalExamples();
}

async function deleteEvalExample(id) {
  if (!confirm('Delete this eval example?')) return;
  const response = await fetch('/api/evals/trace-examples/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await response.json();
  if (data.error) { alert(data.error); return; }
  await loadLearning();
  await loadTraceEvalExamples();
}

function downloadEvalDataset() {
  window.location.href = '/api/evals/trace-examples/download';
}

async function rebuildSemanticMemory() { try { const r = await fetch('/api/memory/rebuild', { method: 'POST' }); const d = await r.json(); alert('Semantic memory entries: ' + (d.entries || 0)); } catch (e) { alert(e.message); } }
async function searchSemanticMemory() { const q = document.getElementById('semanticQuery').value.trim(); const box = document.getElementById('semanticResults'); if (!q) return; try { const r = await fetch('/api/memory/search?q=' + encodeURIComponent(q)); const d = await r.json(); box.innerHTML = (d.results || []).map((x) => '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:4px;font-size:11px"><div style="color:var(--accent);font-weight:600">' + esc(x.entry.kind) + ' · ' + Math.round(x.score * 100) + '</div><div style="color:var(--text-dim)">' + esc(x.entry.text.slice(0, 220)) + '</div></div>').join('') || '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">No matches</div>'; } catch (e) { box.textContent = e.message; } }

async function exportTraceSnapshot() { try { const response = await fetch('/api/traces/exports', { method: 'POST' }); const data = await response.json(); if (data.error) { alert(data.error); return; } loadTraceExports(); } catch (error) { alert(error.message); } }
async function exportTraceEvalExample() { try { const response = await fetch('/api/evals/trace-examples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'browser trace export', tags: ['browser', 'runtime'] }) }); const data = await response.json(); if (data.error) { alert(data.error); return; } await loadTraceEvalExamples(); } catch (error) { alert(error.message); } }
async function createWeatherReplayEval() { try { const response = await fetch('/api/evals/replay-examples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Bracknell weather answer regression', prompt: 'What is the weather like in Bracknell, UK today?', expectedResponseIncludes: ['Bracknell', 'weather'], expectedTools: ['web_search', 'web_read'], tags: ['weather', 'replay'] }) }); const data = await response.json(); if (data.error) { alert(data.error); return; } await loadTraceEvalExamples(); await loadLearning(); } catch (error) { alert(error.message); } }
async function loadTraceEvalExamples() { const box = document.getElementById('traceEvalExamples'); if (!box) return; try { const response = await fetch('/api/evals/trace-examples'); const data = await response.json(); const examples = data.examples || []; box.innerHTML = examples.slice(-5).reverse().map((item) => '<div class="trace-item"><div class="trace-title">Eval · ' + esc(item.status) + '</div><div class="trace-meta">' + esc(item.task) + ' · ' + esc((item.tags || []).join(', ')) + '</div></div>').join('') || '<div class="trace-meta">No eval examples</div>'; } catch { box.innerHTML = '<div class="trace-meta">Eval examples unavailable</div>'; } }
async function loadTraceExports() { const box = document.getElementById('traceExports'); if (!box) return; try { const response = await fetch('/api/traces/exports'); const data = await response.json(); box.innerHTML = (data.exports || []).slice(0, 5).map((item) => '<div class="trace-item"><div class="trace-title">' + esc(item.id) + '</div><div class="trace-meta">' + Math.round((item.size || 0) / 1024) + ' KB · ' + esc(item.modifiedAt || '') + '</div><button class="btn-sm full-width-button" onclick="inspectTraceExport(\'' + escAttr(item.id) + '\')">Inspect trace</button></div>').join('') || '<div class="trace-meta">No exports</div>'; await loadTraceEvalExamples(); } catch { box.innerHTML = '<div class="trace-meta">Trace exports unavailable</div>'; } }

async function inspectTraceExport(id) { const inspector = document.getElementById('traceInspector'); if (!inspector) return; inspector.classList.remove('initial-hidden'); inspector.textContent = 'Loading trace export...'; try { const response = await fetch('/api/traces/exports/' + encodeURIComponent(id)); const data = await response.json(); if (data.error) { inspector.textContent = data.error; return; } activeTraceExport = data; renderTraceInspector(); } catch (error) { inspector.textContent = error.message; } }

function renderTraceInspector() { const inspector = document.getElementById('traceInspector'); if (!inspector || !activeTraceExport) return; const filter = (document.getElementById('traceFilter')?.value || '').toLowerCase(); const spans = (activeTraceExport.spans || []).filter((span) => traceRecordText(span).includes(filter)); const events = (activeTraceExport.events || []).filter((event) => traceRecordText(event).includes(filter)); const spanRows = spans.slice(0, 8).map((span) => '<div class="trace-row"><strong>' + esc(span.name) + '</strong><div>' + esc(span.status || 'open') + ' · ' + esc(span.durationMs ?? 0) + ' ms · ' + esc(span.startedAt || '') + '</div>' + (span.error ? '<div>' + esc(span.error) + '</div>' : '') + '</div>').join(''); const eventRows = events.slice(0, 8).map((event) => '<div class="trace-row"><strong>' + esc(event.name) + '</strong><div>' + esc(event.timestamp || '') + '</div></div>').join(''); inspector.innerHTML = '<div><strong>' + esc(activeTraceExport.id || 'trace') + '</strong></div><div>' + spans.length + '/' + (activeTraceExport.spans || []).length + ' spans · ' + events.length + '/' + (activeTraceExport.events || []).length + ' events</div><input id="traceFilter" class="trace-filter" placeholder="Filter spans and events" value="' + escAttr(filter) + '" oninput="renderTraceInspector()"><div style="margin-top:8px"><strong>Spans</strong>' + (spanRows || '<div class="trace-row">No matching spans</div>') + '</div><div style="margin-top:8px"><strong>Events</strong>' + (eventRows || '<div class="trace-row">No matching events</div>') + '</div>'; const input = document.getElementById('traceFilter'); if (input) input.selectionStart = input.selectionEnd = input.value.length; }

function traceRecordText(record) { return JSON.stringify(record || {}).toLowerCase(); }

async function loadRuntimeStorage() { const box = document.getElementById('runtimeStorageStatus'); if (!box) return; try { const response = await fetch('/api/runtime/storage'); const data = await response.json(); box.innerHTML = '<div><strong>Trace exports</strong> ' + esc(data.traces.count) + ' files · ' + Math.round((data.traces.bytes || 0) / 1024) + ' KB</div><div><strong>Semantic index</strong> ' + (data.semanticIndex.exists ? Math.round((data.semanticIndex.bytes || 0) / 1024) + ' KB' : 'not built') + '</div>'; } catch (error) { box.textContent = error.message; } }

async function cleanupRuntimeStorage(target) { const body = { traces: target === 'traces', semanticIndex: target === 'semanticIndex' }; try { const response = await fetch('/api/runtime/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (data.error) { alert(data.error); return; } await loadRuntimeStorage(); if (target === 'traces') await loadTraceExports(); } catch (error) { alert(error.message); } }

// ─── Snapshots tab (skills + memory + config) ──────────────────────
// Renders a list of snapshots with "Take", "Diff", "Restore", "Delete"
// actions. Snapshots are stored under .harness/snapshots/<id>.json so
// they're reversible and survive process restarts.

async function loadSnapshots() {
  const view = document.getElementById('snapshotsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">Snapshots</div><div class="trace-meta">Loading…</div></div>';
  try {
    const r = await fetch('/api/snapshots');
    const d = await r.json();
    const snaps = (d && d.snapshots) || [];
    const header = '<div class="panel-header" style="border-bottom:none"><h3>Snapshots</h3><div class="inline-actions"><button class="btn-sm" onclick="takeSnapshot()">+ Take</button><button class="btn-sm" onclick="loadSnapshots()">Refresh</button></div></div>';
    const intro = '<div class="trace-meta" style="padding:0 8px 8px">Backs up .harness/skills, MEMORY.md, USER.md, SOUL.md so the agent\'s self-improvement is reversible.</div>';
    if (snaps.length === 0) {
      view.innerHTML = header + intro + '<div class="trace-meta" style="padding:8px">(no snapshots yet — click <strong>Take</strong> to capture one)</div>';
      return;
    }
    const rows = snaps.map((s) => '<div class="trace-item"><div class="trace-title">' + esc(s.id) + '</div>'
      + '<div class="trace-meta">' + esc(new Date(s.createdAt).toLocaleString()) + ' · ' + s.fileCount + ' files · ' + Math.round((s.totalBytes || 0) / 1024) + ' KB</div>'
      + '<div class="trace-meta">' + esc(s.reason || '') + '</div>'
      + '<div class="inline-actions" style="margin-top:6px"><button class="btn-sm" onclick="diffSnapshot(\'' + esc(s.id) + '\')">Diff</button>'
      + '<button class="btn-sm" onclick="restoreSnapshot(\'' + esc(s.id) + '\')">Restore</button>'
      + '<button class="btn-sm danger" onclick="deleteSnapshot(\'' + esc(s.id) + '\')">Delete</button></div>'
      + '<div class="trace-detail initial-hidden" id="snapDiff-' + esc(s.id) + '"></div></div>').join('');
    view.innerHTML = header + intro + '<div class="trace-list">' + rows + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message) + '</div>';
  }
}

async function takeSnapshot() {
  const reason = window.prompt('Snapshot label (optional):', 'manual');
  if (reason === null) return;
  try {
    const r = await fetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    await loadSnapshots();
  } catch (e) { alert(e.message); }
}

async function diffSnapshot(id) {
  const detail = document.getElementById('snapDiff-' + id);
  if (!detail) return;
  detail.classList.remove('initial-hidden');
  detail.textContent = 'Loading diff…';
  try {
    const r = await fetch('/api/snapshots/' + encodeURIComponent(id) + '/diff');
    const d = await r.json();
    if (d.error) { detail.textContent = d.error; return; }
    const sections = [];
    if (d.added && d.added.length)    sections.push('<div><strong>Added (' + d.added.length + ')</strong><div style="white-space:pre-wrap">' + esc(d.added.join('\n')) + '</div></div>');
    if (d.modified && d.modified.length) sections.push('<div><strong>Modified (' + d.modified.length + ')</strong><div style="white-space:pre-wrap">' + esc(d.modified.join('\n')) + '</div></div>');
    if (d.removed && d.removed.length) sections.push('<div><strong>Removed (' + d.removed.length + ')</strong><div style="white-space:pre-wrap">' + esc(d.removed.join('\n')) + '</div></div>');
    detail.innerHTML = sections.length ? sections.join('<div style="height:6px"></div>') : '<div>No changes since this snapshot.</div>';
  } catch (e) { detail.textContent = e.message; }
}

async function restoreSnapshot(id) {
  if (!confirm('Restore snapshot ' + id + '?\n\nA pre-restore safety snapshot will be taken first so you can undo.')) return;
  try {
    const r = await fetch('/api/snapshots/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    alert('Restored ' + d.restoredFiles + ' file(s).\nSafety snapshot: ' + d.safetySnapshotId);
    await loadSnapshots();
  } catch (e) { alert(e.message); }
}

async function deleteSnapshot(id) {
  if (!confirm('Delete snapshot ' + id + '? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/snapshots/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    await loadSnapshots();
  } catch (e) { alert(e.message); }
}

// ─── Local RAG tab ────────────────────────────────────────────────
// Build, query, and drop semantic indexes over arbitrary local files.
// Backend auto-detects between Ollama embeddings and a deterministic
// hash fallback so the tab always works, even offline.

const ragState = {
  selectedPaths: new Set(),
  expanded: new Set(['']),
  treeCache: new Map(),
  lastPreview: null,
  lastBuild: null,
  indexCache: new Map(),
};

async function loadRagTab() {
  const view = document.getElementById('ragView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">RAG indexes</div><div class="trace-meta">Loading…</div></div>';
  try {
    const r = await fetch('/api/rag/indexes');
    const d = await r.json();
    const indexes = (d && d.indexes) || [];
    const header = '<div class="panel-header" style="border-bottom:none"><h3>Local RAG</h3><div class="inline-actions"><button class="btn-sm" onclick="loadRagTab()">Refresh</button></div></div>';
    if (ragState.selectedPaths.size === 0) {
      for (const suggestion of ['README.md', 'docs', 'cookbook']) ragState.selectedPaths.add(suggestion);
    }
    const builder = '<div class="trace-item">'
      + '<div class="trace-title">Build index</div>'
      + '<div class="trace-meta" style="margin-bottom:8px">Pick files and folders to index. Only text files are indexed; <code>node_modules</code>, <code>.git</code>, <code>dist</code>, and <code>.harness</code> are skipped.</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="ragBuildName" type="text" placeholder="index name (e.g. docs)" style="flex:1;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px"></div>'
      + '<div class="rag-picker">'
      +   '<div class="rag-picker-label">Files & folders to index</div>'
      +   '<div id="ragSelectedList" class="rag-selected"></div>'
      +   '<div id="ragFileTree" class="rag-tree"><div class="trace-meta">Loading project files…</div></div>'
      + '</div>'
      + '<details style="margin-top:6px"><summary class="trace-meta" style="cursor:pointer">Advanced: type paths manually</summary>'
      +   '<div style="display:flex;gap:6px;margin-top:6px"><input id="ragBuildPathsManual" type="text" placeholder="comma-separated, e.g. docs,README.md" style="flex:1;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px"><button class="btn-sm" onclick="ragAddManualPaths()">Add</button></div>'
      + '</details>'
      + '<div style="display:flex;gap:6px;margin-top:8px"><select id="ragBuildBackend" style="flex:1;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px"><option value="">auto-detect backend</option><option value="ollama">ollama embeddings</option><option value="hash">hash fallback (offline)</option></select></div>'
      + '<div class="inline-actions" style="margin-top:8px"><button class="btn-sm" onclick="ragPreview()">🔍 Preview matches</button> <button class="btn-sm primary" onclick="ragBuild()">Build index</button></div>'
      + '<div id="ragBuildStatus" class="rag-status" style="margin-top:8px"></div>'
      + '<div id="ragPreviewResults" class="rag-preview"></div>'
      + '</div>';
    const queryBox = '<div class="trace-item">'
      + '<div class="trace-title">Search</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:4px"><select id="ragQueryName" style="flex:1;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px">' + indexes.map((i) => '<option value="' + escAttr(i.name) + '">' + esc(i.name) + ' (' + i.chunks + ')</option>').join('') + '</select></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:4px"><input id="ragQueryText" type="text" placeholder="natural-language query" style="flex:1;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px" onkeydown="if(event.key===\'Enter\'){ragSearch()}"></div>'
      + '<button class="btn-sm" onclick="ragSearch()">Search</button>'
      + '<div class="trace-detail initial-hidden" id="ragQueryResults" style="margin-top:6px"></div>'
      + '</div>';
    let listing;
    if (indexes.length === 0) {
      listing = '<div class="trace-meta" style="padding:8px">(no indexes yet)</div>';
    } else {
      ragState.indexCache = new Map(indexes.map((i) => [i.name, i]));
      const rows = indexes.map((i) => {
        const prefSummary = i.prefs && Array.isArray(i.prefs.paths) && i.prefs.paths.length
          ? '<div class="trace-meta">Last paths: ' + esc(i.prefs.paths.slice(0, 4).join(', ')) + (i.prefs.paths.length > 4 ? ', …' : '') + '</div>'
          : '';
        const rebuildAttr = i.prefs ? '' : ' disabled title="No saved paths for this index. Pick paths above and Build with the same name."';
        return '<div class="trace-item">'
          + '<div class="trace-title">' + esc(i.name) + '</div>'
          + '<div class="trace-meta">' + i.chunks + ' chunks · ' + i.files + ' files · ' + esc(i.backend) + ' (' + esc(i.model) + ', dim=' + i.dim + ')</div>'
          + '<div class="trace-meta">Updated ' + esc(new Date(i.updatedAt).toLocaleString()) + '</div>'
          + prefSummary
          + '<div class="inline-actions" style="margin-top:6px">'
          +   '<button class="btn-sm" onclick="ragLoadPrefsIntoPicker(\'' + escAttr(i.name) + '\')"' + rebuildAttr + '>Load paths</button> '
          +   '<button class="btn-sm" onclick="ragRebuildNow(\'' + escAttr(i.name) + '\')"' + rebuildAttr + '>Rebuild</button> '
          +   '<button class="btn-sm danger" onclick="ragDrop(\'' + escAttr(i.name) + '\')">Delete</button>'
          + '</div>'
          + '</div>';
      }).join('');
      listing = '<div class="trace-list">' + rows + '</div>';
    }
    view.innerHTML = header + builder + (indexes.length ? queryBox : '') + listing;
    renderRagSelectedList();
    await loadRagTreeNode('');
    await refreshRagBackendBadge();
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message) + '</div>';
  }
}

async function refreshRagBackendBadge() {
  const status = document.getElementById('ragBuildStatus');
  if (!status || status.dataset.locked === '1') return;
  try {
    const response = await fetch('/api/rag/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['.'] }) });
    if (!response.ok) return;
    const data = await response.json();
    const backend = data?.backend;
    if (!backend) return;
    const note = backend.name === 'ollama' ? 'Backend: ollama embeddings (' + esc(backend.model) + ')' : 'Backend: offline hash fallback. Start Ollama to use semantic embeddings.';
    status.innerHTML = '<span class="rag-backend-badge">' + note + '</span>';
  } catch { /* leave status empty */ }
}

function renderRagSelectedList() {
  const list = document.getElementById('ragSelectedList');
  if (!list) return;
  if (ragState.selectedPaths.size === 0) {
    list.innerHTML = '<div class="trace-meta">No paths selected. Tick boxes below or expand folders.</div>';
    return;
  }
  list.innerHTML = Array.from(ragState.selectedPaths).sort().map((p) => '<span class="rag-chip">' + esc(p) + '<button onclick="ragRemovePath(\'' + escAttr(p) + '\')" title="Remove">×</button></span>').join('');
}

function ragRemovePath(path) {
  ragState.selectedPaths.delete(path);
  renderRagSelectedList();
  // Re-render tree so checkboxes reflect selection.
  const tree = document.getElementById('ragFileTree');
  if (tree) renderRagTree();
}

function ragAddManualPaths() {
  const input = document.getElementById('ragBuildPathsManual');
  if (!input) return;
  const raw = (input.value || '').trim();
  if (!raw) return;
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) ragState.selectedPaths.add(part);
  input.value = '';
  renderRagSelectedList();
  renderRagTree();
}

async function loadRagTreeNode(relativeDir) {
  if (ragState.treeCache.has(relativeDir)) {
    renderRagTree();
    return;
  }
  try {
    const url = '/api/files' + (relativeDir ? '?path=' + encodeURIComponent(relativeDir) : '');
    const response = await fetch(url);
    const data = await response.json();
    if (!data.error) ragState.treeCache.set(relativeDir, data.items || []);
  } catch { ragState.treeCache.set(relativeDir, []); }
  renderRagTree();
}

function renderRagTree() {
  const root = document.getElementById('ragFileTree');
  if (!root) return;
  root.innerHTML = renderRagTreeLevel('', 0);
}

function renderRagTreeLevel(relativeDir, depth) {
  const items = ragState.treeCache.get(relativeDir);
  if (!items) return '<div class="trace-meta" style="padding-left:' + (depth * 14) + 'px">…</div>';
  if (items.length === 0) return '<div class="trace-meta" style="padding-left:' + (depth * 14) + 'px">(empty)</div>';
  return items.map((item) => renderRagTreeItem(item, relativeDir, depth)).join('');
}

function renderRagTreeItem(item, parentRelative, depth) {
  const relative = typeof item.relative === 'string' && item.relative
    ? item.relative
    : (parentRelative ? parentRelative + '/' + item.name : item.name);
  const isDir = item.type === 'dir';
  const checked = ragState.selectedPaths.has(relative) ? 'checked' : '';
  const expanded = ragState.expanded.has(relative);
  const indent = 'padding-left:' + (depth * 14) + 'px';
  const toggleSymbol = isDir ? (expanded ? '▾' : '▸') : '·';
  const onToggle = isDir ? 'onclick="ragToggleDir(\'' + escAttr(relative) + '\')"' : '';
  const row = '<div class="rag-tree-row" style="' + indent + '">'
    + '<span class="rag-tree-toggle" ' + onToggle + '>' + toggleSymbol + '</span>'
    + '<input type="checkbox" ' + checked + ' onchange="ragTogglePath(\'' + escAttr(relative) + '\', this.checked)">'
    + '<span class="rag-tree-name ' + (isDir ? 'is-dir' : 'is-file') + '" ' + onToggle + '>' + esc(item.name) + (isDir ? '/' : '') + '</span>'
    + '</div>';
  if (!isDir || !expanded) return row;
  return row + renderRagTreeLevel(relative, depth + 1);
}

function ragTogglePath(path, checked) {
  if (checked) ragState.selectedPaths.add(path);
  else ragState.selectedPaths.delete(path);
  renderRagSelectedList();
}

async function ragToggleDir(relative) {
  if (ragState.expanded.has(relative)) {
    ragState.expanded.delete(relative);
    renderRagTree();
    return;
  }
  ragState.expanded.add(relative);
  if (!ragState.treeCache.has(relative)) await loadRagTreeNode(relative);
  else renderRagTree();
}

function ragSelectedPathsList() {
  return Array.from(ragState.selectedPaths);
}

async function ragPreview() {
  const status = document.getElementById('ragBuildStatus');
  const out = document.getElementById('ragPreviewResults');
  const paths = ragSelectedPathsList();
  if (paths.length === 0) { if (status) status.textContent = 'Pick at least one file or folder.'; return; }
  if (status) { status.textContent = 'Previewing…'; status.dataset.locked = '1'; }
  if (out) out.innerHTML = '';
  try {
    const response = await fetch('/api/rag/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const data = await response.json();
    if (data.error) { if (status) status.textContent = 'Preview failed: ' + data.error; return; }
    ragState.lastPreview = data;
    renderRagPreview(data);
    if (status) status.textContent = 'Preview ready · ' + data.totalFiles + ' file(s) would be indexed.';
  } catch (error) {
    if (status) status.textContent = 'Preview failed: ' + (error.message || error);
  } finally {
    if (status) status.dataset.locked = '';
  }
}

function renderRagPreview(data) {
  const out = document.getElementById('ragPreviewResults');
  if (!out) return;
  const rows = (data.paths || []).map((p) => {
    const icon = p.status === 'matched' ? '✅' : p.status === 'missing' ? '❌' : p.status === 'unsupported-extension' ? '⚠️' : '⚠️';
    const sample = (p.sampleFiles || []).slice(0, 3).map(esc).join(', ') + ((p.sampleFiles || []).length > 3 ? ', …' : '');
    return '<div class="rag-diagnostic"><span class="rag-diag-icon">' + icon + '</span>'
      + '<div><strong>' + esc(p.input) + '</strong> · ' + esc(p.message)
      + (p.fileCount ? ' <span class="trace-meta">(' + p.fileCount + ' file' + (p.fileCount === 1 ? '' : 's') + ')</span>' : '')
      + (sample ? '<div class="trace-meta">' + sample + '</div>' : '')
      + '</div></div>';
  }).join('');
  const backend = data.backend ? '<div class="trace-meta" style="margin-top:6px">Detected backend: <strong>' + esc(data.backend.name) + '</strong> (' + esc(data.backend.model) + ', dim=' + data.backend.dim + ')</div>' : '';
  out.innerHTML = '<div class="rag-preview-body"><div class="trace-title" style="margin-bottom:6px">Preview · ' + (data.totalFiles || 0) + ' file(s) total</div>' + (rows || '<div class="trace-meta">No paths selected.</div>') + backend + '</div>';
}

async function ragBuild() {
  const name = (document.getElementById('ragBuildName').value || '').trim();
  const backend = document.getElementById('ragBuildBackend').value || undefined;
  const status = document.getElementById('ragBuildStatus');
  const paths = ragSelectedPathsList();
  if (!name) { if (status) status.textContent = 'Enter an index name first.'; return; }
  if (paths.length === 0) { if (status) status.textContent = 'Pick at least one file or folder.'; return; }
  if (status) { status.textContent = 'Starting build…'; status.dataset.locked = '1'; }
  let total = 0;
  let processed = 0;
  let lastFile = '';
  let chunkCount = 0;
  let resolvedBackend = backend || '';
  try {
    const response = await fetch('/api/rag/build/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, paths, backend }) });
    if (!response.ok || !response.body) {
      const err = await response.json().catch(() => ({ error: 'Build request failed (' + response.status + ')' }));
      if (status) status.textContent = 'Build failed: ' + (err.error || response.status);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalEvent = null;
    let errorMessage = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        let dataLine = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload;
        try { payload = JSON.parse(dataLine); } catch { continue; }
        if (event === 'preview') {
          total = payload.totalFiles || (payload.preview && payload.preview.totalFiles) || 0;
          if (status) status.textContent = 'Indexing 0 / ' + total + ' files…';
        } else if (event === 'backend') {
          resolvedBackend = payload.backend?.name || resolvedBackend;
          if (status) status.textContent = 'Using ' + resolvedBackend + ' backend · indexing 0 / ' + total + ' files…';
        } else if (event === 'file') {
          processed = payload.fileIndex || processed + 1;
          lastFile = payload.source ? payload.source.split(/[\\/]/).pop() : '';
          chunkCount += payload.chunks || 0;
          if (status) status.textContent = 'Indexing ' + processed + ' / ' + (payload.totalFiles || total) + ' files · ' + chunkCount + ' chunks · ' + lastFile;
        } else if (event === 'done') {
          finalEvent = payload;
        } else if (event === 'error') {
          errorMessage = payload.message || 'unknown error';
        }
      }
    }
    if (errorMessage) { if (status) status.textContent = 'Build failed: ' + errorMessage; return; }
    if (finalEvent) {
      ragState.lastBuild = { files: finalEvent.files, chunks: finalEvent.totalChunks, backend: finalEvent.backend, preview: finalEvent.preview };
      if (finalEvent.preview) renderRagPreview({ ...finalEvent.preview, backend: finalEvent.backend });
      const backendName = finalEvent.backend?.name || resolvedBackend || 'unknown';
      const summary = (finalEvent.files || 0) === 0
        ? 'Build completed but 0 files matched. See Preview below for which paths were skipped.'
        : 'Built · ' + finalEvent.files + ' file(s), ' + finalEvent.totalChunks + ' chunk(s), backend=' + backendName;
      if (status) status.textContent = summary;
    } else if (status) {
      status.textContent = 'Build finished without final event.';
    }
    await loadRagTab();
  } catch (e) {
    if (status) status.textContent = 'Build failed: ' + (e.message || e);
  } finally {
    if (status) status.dataset.locked = '';
  }
}

async function ragSearch() {
  const name = document.getElementById('ragQueryName').value || '';
  const query = (document.getElementById('ragQueryText').value || '').trim();
  const out = document.getElementById('ragQueryResults');
  if (!out) return;
  out.classList.remove('initial-hidden');
  if (!name || !query) { out.textContent = 'Choose an index and enter a query.'; return; }
  out.textContent = 'Searching…';
  try {
    const r = await fetch('/api/rag/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, query, k: 5 }) });
    const d = await r.json();
    if (d.error) { out.textContent = d.error; return; }
    const results = (d && d.results) || [];
    if (results.length === 0) { out.textContent = 'No matches.'; return; }
    out.innerHTML = results.map((row, i) => renderRagSearchResult(row, i, query)).join('');
  } catch (e) { out.textContent = e.message; }
}

function renderRagSearchResult(row, i, query) {
  const sourceShort = String(row.source || '').split(/[\\/]/).slice(-2).join('/');
  return '<div class="trace-row">'
    + '<strong>[' + (i + 1) + '] score=' + row.score.toFixed(3) + '</strong> '
    + esc(sourceShort) + ' (chunk ' + row.chunkNo + ')'
    + '<div class="rag-result-actions">'
    +   '<button class="btn-sm" onclick="ragReadInChat(\'' + escAttr(row.source) + '\')">📄 Read in chat</button> '
    +   '<button class="btn-sm" onclick="ragAskAboutChunk(\'' + escAttr(row.source) + '\', ' + row.chunkNo + ', \'' + escAttr(query) + '\')">💬 Ask about this</button> '
    +   '<button class="btn-sm" onclick="ragCopyChunk(this)" data-chunk="' + escAttr(row.content) + '">Copy</button>'
    + '</div>'
    + '<div style="white-space:pre-wrap;color:var(--text-dim);margin-top:4px">' + esc(row.content.slice(0, 600)) + (row.content.length > 600 ? '…' : '') + '</div>'
    + '</div>';
}

function ragReadInChat(sourcePath) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = 'Read the file ' + sourcePath;
  sendMessage();
}

function ragAskAboutChunk(sourcePath, chunkNo, query) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const shortName = sourcePath.split(/[\\/]/).pop();
  input.value = 'Look at ' + shortName + ' (chunk ' + chunkNo + ') and answer: ' + query;
  sendMessage();
}

function ragCopyChunk(button) {
  const text = button.dataset.chunk || '';
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    }).catch(() => {});
  }
}

async function ragDrop(name) {
  if (!confirm('Delete index "' + name + '"?')) return;
  try {
    const r = await fetch('/api/rag/indexes/' + encodeURIComponent(name), { method: 'DELETE' });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    await loadRagTab();
  } catch (e) { alert(e.message); }
}

function ragLoadPrefsIntoPicker(name) {
  const idx = ragState.indexCache.get(name);
  if (!idx || !idx.prefs || !Array.isArray(idx.prefs.paths)) return;
  ragState.selectedPaths = new Set(idx.prefs.paths);
  const nameInput = document.getElementById('ragBuildName');
  if (nameInput) nameInput.value = name;
  const backendSelect = document.getElementById('ragBuildBackend');
  if (backendSelect) backendSelect.value = idx.prefs.backend || '';
  renderRagSelectedList();
  renderRagTree();
  const status = document.getElementById('ragBuildStatus');
  if (status) status.textContent = 'Loaded ' + idx.prefs.paths.length + ' saved path(s) for "' + name + '". Edit selection or click Build to refresh.';
}

async function ragRebuildNow(name) {
  const idx = ragState.indexCache.get(name);
  if (!idx || !idx.prefs || !Array.isArray(idx.prefs.paths) || idx.prefs.paths.length === 0) return;
  if (!confirm('Rebuild index "' + name + '" with the same ' + idx.prefs.paths.length + ' path(s)?')) return;
  ragState.selectedPaths = new Set(idx.prefs.paths);
  const nameInput = document.getElementById('ragBuildName');
  if (nameInput) nameInput.value = name;
  const backendSelect = document.getElementById('ragBuildBackend');
  if (backendSelect) backendSelect.value = idx.prefs.backend || '';
  await ragBuild();
}

// ─── Local Tools dashboard ─────────────────────────────────────────
// Single-page status of snapshots, RAG indexes, sessions, models, traces,
// plus the curated MCP catalog. Each section is fetched lazily and shown
// with its primary one-click action so the user can jump from "what do I
// have" to "do the thing" without leaving this view.

async function loadToolsDashboard() {
  const view = document.getElementById('toolsDashboardView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">Local Tools</div><div class="trace-meta">Loading…</div></div>';
  try {
    const [capabilitiesR, registryR, permR] = await Promise.allSettled([
      fetch('/api/capabilities').then((r) => r.json()),
      fetch('/api/tools').then((r) => r.json()),
      fetch('/api/permissions/state').then((r) => r.json()),
    ]);
    const registry = registryR.status === 'fulfilled' ? registryR.value : { tools: [], toolsets: {} };
    const capabilities = capabilitiesR.status === 'fulfilled'
      ? { items: capabilitiesR.value.capabilities || [], summary: capabilitiesR.value.summary || {}, grants: capabilitiesR.value.grants || [], shellCommandPresets: capabilitiesR.value.shellCommandPresets || [] }
      : (registry.capabilities || { items: [], summary: {}, grants: [] });
    const perm = permR.status === 'fulfilled' ? permR.value : null;
    const header = '<div class="panel-header" style="border-bottom:none"><h3>Local Tools</h3><div class="inline-actions"><button class="btn-sm" onclick="loadToolsDashboard()">Refresh</button></div></div>';
    const auditR = await fetch('/api/capabilities/audit').then((r) => r.json()).catch(() => ({ events: [] }));
    const auditEvents = Array.isArray(auditR.events) ? auditR.events : [];
    view.innerHTML = header + renderPermissionPanel(perm) + renderCapabilityAlignmentPanel(capabilities, auditEvents) + renderToolRegistryPanel(registry) + '<div class="trace-list" id="toolsDashboardCards"><div class="trace-item"><div class="trace-title">Dashboard details</div><div class="trace-meta">Loading local status…</div></div></div>';

    const [snapsR, indexesR, sessionsR, modelsR, storageR, mcpR] = await Promise.allSettled([
      fetch('/api/snapshots').then((r) => r.json()),
      fetch('/api/rag/indexes').then((r) => r.json()),
      fetch('/api/sessions').then((r) => r.json()),
      fetch('/api/models').then((r) => r.json()),
      fetch('/api/runtime/storage').then((r) => r.json()),
      fetch('/api/mcp/catalog').then((r) => r.json()),
    ]);
    const snapsCount = snapsR.status === 'fulfilled' ? (snapsR.value.snapshots || []).length : 0;
    const indexesArr = indexesR.status === 'fulfilled' ? (indexesR.value.indexes || []) : [];
    const sessionsArr = sessionsR.status === 'fulfilled' ? (sessionsR.value.sessions || sessionsR.value || []) : [];
    const modelsArr = modelsR.status === 'fulfilled' ? (modelsR.value.models || []) : [];
    const storage = storageR.status === 'fulfilled' ? storageR.value : null;
    const mcpArr = mcpR.status === 'fulfilled' ? (mcpR.value.catalog || []) : [];

    const speechSupported = typeof window.SpeechRecognition !== 'undefined' || typeof window.webkitSpeechRecognition !== 'undefined';
    const totalIndexedChunks = indexesArr.reduce((sum, i) => sum + (i.chunks || 0), 0);

    const cards = [
      {
        emoji: '📦', title: 'Snapshots', value: snapsCount + ' saved',
        sub: snapsCount === 0 ? 'No backups yet' : 'Skills + memory + config',
        action: { label: 'Open', fn: 'openLeftTabByName(\'snapshots\')' },
      },
      {
        emoji: '🔎', title: 'Local RAG', value: indexesArr.length + ' index' + (indexesArr.length === 1 ? '' : 'es'),
        sub: totalIndexedChunks ? totalIndexedChunks + ' chunks indexed' : 'Build one to enable semantic search',
        action: { label: 'Open', fn: 'openLeftTabByName(\'rag\')' },
      },
      {
        emoji: '💬', title: 'Sessions', value: sessionsArr.length + ' total',
        sub: 'JSONL transcripts in .harness/sessions',
        action: { label: 'Browse', fn: 'openLeftTabByName(\'history\')' },
      },
      {
        emoji: '🤖', title: 'Models', value: modelsArr.length + ' available',
        sub: modelsArr.length ? 'Configured via Ollama' : 'Install with: ollama pull <name>',
        action: { label: 'Settings', fn: 'toggleRight()' },
      },
      {
        emoji: '🎤', title: 'Voice input', value: speechSupported ? 'Ready' : 'Not available',
        sub: speechSupported ? 'Click 🎤 in the composer' : 'Use Chrome / Edge for browser STT',
        action: speechSupported ? { label: 'Try it', fn: 'toggleVoiceInput()' } : null,
      },
      {
        emoji: '📊', title: 'Runtime storage', value: storage && storage.traces ? (storage.traces.count + ' trace exports') : '—',
        sub: storage && storage.semanticIndex ? (storage.semanticIndex.exists ? 'Semantic index built' : 'Semantic index not built') : '',
        action: { label: 'Open settings', fn: 'toggleRight()' },
      },
    ];

    const cardHtml = cards.map((c) => '<div class="trace-item">'
      + '<div class="trace-title">' + c.emoji + ' ' + esc(c.title) + '</div>'
      + '<div class="trace-meta" style="margin-top:2px;color:var(--text)">' + esc(c.value) + '</div>'
      + '<div class="trace-meta">' + esc(c.sub) + '</div>'
      + (c.action ? '<div class="inline-actions" style="margin-top:6px"><button class="btn-sm" onclick="' + c.action.fn + '">' + esc(c.action.label) + '</button></div>' : '')
      + '</div>').join('');

    const mcpHtml = mcpArr.length === 0 ? '' : '<div class="trace-item">'
      + '<div class="trace-title">🧩 MCP catalog</div>'
      + '<div class="trace-meta" style="margin-bottom:6px">Curated MCP servers — copy the install command, run it, then point your MCP client at the new server.</div>'
      + '<input id="mcpCatalogFilter" type="text" placeholder="filter by name or tag…" style="width:100%;padding:6px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px;margin-bottom:6px" oninput="renderMcpCatalogList()">'
      + '<div id="mcpCatalogList"></div>'
      + '</div>';

    const cardsHost = document.getElementById('toolsDashboardCards');
    if (cardsHost) cardsHost.innerHTML = cardHtml + mcpHtml;
    window._mcpCatalog = mcpArr;
    renderMcpCatalogList();
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message) + '</div>';
  }
}

function renderPermissionPanel(perm) {
  if (!perm) return '';
  const ks = perm.killSwitch || { active: false, reason: '' };
  const badge = ks.active
    ? '<span class="rag-backend-badge" style="background:rgba(255,80,80,.15);border-color:#ff5050;color:#ff5050">🛑 KILL SWITCH ACTIVE</span>'
    : '<span class="rag-backend-badge" style="background:rgba(80,200,120,.12);border-color:#50c878;color:#50c878">✅ Tools allowed</span>';
  const reasonRow = ks.active && ks.reason ? '<div class="trace-meta">Reason: ' + esc(ks.reason) + '</div>' : '';
  const button = ks.active
    ? '<button class="btn-sm" onclick="releaseKillSwitch()">Release kill switch</button>'
    : '<button class="btn-sm danger" onclick="engageKillSwitch()">🛑 Engage kill switch</button>';
  return '<div class="trace-item" id="permissionPanel" style="margin-top:8px">'
    + '<div class="trace-title">🔐 Permissions</div>'
    + '<div style="margin:4px 0">' + badge + ' <span class="trace-meta">Mode: <strong>' + esc(perm.mode || 'default') + '</strong></span> <span class="trace-meta">Pending: ' + (perm.pendingCount || 0) + '</span></div>'
    + reasonRow
    + '<div class="trace-meta" style="margin-top:4px">Engaging the kill switch denies every subsequent tool call (including reads) until released. The agent loop keeps running but cannot touch the system.</div>'
    + '<div class="inline-actions" style="margin-top:6px">' + button + '</div>'
    + '</div>';
}

function renderCapabilityAlignmentPanel(capabilities, auditEvents) {
  const items = (capabilities && capabilities.items) || [];
  if (items.length === 0) return '';
  const summary = capabilities.summary || {};
  const grants = Array.isArray(capabilities.grants) ? capabilities.grants : [];
  const grantCount = grants.length;
  const presets = Array.isArray(capabilities.shellCommandPresets) ? capabilities.shellCommandPresets : [];
  const events = Array.isArray(auditEvents) ? auditEvents.slice(0, 20) : [];
  const summaryText = ['gated', 'design-only', 'blocked', 'available']
    .map((key) => key + ': ' + (summary[key] || 0))
    .join(' · ');
  const postureMeta = {
    available: { color: '#50c878', label: 'available' },
    gated: { color: '#ffb050', label: 'gated' },
    'design-only': { color: '#8ab4f8', label: 'design-only' },
    blocked: { color: '#ff5050', label: 'blocked' },
  };
  const rows = items.map((cap) => {
    const meta = postureMeta[cap.posture] || postureMeta.blocked;
    const coverage = Array.isArray(cap.existingCoverage) && cap.existingCoverage.length ? cap.existingCoverage.join(', ') : 'none';
    const controls = Array.isArray(cap.requiredControls) && cap.requiredControls.length ? cap.requiredControls.join(', ') : 'none';
    const grantButton = cap.posture === 'gated'
      ? '<button class="btn-sm" onclick="grantCapability(\'' + escAttr(cap.id) + '\')">Grant</button>'
      : '';
    return '<div class="trace-row">'
      + '<strong>' + esc(cap.label || cap.id) + '</strong> '
      + '<span class="capability-pill" style="border-color:' + meta.color + ';color:' + meta.color + '">' + esc(meta.label) + '</span>'
      + '<span class="capability-pill">' + esc(cap.category || 'policy') + '</span>'
      + '<div class="trace-meta">' + esc(cap.summary || '') + '</div>'
      + '<div class="trace-meta">Coverage: ' + esc(coverage) + '</div>'
      + '<div class="trace-meta">Controls: ' + esc(controls) + '</div>'
      + (grantButton ? '<div class="inline-actions" style="margin-top:6px">' + grantButton + '</div>' : '')
      + '</div>';
  }).join('');
  const grantRows = grants.length ? grants.map((grant) => '<div class="trace-row"><strong>' + esc(grant.capabilityId) + '</strong> <span class="capability-pill">expires ' + esc(new Date(grant.expiresAt).toLocaleString()) + '</span><div class="trace-meta">' + esc(grant.reason || '') + '</div><div class="inline-actions" style="margin-top:6px"><button class="btn-sm danger" onclick="revokeCapabilityGrant(\'' + escAttr(grant.id) + '\')">Revoke</button></div></div>').join('') : '<div class="trace-meta">No active grants.</div>';
  const presetRows = presets.length ? '<details style="margin-top:8px"><summary class="trace-meta" style="cursor:pointer">Shell command allowlist presets (' + presets.length + ')</summary>' + presets.map((preset) => '<div class="trace-meta" style="font-size:11px"><strong>' + esc(preset.label || preset.id) + '</strong>: ' + esc((preset.examples || []).join(', ')) + '</div>').join('') + '</details>' : '';
  const auditTypeColors = { 'grant.created': '#50c878', 'grant.revoked': '#ffb050', 'grant.expired': '#ff5050', 'automation_script.allowed': '#50c878', 'automation_script.denied': '#ff5050' };
  const auditSection = events.length ? '<details style="margin-top:8px"><summary class="trace-meta" style="cursor:pointer">Audit log (last ' + events.length + ' events)</summary>'
    + events.map((ev) => {
      const color = auditTypeColors[ev.type] || 'var(--text-dim)';
      const ts = ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '';
      const detail = ev.capabilityId ? ev.capabilityId : ev.command ? ev.command : '';
      return '<div class="trace-meta" style="font-size:11px"><span style="color:' + color + '">' + esc(ev.type) + '</span> ' + esc(detail) + (ev.reason ? ' — ' + esc(ev.reason) : '') + (ev.presetId ? ' [' + esc(ev.presetId) + ']' : '') + '<span style="color:var(--text-dim);margin-left:8px">' + esc(ts) + '</span></div>';
    }).join('') + '</details>' : '';
  return '<div class="trace-list" id="capabilityAlignmentPanel" style="margin-top:8px">'
    + '<div class="trace-title" style="padding:0 4px">Capability alignment · ' + esc(summaryText) + ' · active grants: ' + grantCount + '</div>'
    + '<div class="trace-item"><div class="trace-title">Active grants</div>' + grantRows + presetRows + auditSection + '</div>'
    + '<div class="trace-item">' + rows + '</div>'
    + '</div>';
}

async function grantCapability(capabilityId) {
  const reason = prompt('Reason for this capability grant?', 'Manual grant from Tools dashboard.');
  if (reason === null) return;
  const expiresRaw = prompt('Expire after how many minutes? (1-1440)', '60');
  if (expiresRaw === null) return;
  const capabilities = await fetch('/api/capabilities').then((r) => r.json());
  const item = (capabilities.capabilities || []).find((cap) => cap.id === capabilityId);
  if (!item || item.posture !== 'gated') { alert('Only gated capabilities can be granted.'); return; }
  const response = await fetch('/api/capabilities/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilityId, controls: item.requiredControls || [], reason, expiresInMinutes: Number(expiresRaw) || 60 }),
  });
  const data = await response.json();
  if (data.error) { alert('Grant failed: ' + data.error); return; }
  await loadToolsDashboard();
}

async function revokeCapabilityGrant(grantId) {
  if (!confirm('Revoke this capability grant?')) return;
  const response = await fetch('/api/capabilities/grants/' + encodeURIComponent(grantId), { method: 'DELETE' });
  const data = await response.json();
  if (data.error) { alert('Revoke failed: ' + data.error); return; }
  await loadToolsDashboard();
}

function renderToolRegistryPanel(registry) {
  const tools = (registry && registry.tools) || [];
  if (tools.length === 0) return '';
  const grouped = new Map();
  for (const t of tools) {
    if (!grouped.has(t.toolset)) grouped.set(t.toolset, []);
    grouped.get(t.toolset).push(t);
  }
  const sections = Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([toolset, items]) => {
    const rows = items.map((t) => {
      const riskColor = t.riskLevel === 'high' ? '#ff5050' : t.riskLevel === 'medium' ? '#ffb050' : '#50c878';
      const riskBadge = '<span class="capability-pill" style="border-color:' + riskColor + ';color:' + riskColor + '">' + esc(t.riskLevel || 'low') + '</span>';
      const catBadge = '<span class="capability-pill">' + esc(t.permissionCategory || 'read') + '</span>';
      const ro = t.isReadOnly ? '<span class="capability-pill">read-only</span>' : '';
      const dryRun = t.canDryRun ? '<span class="capability-pill">dry-run</span>' : '';
      const enabled = t.enabled !== false;
      const toggle = '<button class="btn-sm" onclick="toggleTool(\'' + escAttr(t.name) + '\', ' + (!enabled) + ')">' + (enabled ? 'Disable' : 'Enable') + '</button>';
      const dimmed = enabled ? '' : ' style="opacity:.55"';
      const stateBadge = enabled ? '' : ' <span class="capability-pill" style="border-color:#ff5050;color:#ff5050">disabled</span>';
      return '<div class="trace-row"' + dimmed + '><strong>' + esc(t.name) + '</strong> ' + riskBadge + ' ' + catBadge + ' ' + ro + ' ' + dryRun + stateBadge + ' ' + toggle + '<div class="trace-meta">' + esc(t.description) + '</div></div>';
    }).join('');
    return '<div class="trace-item"><div class="trace-title">' + esc(toolset) + ' (' + items.length + ')</div>' + rows + '</div>';
  }).join('');
  const disabledCount = (registry.disabled || []).length;
  const disabledNote = disabledCount > 0 ? ' · <span style="color:#ff5050">' + disabledCount + ' disabled</span>' : '';
  return '<div class="trace-list" id="toolRegistryPanel" style="margin-top:8px"><div class="trace-title" style="padding:0 4px">🛠 Tool registry · ' + tools.length + ' total' + disabledNote + '</div>' + sections + '</div>';
}

async function toggleTool(name, enable) {
  try {
    const response = await fetch('/api/tools/' + encodeURIComponent(name) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable }) });
    const data = await response.json();
    if (data.error) { alert('Toggle failed: ' + data.error); return; }
    await loadToolsDashboard();
  } catch (error) { alert('Toggle failed: ' + (error.message || error)); }
}

async function engageKillSwitch() {
  const reason = prompt('Why are you engaging the kill switch?', 'Manual stop from dashboard.');
  if (reason === null) return;
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason }) });
  await loadToolsDashboard();
}

async function releaseKillSwitch() {
  if (!confirm('Release the kill switch and resume normal tool calls?')) return;
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  await loadToolsDashboard();
}

// ─── Kill-switch global shortcut and status banner ────────────────
// Ctrl+Shift+K (or Cmd+Shift+K on macOS) toggles the kill switch from any
// view. While the switch is engaged a fixed banner stays visible at the top
// of the page so the operator never forgets the agent is muzzled.
async function toggleKillSwitchShortcut() {
  try {
    const state = await fetch('/api/permissions/state').then((r) => r.json());
    const active = Boolean(state?.killSwitch?.active);
    if (active) {
      await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
    } else {
      await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason: 'Engaged via Ctrl+Shift+K shortcut.' }) });
    }
    await refreshKillSwitchBanner();
    if (document.getElementById('toolsDashboardView')?.style.display !== 'none' && typeof loadToolsDashboard === 'function') loadToolsDashboard();
  } catch (error) { console.warn('Kill switch toggle failed:', error); }
}

async function refreshKillSwitchBanner() {
  try {
    const state = await fetch('/api/permissions/state').then((r) => r.json());
    renderKillSwitchBanner(state?.killSwitch || { active: false, reason: '' });
  } catch { /* leave banner state alone if the call fails */ }
}

function renderKillSwitchBanner(killSwitch) {
  let banner = document.getElementById('killSwitchBanner');
  if (!killSwitch.active) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'killSwitchBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(255,80,80,.18);border-bottom:1px solid #ff5050;color:#ff5050;padding:6px 12px;font-size:12px;display:flex;align-items:center;gap:10px;font-family:inherit';
    document.body.appendChild(banner);
  }
  banner.innerHTML = '<strong>🛑 KILL SWITCH ACTIVE</strong>'
    + '<span>' + esc(killSwitch.reason || 'All tool calls are denied.') + '</span>'
    + '<span style="margin-left:auto;opacity:.8">Ctrl+Shift+K to toggle</span>'
    + '<button class="btn-sm" style="margin-left:8px" onclick="releaseKillSwitchFromBanner()">Release</button>';
}

async function releaseKillSwitchFromBanner() {
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  await refreshKillSwitchBanner();
  if (document.getElementById('toolsDashboardView')?.style.display !== 'none' && typeof loadToolsDashboard === 'function') loadToolsDashboard();
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'K' || event.key === 'k')) {
    event.preventDefault();
    toggleKillSwitchShortcut();
  }
});

// On page load, sync the banner so a kill switch persisted from a previous
// run is visible as soon as the UI mounts.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { refreshKillSwitchBanner(); });
} else {
  refreshKillSwitchBanner();
}

// ─── Runs tab ──────────────────────────────────────────────────────
async function loadRuns() {
  const view = document.getElementById('runsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">Runs</div><div class="trace-meta">Loading…</div></div>';
  try {
    const [runsR, curatorR, discoveryR, autoRunsR] = await Promise.allSettled([
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/curator').then((r) => r.json()),
      fetch('/api/discovery').then((r) => r.json()),
      fetch('/api/automations/runs').then((r) => r.json()),
    ]);
    const data = runsR.status === 'fulfilled' ? runsR.value : { error: 'failed to load' };
    if (data.error) { view.innerHTML = '<div class="trace-meta">Failed: ' + esc(data.error) + '</div>'; return; }
    const runs = data.runs || [];
    const counts = data.counts || {};
    const summary = '<div class="panel-header" style="border-bottom:none"><h3>Runs</h3><div class="inline-actions"><button class="btn-sm" onclick="loadRuns()">Refresh</button></div></div>'
      + '<div class="trace-meta" style="padding:0 4px 6px">' + (data.total || 0) + ' chat run(s) · '
      + Object.entries(counts).map(([k, v]) => esc(k) + ': ' + v).join(' · ')
      + '</div>';
    const curatorSection = curatorR.status === 'fulfilled' ? renderCuratorRunsSection(curatorR.value) : '';
    const autoRunLog = autoRunsR.status === 'fulfilled' ? (autoRunsR.value.runs || []) : [];
    const automationSection = discoveryR.status === 'fulfilled' ? renderAutomationRunsSection(discoveryR.value.automations, autoRunLog) : '';
    if (runs.length === 0) {
      view.innerHTML = summary + automationSection + curatorSection + '<div class="trace-meta" style="padding:8px">(no chat runs yet — start a chat to record one)</div>';
      return;
    }
    const rows = runs.map(renderRunRow).join('');
    view.innerHTML = summary + automationSection + curatorSection + '<div class="trace-list">' + rows + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}

function renderAutomationRunsSection(automations, runLog) {
  if (!automations) return '';
  const jobs = Array.isArray(automations.jobs) ? automations.jobs : [];
  const due = Array.isArray(automations.due) ? automations.due : [];
  const policy = automations.policy || {};
  const schedulerRunning = automations.schedulerRunning;
  const entries = Array.isArray(runLog) ? runLog : [];
  const schedulerBadge = schedulerRunning
    ? '<span class="capability-pill" style="border-color:#5bb0ff;color:#5bb0ff">running</span>'
    : '<span class="capability-pill" style="border-color:#888;color:#888">idle</span>';
  const dueBadge = due.length > 0
    ? '<span class="capability-pill" style="border-color:#ffb050;color:#ffb050">' + due.length + ' due</span>'
    : '';
  const jobRows = jobs.length === 0
    ? '<div class="trace-meta">No automation jobs configured.</div>'
    : jobs.map((job) => {
      const enabled = job.enabled !== false;
      const isDue = due.some((d) => d.id === job.id);
      const statusColor = isDue ? '#ffb050' : enabled ? '#50c878' : '#888';
      const statusLabel = isDue ? 'due' : enabled ? 'active' : 'disabled';
      const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'none';
      const lastRun = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never';
      const script = job.scriptCommand ? ' · script: ' + esc(job.scriptCommand) : '';
      return '<div class="trace-row">'
        + '<strong>' + esc(job.name) + '</strong> '
        + '<span class="capability-pill" style="border-color:' + statusColor + ';color:' + statusColor + '">' + statusLabel + '</span>'
        + '<div class="trace-meta">' + esc(job.schedule?.display || '') + ' · next: ' + esc(nextRun) + ' · last: ' + esc(lastRun) + script + '</div>'
        + '<div class="inline-actions" style="margin-top:4px">'
        + '<button class="btn-sm" onclick="toggleAutomationJob(\'' + escAttr(job.id) + '\', ' + (!enabled) + ')">' + (enabled ? 'Disable' : 'Enable') + '</button> '
        + '<button class="btn-sm" onclick="editAutomationJob(\'' + escAttr(job.id) + '\', ' + escAttr(JSON.stringify(job.name)) + ', ' + escAttr(JSON.stringify(job.prompt)) + ', ' + escAttr(JSON.stringify(job.schedule?.display || '')) + ', ' + escAttr(JSON.stringify(job.scriptCommand || '')) + ')">Edit</button> '
        + '<button class="btn-sm danger" onclick="deleteAutomationJob(\'' + escAttr(job.id) + '\')">Delete</button>'
        + '</div>'
        + '</div>';
    }).join('');
  const executeBtn = due.length > 0
    ? '<button class="btn-sm" onclick="executeAutomationDueJobs()">Execute ' + due.length + ' due job(s)</button>'
    : '';
  const newJobBtn = '<button class="btn-sm" onclick="showNewAutomationJobForm()">+ New job</button>';
  return '<div class="trace-item" id="automationRunsSection" style="margin:6px 4px">'
    + '<div class="trace-title">⚙ Automation jobs (' + jobs.length + ') ' + schedulerBadge + ' ' + dueBadge + '</div>'
    + '<div class="trace-meta">Grants: ' + (policy.activeGrantCount || 0) + ' active · Kill switch: ' + (policy.killSwitchActive ? 'engaged' : 'off') + '</div>'
    + '<div style="margin-top:6px">' + jobRows + '</div>'
    + '<div class="inline-actions" style="margin-top:6px">' + newJobBtn + ' ' + executeBtn + '</div>'
    + '<div id="newAutomationJobForm" style="display:none;margin-top:8px;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px">'
    + '<input id="newJobName" type="text" placeholder="Job name" style="width:100%;padding:4px 6px;margin-bottom:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px">'
    + '<input id="newJobPrompt" type="text" placeholder="Prompt text" style="width:100%;padding:4px 6px;margin-bottom:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px">'
    + '<input id="newJobSchedule" type="text" placeholder="Schedule (e.g. every 2h, 30m, 0 9 * * *)" style="width:100%;padding:4px 6px;margin-bottom:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px">'
    + '<input id="newJobScript" type="text" placeholder="Script command (optional)" style="width:100%;padding:4px 6px;margin-bottom:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px">'
    + '<div class="inline-actions"><button class="btn-sm" onclick="createAutomationJob()">Create</button> <button class="btn-sm" onclick="hideNewAutomationJobForm()">Cancel</button></div>'
    + '</div>'
    + renderAutomationRunLog(entries)
    + '</div>';
}

function renderAutomationRunLog(entries) {
  if (!entries || entries.length === 0) return '';
  const rows = entries.slice(0, 20).map((entry, i) => {
    const ts = entry.ranAt ? new Date(entry.ranAt).toLocaleString() : '?';
    const color = entry.success === false ? '#ff5050' : '#50c878';
    const name = entry.name || entry.jobId || '?';
    const viewBtn = entry.outputPath
      ? ' <button class="btn-sm" style="font-size:10px;padding:1px 4px" onclick="viewAutomationRunOutput(\'' + escAttr(entry.outputPath) + '\', this)">View</button>'
      : '';
    return '<div class="trace-meta" style="font-size:11px"><span style="color:' + color + '">' + (entry.success === false ? '✗' : '✓') + '</span> ' + esc(name) + ' <span style="color:var(--text-dim)">' + esc(ts) + '</span>' + viewBtn + '<div id="autoRunOutput' + i + '" style="display:none"></div></div>';
  }).join('');
  return '<details style="margin-top:8px"><summary class="trace-meta" style="cursor:pointer">Run history (last ' + Math.min(entries.length, 20) + ' of ' + entries.length + ')</summary>' + rows + '</details>';
}

async function viewAutomationRunOutput(outputPath, btn) {
  const parent = btn.parentElement;
  const outputDiv = parent ? parent.querySelector('[id^="autoRunOutput"]') : null;
  if (outputDiv && outputDiv.style.display !== 'none') { outputDiv.style.display = 'none'; btn.textContent = 'View'; return; }
  try {
    const response = await fetch('/api/automations/output?path=' + encodeURIComponent(outputPath));
    const data = await response.json();
    if (data.error) { alert('Could not load output: ' + data.error); return; }
    if (outputDiv) {
      outputDiv.style.display = 'block';
      outputDiv.innerHTML = '<pre style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:6px;margin:4px 0;font-size:11px;white-space:pre-wrap;max-height:200px;overflow-y:auto">' + esc(data.content) + '</pre>';
      btn.textContent = 'Hide';
    }
  } catch (error) { alert('Failed to load output: ' + (error.message || error)); }
}

async function executeAutomationDueJobs() {
  try {
    const response = await fetch('/api/automations/execute-due', { method: 'POST' });
    const data = await response.json();
    if (data.error) { alert('Execute failed: ' + data.error); return; }
    alert('Executed ' + (data.executed || 0) + ' due job(s).');
    loadRuns();
  } catch (error) { alert('Execute failed: ' + (error.message || error)); }
}

function showNewAutomationJobForm() {
  const form = document.getElementById('newAutomationJobForm');
  if (form) form.style.display = 'block';
}

function hideNewAutomationJobForm() {
  const form = document.getElementById('newAutomationJobForm');
  if (form) form.style.display = 'none';
}

async function createAutomationJob() {
  const name = document.getElementById('newJobName')?.value?.trim();
  const prompt = document.getElementById('newJobPrompt')?.value?.trim();
  const schedule = document.getElementById('newJobSchedule')?.value?.trim();
  const scriptCommand = document.getElementById('newJobScript')?.value?.trim() || undefined;
  if (!name || !prompt || !schedule) { alert('Name, prompt, and schedule are required.'); return; }
  try {
    const response = await fetch('/api/automations/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, prompt, schedule, scriptCommand }),
    });
    const data = await response.json();
    if (data.error) { alert('Create failed: ' + data.error); return; }
    hideNewAutomationJobForm();
    loadRuns();
  } catch (error) { alert('Create failed: ' + (error.message || error)); }
}

async function deleteAutomationJob(jobId) {
  if (!confirm('Delete this automation job?')) return;
  try {
    const response = await fetch('/api/automations/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) { alert('Delete failed: ' + data.error); return; }
    loadRuns();
  } catch (error) { alert('Delete failed: ' + (error.message || error)); }
}

async function toggleAutomationJob(jobId, enabled) {
  try {
    const response = await fetch('/api/automations/jobs/' + encodeURIComponent(jobId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json();
    if (data.error) { alert('Toggle failed: ' + data.error); return; }
    loadRuns();
  } catch (error) { alert('Toggle failed: ' + (error.message || error)); }
}

function editAutomationJob(jobId, name, prompt, schedule, scriptCommand) {
  const newName = window.prompt('Job name:', name);
  if (newName === null) return;
  const newPrompt = window.prompt('Prompt:', prompt);
  if (newPrompt === null) return;
  const newSchedule = window.prompt('Schedule (e.g. every 2h, 30m, 0 9 * * *):', schedule);
  if (newSchedule === null) return;
  const newScript = window.prompt('Script command (leave empty for none):', scriptCommand);
  if (newScript === null) return;
  const body = {};
  if (newName.trim() !== name) body.name = newName.trim();
  if (newPrompt.trim() !== prompt) body.prompt = newPrompt.trim();
  if (newSchedule.trim() !== schedule) body.schedule = newSchedule.trim();
  if (newScript.trim() !== (scriptCommand || '')) body.scriptCommand = newScript.trim() || null;
  if (Object.keys(body).length === 0) return;
  fetch('/api/automations/jobs/' + encodeURIComponent(jobId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).then((data) => {
    if (data.error) { alert('Edit failed: ' + data.error); return; }
    loadRuns();
  }).catch((error) => alert('Edit failed: ' + (error.message || error)));
}

function renderCuratorRunsSection(curator) {
  if (!curator || !Array.isArray(curator.log) || curator.log.length === 0) return '';
  // Group entries by run boundary: each scheduled run starts with no prior
  // archive in the same minute window, so we just show the most recent 15
  // log lines as a flat list — small surface, no need to over-structure.
  const recent = curator.log.slice(-15).reverse();
  const rows = recent.map((entry) => {
    const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '?';
    const phase = esc(entry.phase || 'curator');
    const action = entry.action ? ' · ' + esc(entry.action) : '';
    const skill = entry.skill ? ' · ' + esc(entry.skill) : '';
    const note = entry.error ? ' · err: ' + esc(entry.error) : entry.skipped ? ' · skipped: ' + esc(entry.skipped) : entry.umbrella ? ' · umbrella: ' + esc(entry.umbrella) : entry.archived ? ' · archived: ' + (Array.isArray(entry.archived) ? entry.archived.join(', ') : entry.archived) : '';
    const color = entry.error ? '#ff5050' : entry.action === 'archive' || entry.phase === 'merge-applied' ? '#ffb050' : '#5bb0ff';
    return '<div class="trace-meta" style="font-size:11px;color:' + color + '">' + esc(ts) + ' · ' + phase + action + skill + note + '</div>';
  }).join('');
  return '<div class="trace-item" id="curatorRunsSection" style="margin:6px 4px"><div class="trace-title">🧹 Curator activity (' + curator.log.length + ' total)</div>'
    + '<div class="trace-meta">Scheduler: ' + (curator.schedulerRunning ? 'running' : 'idle') + ' · Last run: ' + esc(curator.settings?.lastRunAt ? new Date(curator.settings.lastRunAt).toLocaleString() : 'never') + '</div>'
    + '<div style="margin-top:6px">' + (rows || '<div class="trace-meta">No log entries.</div>') + '</div>'
    + '</div>';
}

function renderRunRow(run) {
  const statusColor = run.status === 'completed' ? '#50c878'
    : run.status === 'error' ? '#ff5050'
    : run.status === 'running' ? '#5bb0ff'
    : run.status === 'aborted' ? '#ffb050'
    : '#888';
  const statusBadge = '<span class="capability-pill" style="border-color:' + statusColor + ';color:' + statusColor + '">' + esc(run.status) + '</span>';
  const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : '?';
  const duration = run.durationMs ? formatRunDuration(run.durationMs) : (run.status === 'running' ? 'in progress' : '—');
  const errorRow = run.lastError ? '<div class="trace-meta" style="color:#ff5050">' + esc(run.lastError) + '</div>' : '';
  const checkpointsRow = run.checkpointCount ? '<div class="trace-meta">Checkpoints: ' + run.checkpointCount + '</div>' : '';
  const agentBadge = run.agentName ? ' <span class="capability-pill">' + esc((run.agentAvatar || '🤖') + ' ' + run.agentName) + '</span>' : '';
  return '<div class="trace-item">'
    + '<div class="trace-title">' + esc(run.title) + ' ' + statusBadge + agentBadge + '</div>'
    + '<div class="trace-meta">' + esc(created) + ' · ' + esc(run.model || 'unknown model') + ' · ' + esc(duration) + '</div>'
    + checkpointsRow
    + errorRow
    + '<div class="inline-actions" style="margin-top:6px">'
    +   '<button class="btn-sm" onclick="openRunSession(\'' + escAttr(run.sessionId) + '\')">Open transcript</button> '
    +   '<button class="btn-sm" onclick="copyRunId(\'' + escAttr(run.sessionId) + '\', this)">Copy ID</button>'
    + '</div>'
    + '</div>';
}

function formatRunDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return minutes + 'm ' + remSeconds + 's';
}

function openRunSession(sessionId) {
  window.open('/api/sessions/' + encodeURIComponent(sessionId), '_blank');
}

function copyRunId(sessionId, button) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(sessionId).then(() => {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    }).catch(() => {});
  }
}

// ─── Workflows tab ────────────────────────────────────────────────
async function loadWorkflows() {
  const view = document.getElementById('workflowsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">Workflows</div><div class="trace-meta">Loading…</div></div>';
  try {
    const [defsR, runsR] = await Promise.allSettled([
      fetch('/api/workflows').then((r) => r.json()),
      fetch('/api/workflows/runs').then((r) => r.json()),
    ]);
    const defs = defsR.status === 'fulfilled' ? (defsR.value.workflows || []) : [];
    const runs = runsR.status === 'fulfilled' ? (runsR.value.runs || []) : [];
    const header = '<div class="panel-header" style="border-bottom:none"><h3>Workflows</h3><div class="inline-actions"><button class="btn-sm" onclick="loadWorkflows()">Refresh</button></div></div>';
    const intro = '<div class="trace-meta" style="padding:0 4px 6px">Declarative tool sequences in <code>.harness/workflows/</code>. Use dry-run first; pause/resume/cancel any in-flight run.</div>';
    let defsHtml;
    if (defs.length === 0) {
      defsHtml = '<div class="trace-meta" style="padding:8px">No workflows yet. Drop a YAML file into <code>.harness/workflows/</code>.</div>';
    } else {
      defsHtml = '<div class="trace-list">' + defs.map(renderWorkflowDef).join('') + '</div>';
    }
    const runsHtml = runs.length === 0 ? '' : '<div class="trace-title" style="margin-top:12px;padding:0 4px">Recent runs</div><div class="trace-list">' + runs.slice(0, 20).map(renderWorkflowRun).join('') + '</div>';
    view.innerHTML = header + intro + defsHtml + runsHtml;
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}

function renderWorkflowDef(def) {
  const riskColor = def.riskLevel === 'high' ? '#ff5050' : def.riskLevel === 'medium' ? '#ffb050' : '#50c878';
  const riskBadge = '<span class="capability-pill" style="border-color:' + riskColor + ';color:' + riskColor + '">' + esc(def.riskLevel || 'low') + '</span>';
  return '<div class="trace-item">'
    + '<div class="trace-title">' + esc(def.name) + ' ' + riskBadge + '</div>'
    + '<div class="trace-meta">' + esc(def.description || '(no description)') + '</div>'
    + '<div class="trace-meta">' + def.stepCount + ' step(s)</div>'
    + '<div class="inline-actions" style="margin-top:6px">'
    +   '<button class="btn-sm" onclick="runWorkflow(\'' + escAttr(def.name) + '\', true)">Dry-run</button> '
    +   '<button class="btn-sm primary" onclick="runWorkflow(\'' + escAttr(def.name) + '\', false)">Run</button>'
    + '</div>'
    + '</div>';
}

function renderWorkflowRun(run) {
  const statusColor = run.status === 'completed' ? '#50c878'
    : run.status === 'failed' ? '#ff5050'
    : run.status === 'cancelled' ? '#ffb050'
    : run.status === 'paused' ? '#5bb0ff'
    : run.status === 'running' ? '#5bb0ff'
    : '#888';
  const statusBadge = '<span class="capability-pill" style="border-color:' + statusColor + ';color:' + statusColor + '">' + esc(run.status) + '</span>';
  const dryBadge = run.dryRun ? ' <span class="capability-pill">dry-run</span>' : '';
  const completedSteps = (run.steps || []).filter((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'denied' || s.status === 'skipped').length;
  const totalSteps = (run.steps || []).length;
  const stepLines = (run.steps || []).map((s) => {
    const sColor = s.status === 'completed' ? '#50c878' : s.status === 'failed' || s.status === 'denied' ? '#ff5050' : s.status === 'skipped' ? '#888' : s.status === 'running' ? '#5bb0ff' : '#666';
    const detail = s.error ? ' — ' + esc(s.error) : (s.result?.output ? ' — ' + esc(String(s.result.output).slice(0, 80)) : '');
    return '<div style="font-size:11px;color:' + sColor + '">' + esc(s.step.id) + ' (' + esc(s.step.tool) + ') · ' + esc(s.status) + detail + '</div>';
  }).join('');
  const controls = run.status === 'running'
    ? '<button class="btn-sm" onclick="pauseWorkflowRun(\'' + escAttr(run.id) + '\')">Pause</button> <button class="btn-sm danger" onclick="cancelWorkflowRun(\'' + escAttr(run.id) + '\')">Cancel</button>'
    : run.status === 'paused'
      ? '<button class="btn-sm" onclick="resumeWorkflowRun(\'' + escAttr(run.id) + '\')">Resume</button> <button class="btn-sm danger" onclick="cancelWorkflowRun(\'' + escAttr(run.id) + '\')">Cancel</button>'
      : '';
  return '<div class="trace-item">'
    + '<div class="trace-title">' + esc(run.workflowName) + ' ' + statusBadge + dryBadge + '</div>'
    + '<div class="trace-meta">' + esc(run.id) + ' · started ' + esc(new Date(run.startedAt).toLocaleString()) + ' · ' + completedSteps + '/' + totalSteps + ' steps</div>'
    + (stepLines ? '<div style="margin-top:4px">' + stepLines + '</div>' : '')
    + (controls ? '<div class="inline-actions" style="margin-top:6px">' + controls + '</div>' : '')
    + '</div>';
}

async function runWorkflow(name, dryRun) {
  try {
    const response = await fetch('/api/workflows/' + encodeURIComponent(name) + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    const data = await response.json();
    if (data.error) { alert('Workflow failed to start: ' + data.error); return; }
    setTimeout(loadWorkflows, 300);
  } catch (error) { alert('Workflow failed to start: ' + (error.message || error)); }
}

async function pauseWorkflowRun(id) {
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadWorkflows();
}

async function resumeWorkflowRun(id) {
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  setTimeout(loadWorkflows, 300);
}

async function cancelWorkflowRun(id) {
  if (!confirm('Cancel this workflow run?')) return;
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadWorkflows();
}

function renderMcpCatalogList() {
  const listEl = document.getElementById('mcpCatalogList');
  const filterEl = document.getElementById('mcpCatalogFilter');
  if (!listEl || !window._mcpCatalog) return;
  const q = (filterEl && filterEl.value || '').trim().toLowerCase();
  const rows = window._mcpCatalog.filter((entry) => {
    if (!q) return true;
    const hay = (entry.name + ' ' + entry.description + ' ' + (entry.tags || []).join(' ')).toLowerCase();
    return hay.includes(q);
  });
  if (rows.length === 0) { listEl.innerHTML = '<div class="trace-meta">No matches.</div>'; return; }
  listEl.innerHTML = rows.map((entry) => {
    const envLine = (entry.requiresEnv || []).length
      ? '<div class="trace-meta"><strong>requires</strong> ' + esc((entry.requiresEnv || []).join(', ')) + '</div>'
      : '';
    return '<div class="trace-row">'
      + '<div><strong>' + esc(entry.name) + '</strong> <span class="capability-pill">' + esc((entry.tags || []).join(' · ')) + '</span></div>'
      + '<div class="trace-meta">' + esc(entry.description) + '</div>'
      + '<div style="display:flex;gap:6px;align-items:center;margin-top:4px">'
      + '<code style="flex:1;background:var(--surface3);border:1px solid var(--border);border-radius:5px;padding:4px 6px;font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(entry.install) + '</code>'
      + '<button class="btn-sm" onclick="copyMcpInstall(' + JSON.stringify(entry.install).replace(/"/g, '&quot;') + ', this)">Copy</button>'
      + '<a class="btn-sm" target="_blank" rel="noopener" href="' + escAttr(entry.homepage) + '">Docs</a>'
      + '</div>'
      + envLine
      + '</div>';
  }).join('');
}

function copyMcpInstall(text, btn) {
  try {
    navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { if (btn) btn.textContent = original; }, 1200);
    }
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
}

// ─── Voice input (browser STT via Web Speech API) ──────────────────
// Free, no server changes, works fully offline in Chrome/Edge. Toggling
// 🎤 starts/stops recognition. Recognized phrases append to the chat
// input so the user can review before sending.

let voiceRecognition = null;
let voiceActive = false;

function toggleVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    alert('Voice input requires Web Speech API support. Try Chrome or Edge.');
    return;
  }
  const btn = document.getElementById('voiceBtn');
  if (voiceActive && voiceRecognition) {
    voiceRecognition._stoppedByUser = true;
    voiceRecognition.stop();
    return;
  }
  voiceRecognition = new Recognition();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = false;
  voiceRecognition.lang = (navigator.language || 'en-US');
  voiceActive = true;
  if (btn) { btn.classList.add('recording'); btn.title = 'Stop voice input and send'; }
  voiceRecognition.onresult = (event) => {
    const inp = document.getElementById('chatInput');
    if (!inp) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const text = result[0].transcript.trim();
      if (!text) continue;
      const sep = inp.value && !/\s$/.test(inp.value) ? ' ' : '';
      inp.value = inp.value + sep + text;
      autoSize(inp);
    }
  };
  voiceRecognition.onerror = (event) => {
    console.warn('voice recognition error:', event.error);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      alert('Microphone permission denied. Allow microphone access in your browser to use voice input.');
    }
  };
  voiceRecognition.onend = () => {
    const shouldSend = voiceRecognition && voiceRecognition._stoppedByUser;
    voiceActive = false;
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice input (browser STT)'; }
    voiceRecognition = null;
    if (shouldSend) {
      const inp = document.getElementById('chatInput');
      if (inp && inp.value.trim()) {
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) { sendBtn.textContent = '⏳'; sendBtn.disabled = false; }
        setTimeout(() => {
          if (sendBtn) sendBtn.textContent = '➤';
          sendMessage();
        }, 300);
      }
    }
  };
  try { voiceRecognition.start(); } catch (e) {
    voiceActive = false;
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice input (browser STT)'; }
    alert('Could not start voice input: ' + e.message);
  }
}

// ─── Mycelium tab ───────────────────────────────────────────────────

async function resetMyceliumGraph() {
  if (!confirm('Reset the mycelium graph? All learned routes will be lost.')) return;
  try {
    const response = await fetch('/api/mycelium', { method: 'DELETE' });
    const data = await response.json();
    if (data.error) { alert('Reset failed: ' + data.error); return; }
    loadMycelium();
  } catch (error) { alert('Reset failed: ' + (error.message || error)); }
}

async function loadMycelium() {
  const view = document.getElementById('myceliumView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">🍄 Mycelium Network</div><div class="trace-meta">Loading…</div></div>';
  try {
    const data = await fetch('/api/mycelium').then((r) => r.json());
    if (data.error) { view.innerHTML = '<div class="trace-meta">Failed: ' + esc(data.error) + '</div>'; return; }
    const stats = data.stats || {};
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const edges = Array.isArray(data.edges) ? data.edges : [];
    const episodes = Array.isArray(data.episodes) ? data.episodes : [];

    const header = '<div class="panel-header" style="border-bottom:none"><h3>🍄 Mycelium Network</h3><div class="inline-actions"><button class="btn-sm" onclick="loadMycelium()">Refresh</button> <button class="btn-sm danger" onclick="resetMyceliumGraph()">Reset</button></div></div>';

    const statsHtml = '<div class="trace-meta" style="padding:0 4px 6px">'
      + 'Nodes: ' + (stats.nodes || 0) + ' · Edges: ' + (stats.edges || 0) + ' · Episodes: ' + (stats.episodes || 0) + ' · Avg weight: ' + (stats.avgWeight || 0)
      + '</div>';

    // Group nodes by type
    const nodesByType = {};
    for (const node of nodes) {
      if (!nodesByType[node.type]) nodesByType[node.type] = [];
      nodesByType[node.type].push(node);
    }

    const typeColors = { query: '#5bb0ff', memory: '#b080ff', tool: '#50c878', skill: '#ffb050', agent: '#ff5050', strategy: '#8ab4f8', document: '#888', output: '#50c878' };

    const nodesSections = Object.entries(nodesByType).sort(([a], [b]) => a.localeCompare(b)).map(([type, typeNodes]) => {
      const color = typeColors[type] || '#888';
      const rows = typeNodes.map((node) => {
        const trustBar = '<span style="display:inline-block;width:40px;height:6px;background:var(--border);border-radius:3px;margin-left:6px;vertical-align:middle"><span style="display:block;width:' + Math.round(node.trust * 100) + '%;height:100%;background:' + color + ';border-radius:3px"></span></span>';
        return '<div class="trace-meta" style="font-size:11px">'
          + '<span style="color:' + color + '">●</span> '
          + '<strong>' + esc(node.label) + '</strong>'
          + ' trust:' + (node.trust || 0).toFixed(2) + trustBar
          + ' cost:' + (node.cost || 0).toFixed(2)
          + '</div>';
      }).join('');
      return '<details' + (typeNodes.length <= 5 ? ' open' : '') + '><summary class="trace-meta" style="cursor:pointer;color:' + color + '">' + esc(type) + ' (' + typeNodes.length + ')</summary>' + rows + '</details>';
    }).join('');

    const nodesPanel = nodes.length === 0
      ? '<div class="trace-meta">No nodes yet. Chat with the harness to grow the network.</div>'
      : nodesSections;

    // Edges: show top 20 by weight
    const topEdges = edges.sort((a, b) => b.weight - a.weight).slice(0, 20);
    const edgeRows = topEdges.map((edge) => {
      const sourceLabel = edge.source.replace(/^[^.]+\./, '');
      const targetLabel = edge.target.replace(/^[^.]+\./, '');
      const barWidth = Math.round(edge.weight * 100);
      return '<div class="trace-meta" style="font-size:11px">'
        + esc(sourceLabel) + ' → ' + esc(targetLabel)
        + ' <span style="display:inline-block;width:60px;height:6px;background:var(--border);border-radius:3px;vertical-align:middle"><span style="display:block;width:' + barWidth + '%;height:100%;background:#50c878;border-radius:3px"></span></span>'
        + ' ' + edge.weight.toFixed(3)
        + ' (✓' + (edge.successCount || 0) + ' ✗' + (edge.failureCount || 0) + ')'
        + '</div>';
    }).join('');

    const edgesPanel = edges.length === 0
      ? '<div class="trace-meta">No edges yet.</div>'
      : '<details open><summary class="trace-meta" style="cursor:pointer">Top edges by weight (' + Math.min(edges.length, 20) + ' of ' + edges.length + ')</summary>' + edgeRows + '</details>';

    // Episodes: last 10
    const recentEpisodes = episodes.slice(0, 10);
    const episodeRows = recentEpisodes.map((ep) => {
      const ts = ep.timestamp ? new Date(ep.timestamp).toLocaleString() : '?';
      const routeStr = (ep.route || []).map((id) => id.replace(/^[^.]+\./, '')).join(' → ');
      const rewardColor = ep.reward > 0.5 ? '#50c878' : ep.reward > 0.3 ? '#ffb050' : '#ff5050';
      return '<div class="trace-meta" style="font-size:11px">'
        + '<span style="color:' + rewardColor + '">' + (ep.reward || 0).toFixed(2) + '</span> '
        + esc(routeStr || '(empty)')
        + ' <span style="color:var(--text-dim)">' + esc(ts) + '</span>'
        + '</div>';
    }).join('');

    const episodesPanel = episodes.length === 0
      ? '<div class="trace-meta">No episodes yet. Routes are recorded after each chat.</div>'
      : '<details><summary class="trace-meta" style="cursor:pointer">Recent episodes (' + Math.min(episodes.length, 10) + ' of ' + episodes.length + ')</summary>' + episodeRows + '</details>';

    view.innerHTML = header + statsHtml
      + '<div class="trace-list">'
      + '<div class="trace-item"><div class="trace-title">Nodes</div>' + nodesPanel + '</div>'
      + '<div class="trace-item"><div class="trace-title">Edges</div>' + edgesPanel + '</div>'
      + '<div class="trace-item"><div class="trace-title">Episodes</div>' + episodesPanel + '</div>'
      + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }