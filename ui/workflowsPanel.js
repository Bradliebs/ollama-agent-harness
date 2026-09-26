// Workflows panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

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
    const header = '<div class="panel-header panel-header-flat"><h3>Workflows</h3><div class="inline-actions"><button class="btn-sm" onclick="loadWorkflows()">Refresh</button> <button class="btn-sm" onclick="openWorkflowWizard()">+ New workflow</button> <button class="btn-sm" onclick="openAutomationWizardFromFlows()" title="Open the Runs tab and create a scheduled automation job">+ New automation</button></div></div>';
    const intro = '<div class="trace-meta panel-copy">Declarative tool sequences in <code>.harness/workflows/</code>. Use dry-run first; pause/resume/cancel any in-flight run. For <strong>scheduled automation jobs</strong> (cron-style), use the button above — they live on the <em>Runs</em> tab.</div>';
    let defsHtml;
    if (defs.length === 0) {
      defsHtml = '<div class="trace-meta panel-empty">No workflows yet. Use <strong>+ New workflow</strong> above to scaffold one.</div>';
    } else {
      defsHtml = '<div class="trace-list">' + defs.map(renderWorkflowDef).join('') + '</div>';
    }
    // Stash runs for the in-place filter handler.
    workflowRunsCache = runs;
    const runsHtml = runs.length === 0 ? '' : (
      '<div class="trace-title workflow-runs-title">Recent runs</div>'
      + '<div class="run-status-filter" id="runStatusFilter">'
      +   ['all', 'running', 'paused', 'completed', 'failed', 'cancelled'].map((s) => '<span class="run-status-chip' + (s === 'all' ? ' active' : '') + '" data-status="' + s + '" onclick="filterWorkflowRuns(\'' + s + '\')">' + s + '</span>').join('')
      + '</div>'
      + '<div id="workflowRunsList" class="trace-list">' + runs.slice(0, 20).map(renderWorkflowRun).join('') + '</div>'
    );
    view.innerHTML = header + intro + defsHtml + runsHtml;
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}

function renderWorkflowDef(def) {
  const riskClass = def.riskLevel === 'high' ? 'danger-pill' : def.riskLevel === 'medium' ? 'warning-pill' : 'success-pill';
  const riskBadge = '<span class="capability-pill ' + riskClass + '">' + esc(def.riskLevel || 'low') + '</span>';
  return '<div class="trace-item">'
    + '<div class="trace-title">' + esc(def.name) + ' ' + riskBadge + '</div>'
    + '<div class="trace-meta">' + esc(def.description || '(no description)') + '</div>'
    + '<div class="trace-meta">' + def.stepCount + ' step(s)</div>'
    + '<div class="inline-actions trace-block-spaced">'
    +   '<button class="btn-sm" onclick="runWorkflow(\'' + escAttr(def.name) + '\', true)">Dry-run</button> '
    +   '<button class="btn-sm primary" onclick="runWorkflow(\'' + escAttr(def.name) + '\', false)">Run</button> '
    +   '<button class="btn-sm" onclick="openWorkflowEditor(\'' + escAttr(def.name) + '\')">Edit YAML</button>'
    + '</div>'
    + '</div>';
}

// In-memory cache of the last loaded workflow runs so the status filter chips
// can re-render without refetching.
let workflowRunsCache = [];

function filterWorkflowRuns(status) {
  document.querySelectorAll('#runStatusFilter .run-status-chip').forEach((chip) => {
    if (chip.dataset.status === status) chip.classList.add('active'); else chip.classList.remove('active');
  });
  const list = document.getElementById('workflowRunsList');
  if (!list) return;
  const subset = status === 'all' ? workflowRunsCache : workflowRunsCache.filter((r) => r.status === status);
  list.innerHTML = subset.length === 0
    ? '<div class="trace-meta">No runs with status "' + esc(status) + '".</div>'
    : subset.slice(0, 20).map(renderWorkflowRun).join('');
}

// --- Workflow YAML editor ---
let activeWorkflowEditorName = '';

async function openWorkflowEditor(name) {
  activeWorkflowEditorName = name;
  const modal = document.getElementById('workflowEditor');
  const ta = document.getElementById('workflowEditorContent');
  const status = document.getElementById('workflowEditorStatus');
  const path = document.getElementById('workflowEditorPath');
  if (!modal || !ta) return;
  document.getElementById('workflowEditorTitle').textContent = 'Edit workflow · ' + name;
  ta.value = 'Loading…';
  status.textContent = '';
  path.textContent = '';
  modal.classList.remove('hidden-by-default');
  try {
    const data = await fetch('/api/workflows/' + encodeURIComponent(name) + '?raw=1').then((r) => r.json());
    if (data.error) { ta.value = ''; status.textContent = 'Failed: ' + data.error; return; }
    ta.value = data.content || '';
    path.textContent = data.filePath || '';
  } catch (error) { status.textContent = 'Failed: ' + (error.message || error); }
}

function closeWorkflowEditor() {
  const modal = document.getElementById('workflowEditor');
  if (modal) modal.classList.add('hidden-by-default');
  activeWorkflowEditorName = '';
}

async function saveWorkflowEditor() {
  const status = document.getElementById('workflowEditorStatus');
  if (!activeWorkflowEditorName) return;
  const ta = document.getElementById('workflowEditorContent');
  const content = ta?.value || '';
  if (!content.trim()) { status.textContent = 'Content is empty.'; return; }
  status.textContent = 'Saving…';
  try {
    const response = await fetch('/api/workflows/' + encodeURIComponent(activeWorkflowEditorName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await response.json();
    if (data.error) { status.textContent = 'Save failed: ' + data.error; return; }
    status.textContent = 'Saved.';
    closeWorkflowEditor();
    await loadWorkflows();
  } catch (error) { status.textContent = 'Save failed: ' + (error.message || error); }
}

function renderWorkflowRun(run) {
  const statusClass = run.status === 'completed' ? 'success-pill'
    : run.status === 'failed' ? 'danger-pill'
    : run.status === 'cancelled' ? 'warning-pill'
    : run.status === 'paused' ? 'running-pill'
    : run.status === 'running' ? 'running-pill'
    : 'muted-pill';
  const statusBadge = '<span class="capability-pill ' + statusClass + '">' + esc(run.status) + '</span>';
  const dryBadge = run.dryRun ? ' <span class="capability-pill">dry-run</span>' : '';
  const completedSteps = (run.steps || []).filter((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'denied' || s.status === 'skipped').length;
  const totalSteps = (run.steps || []).length;
  const stepLines = (run.steps || []).map((s, i) => {
    const stepClass = s.status === 'completed' ? 'trace-meta-success' : s.status === 'failed' || s.status === 'denied' ? 'trace-meta-error' : s.status === 'skipped' ? 'text-dim' : s.status === 'running' ? 'info-text' : 'muted-text';
    const detail = s.error ? ' — ' + esc(s.error) : (s.result?.output ? ' — ' + esc(String(s.result.output).slice(0, 80)) : '');
    const expandable = (s.error || s.result) ? '<button class="btn-sm btn-xxs" onclick="toggleWorkflowStepDetail(\'' + escAttr(run.id) + '\', ' + i + ', this)">Details</button>' : '';
    const detailContent = renderWorkflowStepDetail(s);
    return '<div class="trace-meta trace-meta-sm ' + stepClass + '">' + esc(s.step.id) + ' (' + esc(s.step.tool) + ') · ' + esc(s.status) + detail + ' ' + expandable
      + '<div id="wfStepDetail_' + escAttr(run.id) + '_' + i + '" class="hidden-by-default workflow-step-detail">' + detailContent + '</div>'
      + '</div>';
  }).join('');
  const controls = run.status === 'running'
    ? '<button class="btn-sm" onclick="pauseWorkflowRun(\'' + escAttr(run.id) + '\')">Pause</button> <button class="btn-sm danger" onclick="cancelWorkflowRun(\'' + escAttr(run.id) + '\')">Cancel</button>'
    : run.status === 'paused'
      ? '<button class="btn-sm" onclick="resumeWorkflowRun(\'' + escAttr(run.id) + '\')">Resume</button> <button class="btn-sm danger" onclick="cancelWorkflowRun(\'' + escAttr(run.id) + '\')">Cancel</button>'
      : '';
  return '<div class="trace-item">'
    + '<div class="trace-title">' + esc(run.workflowName) + ' ' + statusBadge + dryBadge + '</div>'
    + '<div class="trace-meta">' + esc(run.id) + ' · started ' + esc(new Date(run.startedAt).toLocaleString()) + ' · ' + completedSteps + '/' + totalSteps + ' steps</div>'
    + (stepLines ? '<div class="details-body-mt4">' + stepLines + '</div>' : '')
    + (controls ? '<div class="inline-actions trace-block-spaced">' + controls + '</div>' : '')
    + '</div>';
}

async function runWorkflow(name, dryRun) {
  try {
    const response = await fetch('/api/workflows/' + encodeURIComponent(name) + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    const data = await response.json();
    if (data.error) { showToast('Workflow failed to start: ' + data.error); return; }
    setTimeout(loadWorkflows, 300);
  } catch (error) { showToast('Workflow failed to start: ' + (error.message || error)); }
}

async function pauseWorkflowRun(id) {
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadWorkflows();
}

// Build the expandable detail block for a single workflow step. We try to show
// the rich tool result when present, fall back to error text, and otherwise
// note that the step had no recorded output.
function renderWorkflowStepDetail(step) {
  if (step.error) return '<pre class="workflow-step-pre">' + esc(String(step.error)) + '</pre>';
  if (step.result) {
    const output = step.result.output !== undefined ? step.result.output : step.result;
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return '<pre class="workflow-step-pre">' + esc(text.slice(0, 4000)) + '</pre>';
  }
  return '<div class="trace-meta">No recorded output.</div>';
}

function toggleWorkflowStepDetail(runId, index, btn) {
  const el = document.getElementById('wfStepDetail_' + runId + '_' + index);
  if (!el) return;
  if (el.classList.contains('hidden-by-default')) {
    el.classList.remove('hidden-by-default');
    if (btn) btn.textContent = 'Hide';
  } else {
    el.classList.add('hidden-by-default');
    if (btn) btn.textContent = 'Details';
  }
}

async function resumeWorkflowRun(id) {
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  setTimeout(loadWorkflows, 300);
}

async function cancelWorkflowRun(id) {
  if (!await confirmToast('Cancel this workflow run?')) return;
  await fetch('/api/workflows/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  loadWorkflows();
}

function renderMcpCatalogList() {
  const listEl = document.getElementById('mcpCatalogList');
  const filterEl = document.getElementById('mcpCatalogFilter');
  if (!listEl || !window._mcpCatalog) return;
  const configured = window._mcpRuntimeServerIds instanceof Set ? window._mcpRuntimeServerIds : new Set();
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
    const isConfigured = configured.has(entry.name);
    const actionButtons = isConfigured
      ? '<button class="btn-sm" disabled title="This MCP server is already configured">Added</button>'
        + '<button class="btn-sm" onclick="configureMcpFromCatalog(\'' + escAttr(entry.name) + '\', true)">Replace</button>'
      : '<button class="btn-sm primary" onclick="configureMcpFromCatalog(\'' + escAttr(entry.name) + '\')">Add</button>';
    return '<div class="mcp-catalog-row">'
      + '<div><strong>' + esc(entry.name) + '</strong> <span class="capability-pill">' + esc((entry.tags || []).join(' · ')) + '</span></div>'
      + '<div class="trace-meta">' + esc(entry.description) + '</div>'
      + '<div class="mcp-command-row">'
      + '<code>' + esc(entry.install) + '</code>'
      + actionButtons
      + '<button class="btn-sm" onclick="copyMcpInstall(' + JSON.stringify(entry.install).replace(/"/g, '&quot;') + ', this)">Copy</button>'
      + '<a class="btn-sm" target="_blank" rel="noopener" href="' + escAttr(entry.homepage) + '">Docs</a>'
      + '</div>'
      + envLine
      + '</div>';
  }).join('');
}

async function configureMcpFromCatalog(name, overwrite) {
  try {
    if (overwrite && !await confirmToast('Replace the saved MCP server "' + name + '" with the catalog definition?')) return;
    let response = await fetch('/api/mcp/runtime/from-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, overwrite: overwrite === true }) });
    if (response.status === 409) {
      if (!await confirmToast('MCP server "' + name + '" already exists. Replace it from the catalog?')) return;
      response = await fetch('/api/mcp/runtime/from-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, overwrite: true }) });
    }
    const data = await response.json();
    if (data.error) { showToast('Add failed: ' + data.error); return; }
    const envNote = (data.requiresEnv || []).length ? '\nSet env vars before starting: ' + data.requiresEnv.join(', ') : '';
    showToast((overwrite ? 'Replaced' : 'Added') + ' MCP server "' + name + '".' + envNote);
    await loadToolsDashboard();
  } catch (error) { showToast('Add failed: ' + (error.message || error)); }
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
    showToast('Copy failed: ' + e.message);
  }
}

