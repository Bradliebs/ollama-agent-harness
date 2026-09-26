// Runs panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Runs tab ──────────────────────────────────────────────────────
async function loadRuns() {
  const view = document.getElementById('runsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-list"><div class="trace-title">Runs</div><div class="trace-meta">Loading…</div></div>';
  try {
    const [runsR, curatorR, discoveryR, autoRunsR, safetyR] = await Promise.allSettled([
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/curator').then((r) => r.json()),
      fetch('/api/discovery').then((r) => r.json()),
      fetch('/api/automations/runs').then((r) => r.json()),
      fetch('/api/automations/jobs/safety').then((r) => r.json()),
    ]);
    const data = runsR.status === 'fulfilled' ? runsR.value : { error: 'failed to load' };
    if (data.error) { view.innerHTML = '<div class="trace-meta">Failed: ' + esc(data.error) + '</div>'; return; }
    const runs = data.runs || [];
    const counts = data.counts || {};
    const runEvidence = Array.isArray(data.evidence) ? data.evidence : [];
    const summary = '<div class="panel-header panel-header-flat"><h3>Runs</h3><div class="inline-actions"><button class="btn-sm" onclick="loadRuns()">Refresh</button> <button class="btn-sm" onclick="document.getElementById(\'sessionImportFile\').click()">Import session</button><input type="file" id="sessionImportFile" accept=".json" style="display:none" onchange="importSessionFile(this.files)"></div></div>'
      + '<div class="trace-meta panel-copy">' + (data.total || 0) + ' chat run(s) · '
      + Object.entries(counts).map(([k, v]) => esc(k) + ': ' + v).join(' · ')
      + '</div>';
    const curatorSection = curatorR.status === 'fulfilled' ? renderCuratorRunsSection(curatorR.value) : '';
    const autoRunLog = autoRunsR.status === 'fulfilled' ? (autoRunsR.value.runs || []) : [];
    const automationSection = discoveryR.status === 'fulfilled' ? renderAutomationRunsSection(discoveryR.value.automations, autoRunLog, runEvidence, safetyR.status === 'fulfilled' ? safetyR.value.audit : null) : '';
    if (runs.length === 0) {
      view.innerHTML = summary + automationSection + curatorSection + '<div class="trace-meta panel-empty">(no chat runs yet — start a chat to record one)</div>';
      return;
    }
    const rows = runs.map(renderRunRow).join('');
    view.innerHTML = summary + automationSection + curatorSection + '<div class="trace-list">' + rows + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}

function renderAutomationRunsSection(automations, runLog, runEvidence, safetyAudit) {
  if (!automations) return '';
  const jobs = Array.isArray(automations.jobs) ? automations.jobs : [];
  const due = Array.isArray(automations.due) ? automations.due : [];
  const policy = automations.policy || {};
  const schedulerRunning = automations.schedulerRunning;
  const entries = Array.isArray(runLog) ? runLog : [];
  const evidence = Array.isArray(runEvidence) ? runEvidence.filter((card) => card.kind === 'automation' || card.kind === 'autonomy' || isOperatingServiceEvidence(card)) : [];
  const safety = safetyAudit || {};
  const safetyHtml = safety.totalJobs !== undefined
    ? '<div id="automationJobSafetyPanel" class="trace-meta">Safety audit: ' + esc(safety.archiveCandidateCount || 0) + ' archive candidate(s), ' + esc(safety.protectedCount || 0) + ' protected job(s). Run <code>npm run audit:automation-jobs</code> for details.</div>'
    : '';
  const schedulerBadge = schedulerRunning
    ? '<span class="capability-pill running-pill">running</span>'
    : '<span class="capability-pill muted-pill">idle</span>';
  const dueBadge = due.length > 0
    ? '<span class="capability-pill warning-pill">' + due.length + ' due</span>'
    : '';
  const jobRows = jobs.length === 0
    ? '<div class="trace-meta">No automation jobs configured.</div>'
    : jobs.map((job) => {
      const enabled = job.enabled !== false;
      const isDue = due.some((d) => d.id === job.id);
      const statusClass = isDue ? 'warning-pill' : enabled ? 'success-pill' : 'muted-pill';
      const statusLabel = isDue ? 'due' : enabled ? 'active' : 'disabled';
      const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'none';
      const lastRun = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never';
      const script = job.scriptCommand ? ' · script: ' + esc(job.scriptCommand) : '';
      return '<div class="trace-row">'
        + '<strong>' + esc(job.name) + '</strong> '
        + '<span class="capability-pill ' + statusClass + '">' + statusLabel + '</span>'
        + '<div class="trace-meta">' + esc(job.schedule?.display || '') + ' · next: ' + esc(nextRun) + ' · last: ' + esc(lastRun) + script + '</div>'
        + '<div class="inline-actions top-spaced">'
        + '<button class="btn-sm" onclick="runAutomationJobNow(\'' + escAttr(job.id) + '\')">Run now</button> '
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
  return '<div class="trace-item automation-runs-section" id="automationRunsSection">'
    + '<div class="trace-title">⚙ Automation jobs (' + jobs.length + ') ' + schedulerBadge + ' ' + dueBadge + '</div>'
    + '<div class="trace-meta">Grants: ' + (policy.activeGrantCount || 0) + ' active · Kill switch: ' + (policy.killSwitchActive ? 'engaged' : 'off') + '</div>'
    + safetyHtml
    + '<div class="trace-block-spaced">' + jobRows + '</div>'
    + '<div class="inline-actions trace-block-spaced">' + newJobBtn + ' ' + executeBtn + '</div>'
    + '<details class="details-mt6"><summary class="trace-meta trace-summary-sm">📋 Job templates</summary>'
    + '<div class="inline-actions template-action-row">'
    + '<button class="btn-sm" onclick="createJobFromTemplate(\'Daily digest\',\'Summarize today\\\'s automation results, completed tasks, system health, and any errors. Write the summary to daily-digest.md.\',\'1440 minutes\')">Daily digest</button>'
    + '<button class="btn-sm" onclick="createJobFromTemplate(\'Hotel price check\',\'Search booking.com for hotels in [city] for [dates] under [budget]. Save available rooms with prices and links to hotel-alert.md.\',\'1440 minutes\')">Hotel monitor</button>'
    + '<button class="btn-sm" onclick="createJobFromTemplate(\'Weekly report\',\'Create a weekly report covering completed tasks, automation runs, learned patterns, and system health. Export as PDF to weekly-report.pdf.\',\'10080 minutes\')">Weekly report</button>'
    + '<button class="btn-sm" onclick="createJobFromTemplate(\'Email reminder\',\'Send an email to [your@email.com] with subject \\\'Daily Reminder\\\' summarizing pending tasks and today\\\'s priorities.\',\'1440 minutes\')">Email reminder</button>'
    + '</div></details>'
    + '<div id="newAutomationJobForm" class="automation-wizard hidden-by-default">'
    +   '<div class="automation-wizard-title">New automation job</div>'
    +   '<div class="automation-field">'
    +     '<label for="newJobName">Name</label>'
    +     '<input id="newJobName" type="text" placeholder="e.g. Morning briefing">'
    +   '</div>'
    +   '<div class="automation-field">'
    +     '<label for="newJobSchedule">Schedule</label>'
    +     '<input id="newJobSchedule" type="text" placeholder="every 2h · 30 minutes · 0 9 * * *" oninput="previewAutomationSchedule(this.value)">'
    +     '<span class="automation-field-hint">Plain English (every 2h, 30 minutes), or a cron expression (0 9 * * *).</span>'
    +     '<span id="newJobSchedulePreview" class="automation-schedule-preview"></span>'
    +   '</div>'
    +   '<div class="automation-field">'
    +     '<label for="newJobPrompt">Step 1 — what should the agent do?</label>'
    +     '<textarea id="newJobPrompt" rows="3" placeholder="Summarize today\'s tasks, check inbox, write the digest to daily.md"></textarea>'
    +   '</div>'
    +   '<details class="details-mt6"><summary class="trace-meta clickable-summary">Advanced</summary>'
    +     '<div class="automation-field details-body-mt4">'
    +       '<label for="newJobScript">Script command (optional)</label>'
    +       '<input id="newJobScript" type="text" placeholder="node scripts/pre-run.js">'
    +       '<span class="automation-field-hint">Runs before the prompt; output is appended as context.</span>'
    +     '</div>'
    +   '</details>'
    +   '<div class="inline-actions"><button class="btn-sm primary" onclick="createAutomationJob()">Create job</button> <button class="btn-sm" onclick="hideNewAutomationJobForm()">Cancel</button></div>'
    + '</div>'
    + renderAutomationRunLog(entries)
    + renderRunEvidenceLog(evidence)
    + '</div>';
}

function isOperatingServiceEvidence(card) {
  const tools = Array.isArray(card?.tools) ? card.tools : [];
  return String(card?.runName || '').startsWith('Operating service ')
    || tools.some((tool) => String(tool?.name || '').startsWith('operating_services_'));
}

function renderRunEvidenceLog(evidence) {
  if (!evidence || evidence.length === 0) return '';
  const rows = evidence.slice(0, 12).map((card) => {
    const ts = card.createdAt ? new Date(card.createdAt).toLocaleString() : '?';
    const outcome = summarizeEvidenceOutcome(card);
    return '<div class="trace-meta trace-meta-sm"><strong>' + esc(card.runName || card.kind || 'run') + '</strong> <span class="text-dim">' + esc(ts) + '</span> · changed ' + esc(outcome.changedFiles) + ' · commands ' + esc(outcome.commandsRun) + ' · result ' + esc(outcome.validationStatus) + ' · risk ' + esc(outcome.riskLabel) + ' · ' + esc(outcome.nextAction) + '</div>';
  }).join('');
  return '<details class="details-mt8"><summary class="trace-meta clickable-summary">Evidence cards (last ' + Math.min(evidence.length, 12) + ' of ' + evidence.length + ')</summary>' + rows + '</details>';
}

function renderAutomationRunLog(entries) {
  if (!entries || entries.length === 0) return '';
  const rows = entries.slice(0, 20).map((entry, i) => {
    const ts = entry.ranAt ? new Date(entry.ranAt).toLocaleString() : '?';
    const statusClass = entry.success === false ? 'trace-meta-error' : 'trace-meta-success';
    const name = entry.name || entry.jobId || '?';
    const viewBtn = entry.outputPath
      ? ' <button class="btn-sm btn-xxs" onclick="viewAutomationRunOutput(\'' + escAttr(entry.outputPath) + '\', this)">View</button>'
      : '';
    return '<div class="trace-meta trace-meta-sm"><span class="' + statusClass + '">' + (entry.success === false ? '✗' : '✓') + '</span> ' + esc(name) + ' <span class="text-dim">' + esc(ts) + '</span>' + viewBtn + '<div id="autoRunOutput' + i + '" class="hidden-by-default"></div></div>';
  }).join('');
  return '<details class="details-mt8"><summary class="trace-meta clickable-summary">Run history (last ' + Math.min(entries.length, 20) + ' of ' + entries.length + ')</summary>' + rows + '</details>';
}

async function viewAutomationRunOutput(outputPath, btn) {
  const parent = btn.parentElement;
  const outputDiv = parent ? parent.querySelector('[id^="autoRunOutput"]') : null;
  if (outputDiv && !outputDiv.classList.contains('hidden-by-default')) { outputDiv.classList.add('hidden-by-default'); btn.textContent = 'View'; return; }
  try {
    const response = await fetch('/api/automations/output?path=' + encodeURIComponent(outputPath));
    const data = await response.json();
    if (data.error) { showToast('Could not load output: ' + data.error); return; }
    if (outputDiv) {
      outputDiv.classList.remove('hidden-by-default');
      outputDiv.innerHTML = '<pre class="automation-output-pre">' + esc(data.content) + '</pre>';
      btn.textContent = 'Hide';
    }
  } catch (error) { showToast('Failed to load output: ' + (error.message || error)); }
}

async function executeAutomationDueJobs() {
  try {
    const response = await fetch('/api/automations/execute-due', { method: 'POST' });
    const data = await response.json();
    if (data.error) { showToast('Execute failed: ' + data.error); return; }
    showToast('Executed ' + (data.executed || 0) + ' due job(s).');
    loadRuns();
  } catch (error) { showToast('Execute failed: ' + (error.message || error)); }
}

async function runAutomationJobNow(jobId) {
  try {
    const response = await fetch('/api/automations/' + encodeURIComponent(jobId) + '/execute', { method: 'POST' });
    const data = await response.json();
    if (data.error) { showToast('Run failed: ' + data.error); return; }
    showToast('Job "' + (data.name || jobId) + '" executed. Output: ' + (data.outputPath || 'none'));
    loadRuns();
  } catch (error) { showToast('Run failed: ' + (error.message || error)); }
}

function showNewAutomationJobForm() {
  const form = document.getElementById('newAutomationJobForm');
  if (form) form.classList.remove('hidden-by-default');
}

// Debounced schedule preview — calls /api/automations/preview and shows the
// resolved kind + next run time under the Schedule field.
let schedulePreviewTimer = null;
function previewAutomationSchedule(value) {
  const out = document.getElementById('newJobSchedulePreview');
  if (!out) return;
  if (schedulePreviewTimer) clearTimeout(schedulePreviewTimer);
  if (!value || !value.trim()) { out.textContent = ''; out.className = 'automation-schedule-preview'; return; }
  out.textContent = '…';
  out.className = 'automation-schedule-preview';
  schedulePreviewTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/automations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: value }),
      });
      const data = await response.json();
      if (!data.ok) {
        out.textContent = '✗ ' + (data.error || 'Invalid schedule');
        out.className = 'automation-schedule-preview error';
        return;
      }
      const next = data.nextRunAt ? new Date(data.nextRunAt).toLocaleString() : 'never';
      let detail = '✓ ' + data.schedule.kind + ' · next run: ' + next;
      if (data.schedule.kind === 'interval' && data.schedule.minutes) {
        const m = data.schedule.minutes;
        const human = m % 1440 === 0 ? (m / 1440) + 'd' : m % 60 === 0 ? (m / 60) + 'h' : m + 'm';
        detail += ' · then every ' + human;
      } else if (data.schedule.kind === 'cron' && data.schedule.expr) {
        detail += ' · cron ' + data.schedule.expr;
      }
      out.textContent = detail;
      out.className = 'automation-schedule-preview ok';
    } catch (error) {
      out.textContent = '✗ ' + (error.message || error);
      out.className = 'automation-schedule-preview error';
    }
  }, 300);
}

// Cross-tab launcher for the Flows panel: switches to Runs, loads the data,
// then opens the wizard and scrolls it into view.
async function openAutomationWizardFromFlows() {
  try { openLeftTabByName('runs'); } catch(e){}
  try { await loadRuns(); } catch(e){}
  setTimeout(() => {
    showNewAutomationJobForm();
    const form = document.getElementById('newAutomationJobForm');
    if (form && typeof form.scrollIntoView === 'function') form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

// --- Workflow wizard ---
function openWorkflowWizard() {
  const modal = document.getElementById('workflowWizard');
  if (!modal) return;
  document.getElementById('workflowWizardName').value = '';
  document.getElementById('workflowWizardDescription').value = '';
  document.getElementById('workflowWizardStatus').textContent = '';
  document.getElementById('workflowWizardSteps').innerHTML = '';
  // Fetch tool catalog once per wizard open so the per-step <datalist>
  // autocompletes real tool names. Cached on window for cheap reuse.
  fetchWorkflowToolList().then(() => addWorkflowWizardStep());
  modal.classList.remove('hidden-by-default');
}

async function fetchWorkflowToolList() {
  if (Array.isArray(window._workflowToolList) && window._workflowToolList.length > 0) return window._workflowToolList;
  try {
    const data = await fetch('/api/tools').then((r) => r.json());
    window._workflowToolList = (data.tools || []).map((t) => t.name).filter(Boolean).sort();
  } catch(e){ window._workflowToolList = []; }
  return window._workflowToolList;
}

function closeWorkflowWizard() {
  const modal = document.getElementById('workflowWizard');
  if (modal) modal.classList.add('hidden-by-default');
}

function addWorkflowWizardStep() {
  const container = document.getElementById('workflowWizardSteps');
  if (!container) return;
  const idx = container.children.length;
  const stepNumber = idx + 1;
  const tools = window._workflowToolList || [];
  const datalistId = 'wfToolList' + idx;
  const datalist = '<datalist id="' + datalistId + '">' + tools.map((t) => '<option value="' + escAttr(t) + '">').join('') + '</datalist>';
  const div = document.createElement('div');
  div.className = 'workflow-wizard-step';
  div.innerHTML = '<div class="workflow-wizard-step-header"><strong>Step ' + stepNumber + '</strong>'
    + '<button class="btn-sm" onclick="this.closest(\'.workflow-wizard-step\').remove()">Remove</button></div>'
    + '<div class="automation-field"><label>ID</label><input class="wf-step-id" type="text" placeholder="echo-step"></div>'
    + '<div class="automation-field"><label>Tool</label><input class="wf-step-tool" type="text" list="' + datalistId + '" placeholder="file_read">' + datalist + '</div>'
    + '<div class="automation-field"><label>Input (JSON)</label><textarea class="wf-step-input" rows="2" placeholder=\'{"path": "README.md"}\'></textarea></div>'
    + '<label class="attachment-hint"><input type="checkbox" class="wf-step-continue"> Continue on error</label>';
  container.appendChild(div);
}

// Starter workflow templates surfaced in the wizard so users don't stare at a
// blank step list. Each template emits id/tool/input strings that match the
// real tool registry (see /api/tools).
const WORKFLOW_TEMPLATES = {
  readSummarize: [
    { id: 'read', tool: 'file_read', input: '{"path": "README.md"}' },
    { id: 'summarize', tool: 'memory_write', input: '{"content": "Summary of README"}' },
  ],
  webSearchSave: [
    { id: 'search', tool: 'web_search', input: '{"query": "ollama agent harness"}' },
    { id: 'save', tool: 'file_write', input: '{"path": "agent-outputs/search.md", "content": "Results"}' },
  ],
  bashEcho: [
    { id: 'hello', tool: 'bash', input: '{"command": "echo hello"}' },
  ],
};

function applyWorkflowTemplate(key) {
  const tmpl = WORKFLOW_TEMPLATES[key];
  if (!tmpl) return;
  const container = document.getElementById('workflowWizardSteps');
  if (container) container.innerHTML = '';
  tmpl.forEach(() => addWorkflowWizardStep());
  // Backfill values into the freshly created step nodes.
  const nodes = Array.from(document.querySelectorAll('#workflowWizardSteps .workflow-wizard-step'));
  tmpl.forEach((step, i) => {
    const node = nodes[i];
    if (!node) return;
    node.querySelector('.wf-step-id').value = step.id;
    node.querySelector('.wf-step-tool').value = step.tool;
    node.querySelector('.wf-step-input').value = step.input || '';
  });
}

async function saveWorkflowWizard() {
  const status = document.getElementById('workflowWizardStatus');
  const name = (document.getElementById('workflowWizardName')?.value || '').trim();
  const description = (document.getElementById('workflowWizardDescription')?.value || '').trim();
  if (!name) { status.textContent = 'Name is required.'; return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { status.textContent = 'Name may only contain letters, numbers, dashes, underscores.'; return; }
  const stepNodes = Array.from(document.querySelectorAll('#workflowWizardSteps .workflow-wizard-step'));
  const steps = [];
  for (const node of stepNodes) {
    const id = node.querySelector('.wf-step-id').value.trim();
    const tool = node.querySelector('.wf-step-tool').value.trim();
    const inputRaw = node.querySelector('.wf-step-input').value.trim();
    const continueOnError = node.querySelector('.wf-step-continue').checked;
    if (!id || !tool) { status.textContent = 'Each step needs an id and tool.'; return; }
    let input = undefined;
    if (inputRaw) {
      try { input = JSON.parse(inputRaw); }
      catch(e){ status.textContent = 'Step "' + id + '" has invalid JSON input.'; return; }
    }
    steps.push({ id, tool, input, continueOnError });
  }
  if (steps.length === 0) { status.textContent = 'Add at least one step.'; return; }
  status.textContent = 'Saving…';
  try {
    let response = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, steps }),
    });
    if (response.status === 409) {
      if (!await confirmToast('Workflow "' + name + '" already exists. Overwrite?')) { status.textContent = 'Cancelled.'; return; }
      response = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, steps, overwrite: true }),
      });
    }
    const data = await response.json();
    if (data.error) { status.textContent = 'Failed: ' + data.error; return; }
    status.textContent = 'Created at ' + (data.filePath || '');
    closeWorkflowWizard();
    await loadWorkflows();
  } catch (error) {
    status.textContent = 'Failed: ' + (error.message || error);
  }
}

function createJobFromTemplate(name, prompt, schedule) {
  showNewAutomationJobForm();
  const nameInput = document.getElementById('newJobName');
  const promptInput = document.getElementById('newJobPrompt');
  const scheduleInput = document.getElementById('newJobSchedule');
  if (nameInput) nameInput.value = name;
  if (promptInput) promptInput.value = prompt;
  if (scheduleInput) scheduleInput.value = schedule;
}

function hideNewAutomationJobForm() {
  const form = document.getElementById('newAutomationJobForm');
  if (form) form.classList.add('hidden-by-default');
}

async function createAutomationJob() {
  const name = document.getElementById('newJobName')?.value?.trim();
  const prompt = document.getElementById('newJobPrompt')?.value?.trim();
  const schedule = document.getElementById('newJobSchedule')?.value?.trim();
  const scriptCommand = document.getElementById('newJobScript')?.value?.trim() || undefined;
  if (!name || !prompt || !schedule) { showToast('Name, prompt, and schedule are required.'); return; }
  try {
    const response = await fetch('/api/automations/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, prompt, schedule, scriptCommand }),
    });
    const data = await response.json();
    if (data.error) { showToast('Create failed: ' + data.error); return; }
    hideNewAutomationJobForm();
    loadRuns();
  } catch (error) { showToast('Create failed: ' + (error.message || error)); }
}

async function deleteAutomationJob(jobId) {
  if (!await confirmToast('Delete this automation job?')) return;
  try {
    const response = await fetch('/api/automations/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) { showToast('Delete failed: ' + data.error); return; }
    loadRuns();
  } catch (error) { showToast('Delete failed: ' + (error.message || error)); }
}

async function toggleAutomationJob(jobId, enabled) {
  try {
    const response = await fetch('/api/automations/jobs/' + encodeURIComponent(jobId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json();
    if (data.error) { showToast('Toggle failed: ' + data.error); return; }
    loadRuns();
  } catch (error) { showToast('Toggle failed: ' + (error.message || error)); }
}

async function editAutomationJob(jobId, name, prompt, schedule, scriptCommand) {
  const newName = await promptToast('Job name:', name);
  if (newName === null) return;
  const newPrompt = await promptToast('Prompt:', prompt);
  if (newPrompt === null) return;
  const newSchedule = await promptToast('Schedule (e.g. every 2h, 30m, 0 9 * * *):', schedule);
  if (newSchedule === null) return;
  const newScript = await promptToast('Script command (leave empty for none):', scriptCommand);
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
    if (data.error) { showToast('Edit failed: ' + data.error); return; }
    loadRuns();
  }).catch((error) => showToast('Edit failed: ' + (error.message || error)));
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
    +   '<button class="btn-sm" onclick="exportSession(\'' + escAttr(run.sessionId) + '\')">Export JSON</button> '
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

function exportSession(sessionId) {
  const a = document.createElement('a');
  a.href = '/api/sessions/' + encodeURIComponent(sessionId) + '/export';
  a.download = 'session-' + sessionId.slice(0, 8) + '.json';
  a.click();
}

async function importSessionFile(files) {
  if (!files || files.length === 0) return;
  try {
    const text = await files[0].text();
    const data = JSON.parse(text);
    const response = await fetch('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    showToast('Session imported: ' + result.sessionId.slice(0, 8) + ' (' + result.eventCount + ' events)', 3000, 'success');
    loadRuns();
  } catch (error) {
    showToast('Import failed: ' + (error.message || error), 3000, 'error');
  }
  document.getElementById('sessionImportFile').value = '';
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

