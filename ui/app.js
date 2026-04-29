marked.setOptions({ breaks: true, gfm: true });

let isSending = false;
let chatMessages = [];
let currentChatId = null;
let lastSessionId = null;
let pendingFiles = [];
let permissionPollTimer = null;
let activeChatController = null;
let activeTraceExport = null;
let currentModelRouting = {};
let currentMediaTools = {};
let currentOutputValidation = { enabled: false, profile: 'oracle-prime', autoSelect: true };
let currentOutputValidationProfiles = [];
let currentOutputValidationTemplates = [];
let currentWalkthrough = { completed: [] };
let availableModels = [];

window.addEventListener('DOMContentLoaded', () => {
  ensurePermissionPanel();
  loadModels();
  loadHistory();
  loadFiles();
  loadSettings();
  loadOutputValidationTemplates();
  loadAbout();
  loadTraceExports();
  loadRuntimeStorage();
  loadRecovery();
  startPermissionPolling();
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
  hint.innerHTML = '<strong>' + esc(model.name) + '</strong><div>' + pills + '</div><div>' + esc(notes || 'Harness detected a text chat model. Attachments are still available as local file paths for tools and analysis.') + '</div>';
  renderAttachmentHint();
}

function capabilityPill(label, enabled) {
  return '<span class="capability-pill">' + (enabled ? '✓ ' : '○ ') + esc(label) + '</span>';
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
  hint.textContent = 'Attach text, data, image, or audio files. Harness shows the media type and passes the local file path into your message.';
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    if (s.temperature !== undefined) { document.getElementById('tempSlider').value = s.temperature; document.getElementById('tempVal').textContent = s.temperature; }
    if (s.topP !== undefined) { document.getElementById('topPSlider').value = s.topP; document.getElementById('topPVal').textContent = s.topP; }
    if (s.systemPrompt) document.getElementById('sysPrompt').value = s.systemPrompt;
    if (s.ollamaHost) document.getElementById('ollamaHost').value = s.ollamaHost;
    if (s.summarizerModel) document.getElementById('summarizerModel').value = s.summarizerModel;
    if (s.contextMaxTokens) document.getElementById('contextMaxTokens').value = s.contextMaxTokens;
    renderContextDetails(s.context || { configuredMaxTokens: s.contextMaxTokens, detectedMaxTokens: null, effectiveMaxTokens: s.contextMaxTokens });
    currentModelRouting = s.modelRouting || {};
    currentMediaTools = s.mediaTools || {};
    currentOutputValidation = s.outputValidation || { enabled: false, profile: 'oracle-prime', autoSelect: true };
    currentOutputValidationProfiles = s.outputValidationProfiles || [];
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
    if (firstRunHost) firstRunHost.value = s.ollamaHost || 'http://localhost:11434';
    if (firstRunVision) firstRunVision.value = currentMediaTools.visionModel || '';
    if (firstRunAudio) firstRunAudio.value = currentMediaTools.audioTranscribeCommand || '';
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
  panel.innerHTML = '<div class="about-grid">' + rows.map(([label, value]) => '<div><strong>' + esc(label) + '</strong> ' + String(value).replace(/^((?!<a ).)*$/, (text) => esc(text)) + '</div>').join('') + '</div>';
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
    { profile: 'oracle-prime', label: 'Oracle Prime' },
    { profile: 'factual-answer', label: 'Factual Answer' },
    { profile: 'coding-answer', label: 'Coding Answer' },
    { profile: 'tool-result-summary', label: 'Tool Result Summary' },
  ];
  select.innerHTML = knownProfiles.map((profile) => '<option value="' + escAttr(profile.profile) + '">' + esc(profile.label || profile.profile) + '</option>').join('');
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

function updateMediaToolSetting(k, v) {
  const next = { ...currentMediaTools };
  if (String(v).trim()) next[k] = String(v).trim();
  else delete next[k];
  currentMediaTools = next;
  updateSetting('mediaTools', next);
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
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoSize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }
function sendTip(el) { document.getElementById('chatInput').value = el.textContent; sendMessage(); }

async function sendMessage() {
  if (isSending && activeChatController) {
    activeChatController.abort();
    return;
  }
  const inp = document.getElementById('chatInput');
  let text = inp.value.trim();
  const model = document.getElementById('modelSelect').value;
  if (pendingFiles.length > 0) {
    const fileInfo = pendingFiles.map((f) => '[Attached ' + mediaKind(f) + ': ' + f.name + ' at ' + f.path + ']').join('\n');
    const mediaConfig = '[Media tools: visionModel=' + (currentMediaTools.visionModel || model || 'not configured') + '; audioTranscribeCommand=' + (currentMediaTools.audioTranscribeCommand ? 'configured' : 'not configured') + '; pdfOcrCommand=' + (currentMediaTools.pdfOcrCommand ? 'configured' : 'not configured') + ']';
    text = (text ? text + '\n\n' : '') + '[Selected model: ' + model + ']\n' + mediaConfig + '\n' + fileInfo + '\n\nPlease analyze the attached file(s). For image attachments, use image_analyze with the configured vision model when available, otherwise use the selected model if it supports vision. For audio attachments, use audio_transcribe first, then analyze the transcript. For PDF attachments, use pdf_read (and pdf_metadata when document properties matter); set ocr=true if the first read returns no extractable text. If a required media tool is not configured, say that clearly.';
    pendingFiles = [];
    showAttached();
  }

  if (!text || isSending) return;
  if (!model) { alert('Select a model first.'); return; }
  await maybeSuggestOutputValidationProfile(text);
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
  addMsg('user', text);
  chatMessages.push({ role: 'user', content: text });
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
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model }), signal: activeChatController.signal });
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
          case 'error':
            thinkEl.remove();
            addMsg('assistant', '⚠️ ' + ev.message);
            break;
        }
      }
    }
    if (thinkEl.parentNode) thinkEl.remove();
    if (assistantText) chatMessages.push({ role: 'assistant', content: assistantText });
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
  document.getElementById('chatInput').focus();
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
  item.innerHTML = '<span>🧭</span><span class="tool-name">validation profile</span><span class="tool-detail">Auto-selected ' + esc(event.profile || 'default') + '. ' + esc(event.reason || '') + '</span>';
  toolBox.appendChild(item);
  scrollBottom();
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
  const av = role === 'user' ? 'Y' : '🤖';
  const label = role === 'user' ? 'You' : 'Assistant';
  el.innerHTML = '<div class="msg-avatar">' + av + '</div><div class="msg-body"><div class="msg-role">' + label + '</div><div class="msg-content"></div></div>';
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

async function loadChat(id) { try { const r = await fetch('/api/history/' + id); const d = await r.json(); currentChatId = id; chatMessages = d.messages || []; document.getElementById('chatArea').innerHTML = ''; for (const m of chatMessages) addMsg(m.role, m.content); loadHistory(); } catch {} }
async function autoSaveChat() { if (chatMessages.length < 2) return; const title = chatMessages[0].content.slice(0, 60); try { const r = await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentChatId, title, messages: chatMessages }) }); const d = await r.json(); if (!currentChatId) currentChatId = d.id; loadHistory(); } catch {} }
async function deleteChat(id) { await fetch('/api/history/' + id, { method: 'DELETE' }); if (id === currentChatId) newChat(); loadHistory(); }
function newChat() { currentChatId = null; chatMessages = []; document.getElementById('chatArea').innerHTML = welcomeMarkup(); renderModelCapabilityHint(); loadSettings(); loadHistory(); }
function welcomeMarkup() {
  return '<div class="welcome" id="welcome"><h2>Welcome to Harness</h2><p>Pick a model above, then ask me anything. I can read files, write code, run commands, search your project, create skills, and remember things across sessions.</p><div class="beginner-guide" id="beginnerGuide"><div class="guide-item"><strong>Ask</strong>Use plain English for project questions, code changes, searches, and local tasks.</div><div class="guide-item"><strong>Attach</strong>Drop files below. Images and audio show model support hints before you send.</div><div class="guide-item"><strong>Recover</strong>Resume continues unfinished work; Fork starts a copy for a different direction.</div></div><div class="walkthrough-checklist" id="walkthroughChecklist">' + walkthroughChecklistMarkup() + '</div><div class="first-run-setup" id="firstRunSetup"><h3>First-run setup</h3><p>Set the local Ollama host and optional media helpers before your first chat.</p><div class="first-run-grid"><div><label for="firstRunOllamaHost">Ollama host</label><input id="firstRunOllamaHost" type="text" value="http://localhost:11434"></div><div><label for="firstRunVisionModel">Vision model</label><input id="firstRunVisionModel" type="text" placeholder="llava"></div><div><label for="firstRunAudioCommand">Audio command</label><input id="firstRunAudioCommand" type="text" placeholder="whisper &quot;{input}&quot; --model base"></div><div><label for="firstRunAudioSamplePath">Audio test file</label><input id="firstRunAudioSamplePath" type="text" placeholder=".harness/uploads/sample.wav"></div></div><div class="first-run-actions"><button class="btn-sm" onclick="applyFirstRunSetup()">Save setup</button><button class="btn-sm" onclick="checkFirstRunHealth()">Check setup</button><span class="first-run-status" id="firstRunStatus">Optional. You can change these later in Settings.</span></div><div class="trace-detail initial-hidden" id="firstRunHealth"></div></div><div class="model-capability-hint" id="modelCapabilityHint">Choose a model to see whether Harness detects text, image, or audio support.</div><div class="tips"><div class="tip" onclick="sendTip(this)">List files in this project</div><div class="tip" onclick="sendTip(this)">What models do I have?</div><div class="tip" onclick="sendTip(this)">Create a skill for code review</div></div></div>';
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

async function loadSkills() { try { const r = await fetch('/api/skills'); const d = await r.json(); const list = document.getElementById('skillList'); list.innerHTML = ''; if (!d.skills || !d.skills.length) { list.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No skills yet.<br><br>Ask the agent to <strong>"create a skill for..."</strong> and it will build one automatically.</div>'; return; } for (const s of d.skills) { const el = document.createElement('div'); el.className = 'skill-item'; el.innerHTML = '<div class="sk-name">' + esc(s.name) + '</div><div class="sk-desc">' + esc(s.description) + '</div><div class="sk-meta"><span>' + esc(s.domain) + '</span><button class="sk-del" onclick="event.stopPropagation();deleteSkill(\'' + escAttr(s.name) + '\')">🗑</button></div>'; el.onclick = () => { document.getElementById('chatInput').value = 'Use the skill: ' + s.name; sendMessage(); }; list.appendChild(el); } } catch {} }
async function deleteSkill(name) { if (!confirm('Delete skill "' + name + '"?')) return; await fetch('/api/skills/' + name, { method: 'DELETE' }); loadSkills(); }

async function loadMemory() { try { const r = await fetch('/api/memory'); const d = await r.json(); const view = document.getElementById('memoryView'); if (!d.decisions && !d.patterns && !d.notes) { view.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No memories yet.<br><br>The agent saves decisions, patterns, and notes here as it learns.</div>'; return; } let html = ''; if (d.decisions) html += '<div class="mem-section"><h5>Decisions</h5><pre>' + esc(d.decisions) + '</pre></div>'; if (d.patterns) html += '<div class="mem-section"><h5>Patterns</h5><pre>' + esc(d.patterns) + '</pre></div>'; if (d.notes) html += '<div class="mem-section"><h5>Notes</h5><pre>' + esc(d.notes) + '</pre></div>'; view.innerHTML = html; } catch {} }

async function loadMemoryPalace() { try { const response = await fetch('/api/memory/palace'); const data = await response.json(); const view = document.getElementById('memoryPalaceView'); if (!data.rooms || !data.rooms.length) { view.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No palace rooms yet.</div>'; return; } view.innerHTML = '<div class="palace-grid">' + data.rooms.map((room) => '<div class="palace-room"><div class="palace-title">' + esc(room.title) + '</div><div class="palace-meta">' + room.entryCount + ' memories · ' + room.sessions.length + ' sessions</div>' + room.anchors.map((anchor) => '<button class="palace-anchor" onclick="loadPalaceEntry(\'' + escAttr(anchor.id) + '\')"><strong>' + esc(anchor.kind) + '</strong> · ' + esc(anchor.text) + '</button>').join('') + '</div>').join('') + '</div><div id="palaceDetail" class="palace-detail initial-hidden"></div>'; } catch (error) { document.getElementById('memoryPalaceView').textContent = error.message; } }

async function loadPalaceEntry(id) { const detail = document.getElementById('palaceDetail'); if (!detail) return; detail.classList.remove('initial-hidden'); detail.textContent = 'Loading memory entry...'; try { const entryResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id)); const entryData = await entryResponse.json(); if (entryData.error) { detail.textContent = entryData.error; return; } const contextResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id) + '/context?window=3'); const contextData = await contextResponse.json(); const entry = entryData.entry; const transcriptRows = (contextData.events || []).map((event) => '<div class="transcript-row' + (event.isAnchor ? ' anchor' : '') + '"><div><strong>' + esc(event.kind) + '</strong> · ' + esc(event.timestamp) + '</div><div style="white-space:pre-wrap;color:var(--text)">' + esc(event.text || '[empty]') + '</div></div>').join(''); detail.innerHTML = '<div><strong>Session</strong> ' + esc(entry.sessionId) + '</div><div><strong>Event</strong> ' + esc(entry.id) + '</div><div><strong>Kind</strong> ' + esc(entry.kind) + '</div><div><strong>Time</strong> ' + esc(entry.timestamp) + '</div><div style="margin-top:6px;white-space:pre-wrap;color:var(--text)">' + esc(entry.text) + '</div><div style="margin-top:10px"><strong>Transcript Context</strong>' + (transcriptRows || '<div class="transcript-row">No transcript context found.</div>') + '</div>'; } catch (error) { detail.textContent = error.message; } }

function showLeftTab(tab, el) { document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active')); el.classList.add('active'); document.getElementById('historyList').style.display = tab === 'history' ? 'block' : 'none'; document.getElementById('fileTree').style.display = tab === 'files' ? 'block' : 'none'; document.getElementById('skillList').style.display = tab === 'skills' ? 'block' : 'none'; document.getElementById('memoryView').style.display = tab === 'memory' ? 'block' : 'none'; document.getElementById('memoryPalaceView').style.display = tab === 'palace' ? 'block' : 'none'; document.getElementById('learningView').style.display = tab === 'learning' ? 'block' : 'none'; if (tab === 'files') loadFiles(); if (tab === 'skills') loadSkills(); if (tab === 'memory') loadMemory(); if (tab === 'palace') loadMemoryPalace(); if (tab === 'learning') loadLearning(); }
function toggleLeft() { document.getElementById('leftPanel').classList.toggle('hidden'); }
function toggleRight() { document.getElementById('rightPanel').classList.toggle('hidden'); }

async function pullModel() { const name = document.getElementById('pullName').value.trim(); if (!name) return; const prog = document.getElementById('pullProgress'); prog.textContent = 'Starting...'; try { const res = await fetch('/api/models/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const p = line.slice(6); if (p === '[DONE]') { prog.textContent = 'Done!'; loadModels(); return; } try { const d = JSON.parse(p); if (d.error) { prog.textContent = 'Error: ' + d.error; return; } if (d.status) { const pct = d.completed && d.total ? ' (' + Math.round(d.completed / d.total * 100) + '%)' : ''; prog.textContent = d.status + pct; } } catch {} } } } catch (e) { prog.textContent = 'Failed: ' + e.message; } }

async function loadLearning() { try { const r = await fetch('/api/learning'); const d = await r.json(); const view = document.getElementById('learningView'); let html = '<div style="padding:4px 0"><h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin-bottom:8px">🧠 Self-Learning Status</h5>'; html += '<div style="display:flex;gap:4px;margin-bottom:8px"><input id="semanticQuery" placeholder="Search session memory" style="flex:1;padding:6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px"><button class="btn-sm" onclick="searchSemanticMemory()">Search</button></div><div id="semanticResults"></div>'; html += '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Total tool calls tracked: <strong style="color:var(--text)">' + ((d.totalToolCalls) || 0) + '</strong></div>'; if (d.toolBreakdown && Object.keys(d.toolBreakdown).length > 0) { html += '<div style="margin-bottom:12px">'; for (const [tool, count] of Object.entries(d.toolBreakdown || {})) html += '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0"><span>' + esc(tool) + '</span><span style="color:var(--accent)">' + count + '</span></div>'; html += '</div>'; } const patterns = d.patterns || []; if (patterns.length > 0) { html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Detected Patterns</h5>'; for (const p of patterns.slice(0, 5)) html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:4px;font-size:11px"><div style="color:var(--accent);font-weight:600">' + esc(p.toolSequence.join(' → ')) + '</div><div style="color:var(--text-dim)">' + p.occurrences + 'x across sessions' + (p.promoted ? ' ✅ promoted' : '') + '</div></div>'; } const reflections = d.reflections || []; if (reflections.length > 0) { html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Recent Reflections</h5>'; for (const item of reflections.slice(-3)) { html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;padding:6px;background:var(--surface2);border-radius:6px"><div>Success: ' + Math.round(item.successRate * 100) + '% | Tools: ' + item.toolsUsed.join(', ') + '</div>'; if (item.insights.length) html += '<div style="color:var(--warning);margin-top:2px">' + esc(item.insights.join('; ')) + '</div>'; html += '</div>'; } } if (d.evolvedPrompt) html += '<h5 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:8px 0">Evolved Instructions</h5><pre style="font-size:10px;background:var(--surface2);padding:6px;border-radius:6px;white-space:pre-wrap;color:var(--text-dim)">' + esc(d.evolvedPrompt) + '</pre>'; html += '</div>'; view.innerHTML = html; renderLearningManager(d); } catch { document.getElementById('learningView').innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:13px;text-align:center">No learning data yet. Start chatting and the agent will begin tracking patterns.</div>'; } }

function renderLearningManager(data) {
  const view = document.getElementById('learningView');
  if (!view) return;
  view.innerHTML += renderRoutingMetrics(data) + renderCandidateQueue(data) + renderOutputValidationTrends(data) + renderEvalDatasetManager(data);
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

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }