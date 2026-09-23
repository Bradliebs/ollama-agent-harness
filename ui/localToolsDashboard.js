// Local tools dashboard.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Local Tools dashboard ─────────────────────────────────────────
// Single-page status of snapshots, RAG indexes, sessions, models, traces,
// plus the curated MCP catalog. Each section is fetched lazily and shown
// with its primary one-click action so the user can jump from "what do I
// have" to "do the thing" without leaving this view.

let _timedToolRefreshTimer = null;

async function loadToolsDashboard() {
  // Clear any pending auto-refresh from a previous render
  if (_timedToolRefreshTimer) { clearTimeout(_timedToolRefreshTimer); _timedToolRefreshTimer = null; }

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
    const header = '<div class="panel-header panel-header-flat"><h3>Local Tools</h3><div class="inline-actions"><button class="btn-sm" onclick="loadToolsDashboard()">Refresh</button></div></div>';
    // One-line summary so users see "what do I have" before scrolling through
    // the per-capability list. Counts come straight from the data we already
    // fetched.
    const toolsArr = registry.tools || [];
    const enabledCount = toolsArr.filter((t) => t.enabled !== false).length;
    const grantCount = (capabilities.grants || []).length;
    const blockedCount = (capabilities.items || []).filter((c) => c.alignment === 'blocked').length;
    const summaryLine = '<div class="tools-summary-line">'
      + '<strong>' + enabledCount + '</strong> tools enabled · '
      + '<strong>' + grantCount + '</strong> active grant(s)'
      + (blockedCount > 0 ? ' · <span class="text-warning-xs">' + blockedCount + ' blocked</span>' : '')
      + '</div>';
    const auditR = await fetch('/api/capabilities/audit').then((r) => r.json()).catch(() => ({ events: [] }));
    const auditEvents = Array.isArray(auditR.events) ? auditR.events : [];
    view.innerHTML = header + summaryLine + renderPermissionPanel(perm) + renderCapabilityAlignmentPanel(capabilities, auditEvents) + renderToolRegistryPanel(registry) + '<div class="trace-list" id="toolsDashboardCards"><div class="trace-item"><div class="trace-title">Dashboard details</div><div class="trace-meta">Loading local status…</div></div></div>';

    // Schedule auto-refresh when timed tool enables are active
    scheduleTimedToolRefresh(registry);

    const [snapsR, indexesR, sessionsR, modelsR, storageR, mcpR, mcpRuntimeR] = await Promise.allSettled([
      fetch('/api/snapshots').then((r) => r.json()),
      fetch('/api/rag/indexes').then((r) => r.json()),
      fetch('/api/sessions').then((r) => r.json()),
      fetch('/api/models').then((r) => r.json()),
      fetch('/api/runtime/storage').then((r) => r.json()),
      fetch('/api/mcp/catalog').then((r) => r.json()),
      fetch('/api/mcp/runtime').then((r) => r.json()),
    ]);
    const snapsCount = snapsR.status === 'fulfilled' ? (snapsR.value.snapshots || []).length : 0;
    const indexesArr = indexesR.status === 'fulfilled' ? (indexesR.value.indexes || []) : [];
    const sessionsArr = sessionsR.status === 'fulfilled' ? (sessionsR.value.sessions || sessionsR.value || []) : [];
    const modelsArr = modelsR.status === 'fulfilled' ? (modelsR.value.models || []) : [];
    const storage = storageR.status === 'fulfilled' ? storageR.value : null;
    const mcpArr = mcpR.status === 'fulfilled' ? (mcpR.value.catalog || []) : [];
    const mcpServers = mcpRuntimeR.status === 'fulfilled' ? (mcpRuntimeR.value.servers || []) : [];

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

    // Add health status card (async, fills in after render)
    const healthCard = { emoji: '🩺', title: 'System health', value: 'Checking...', sub: '', action: { label: 'Check', fn: 'refreshHealthCard()' } };
    cards.push(healthCard);
    refreshHealthCardAsync();

    const cardHtml = cards.map((c) => '<div class="trace-item">'
      + '<div class="trace-title">' + c.emoji + ' ' + esc(c.title) + '</div>'
      + '<div class="trace-meta trace-value-line">' + esc(c.value) + '</div>'
      + '<div class="trace-meta">' + esc(c.sub) + '</div>'
      + (c.action ? '<div class="inline-actions trace-block-spaced"><button class="btn-sm" onclick="' + c.action.fn + '">' + esc(c.action.label) + '</button></div>' : '')
      + '</div>').join('');

    const cardsHost = document.getElementById('toolsDashboardCards');
    if (cardsHost) cardsHost.innerHTML = cardHtml + renderMcpHub(mcpServers, mcpArr);
    window._mcpCatalog = mcpArr;
    window._mcpRuntimeServerIds = new Set(mcpServers.flatMap((server) => [server.id, server.catalogName].filter(Boolean)));
    renderMcpCatalogList();
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message) + '</div>';
  }
}

function renderMcpHub(servers, catalog) {
  const serverCount = Array.isArray(servers) ? servers.length : 0;
  const catalogCount = Array.isArray(catalog) ? catalog.length : 0;
  const openCatalog = serverCount === 0 ? ' open' : '';
  return '<div class="trace-item mcp-hub">'
    + '<div class="mcp-hub-head">'
    + '<div><div class="mcp-hub-title">🧩 MCP servers</div>'
    + '<div class="mcp-hub-sub">MCP servers are add-on processes that expose extra tools. Built-in Harness tools live in the Tool registry above; MCP servers can come from the catalog, from a command you paste, or from agent-created code.</div></div>'
    + '<span class="rag-backend-badge">' + serverCount + ' configured</span>'
    + '</div>'
    + '<div class="mcp-path-grid">'
    + '<div class="mcp-path"><strong>Let the agent handle it</strong><span>Draft a request to find an existing server or create one for this project.</span><div class="inline-actions"><button class="btn-sm" onclick="draftMcpAgentRequest(\'find\')">Find one</button><button class="btn-sm" onclick="draftMcpAgentRequest(\'create\')">Create one</button></div></div>'
    + '<div class="mcp-path"><strong>Use one already made</strong><span>Pick from ' + catalogCount + ' curated entries, then start it when a shell grant is active.</span><button class="btn-sm" onclick="focusMcpCatalogFilter()">Browse catalog</button></div>'
    + '<div class="mcp-path"><strong>Paste a command</strong><span>Save a known install command such as npx plus its arguments.</span><button class="btn-sm" onclick="toggleMcpManualForm()">Manual setup</button></div>'
    + '</div>'
    + '<details class="mcp-section" open><summary>Configured servers</summary>'
    + renderMcpRuntimeList(servers)
    + '</details>'
    + renderMcpQuickAddPanel()
    + (catalogCount === 0 ? '' : '<details class="mcp-section"' + openCatalog + '><summary>Ready-made catalog</summary>'
      + '<input id="mcpCatalogFilter" type="text" placeholder="filter by name or tag..." class="compact-panel-input full-compact-input" oninput="renderMcpCatalogList()">'
      + '<div id="mcpCatalogList"></div>'
      + '</details>')
    + '</div>';
}

function renderMcpRuntimeList(servers) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return '<div class="trace-meta trace-block-spaced">No MCP servers configured yet. Add one from the catalog, paste a command, or ask the agent to create one for a specific job.</div>';
  }
  return servers.map((server) => {
    const status = server.running ? 'running' : 'stopped';
    const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
    const tools = toolCount ? server.tools.map((tool) => tool.name).join(', ') : 'No tools discovered';
    return '<div class="trace-item trace-item-subtle trace-block-spaced">'
      + '<div class="trace-title">' + esc(server.id || '(unnamed)') + ' <span class="rag-backend-badge">' + esc(status) + '</span></div>'
      + '<div class="trace-meta">' + esc((server.command || '') + (Array.isArray(server.args) && server.args.length ? ' ' + server.args.join(' ') : '')) + '</div>'
      + '<div class="trace-meta">Tools (' + toolCount + '): ' + esc(tools) + '</div>'
      + (server.lastError ? '<div class="trace-meta trace-meta-warning">' + esc(server.lastError) + '</div>' : '')
      + '<div class="inline-actions trace-block-spaced">'
      + '<button class="btn-sm" onclick="mcpRuntimeStart(\'' + escAttr(server.id) + '\')"' + (server.running ? ' disabled' : '') + '>Start</button>'
      + '<button class="btn-sm" onclick="mcpRuntimeStop(\'' + escAttr(server.id) + '\')"' + (!server.running ? ' disabled' : '') + '>Stop</button>'
      + '<button class="btn-sm" onclick="mcpRuntimeDiscoverTools(\'' + escAttr(server.id) + '\')"' + (!server.running ? ' disabled' : '') + '>Discover tools</button>'
      + '<button class="btn-sm danger" onclick="mcpRuntimeDelete(\'' + escAttr(server.id) + '\')">Remove</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function renderMcpQuickAddPanel() {
  return '<details class="mcp-section" id="mcpManualForm"><summary>Manual command</summary>'
    + '<input id="mcpNewId" class="compact-panel-input full-compact-input" placeholder="server id, e.g. playwright">'
    + '<input id="mcpNewCommand" class="compact-panel-input full-compact-input" placeholder="command, e.g. npx">'
    + '<input id="mcpNewArgs" class="compact-panel-input full-compact-input" placeholder="args, e.g. -y @modelcontextprotocol/server-puppeteer">'
    + '<textarea id="mcpNewEnv" class="compact-panel-input full-compact-input" rows="3" placeholder="env, one KEY=value per line"></textarea>'
    + '<input id="mcpNewTools" class="compact-panel-input full-compact-input" placeholder="tool names, comma separated (optional)">'
    + '<div class="inline-actions top-spaced"><button class="btn-sm primary" onclick="createMcpRuntimeFromForm()">Save MCP server</button></div>'
    + '<div id="mcpRuntimeFormStatus" class="trace-meta"></div>'
    + '</details>';
}

function draftMcpAgentRequest(kind) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = kind === 'create'
    ? 'Create an MCP server for this project that provides the tools needed to: '
    : 'Find an existing MCP server I can use for: ';
  input.focus();
}

function focusMcpCatalogFilter() {
  const section = document.getElementById('mcpCatalogList')?.closest('details');
  if (section) section.open = true;
  const filter = document.getElementById('mcpCatalogFilter');
  if (filter) filter.focus();
}

function toggleMcpManualForm() {
  const form = document.getElementById('mcpManualForm');
  if (form) form.open = true;
  const input = document.getElementById('mcpNewId');
  if (input) input.focus();
}

async function mcpRuntimeStart(id) {
  try {
    const r = await fetch('/api/mcp/runtime/servers/' + encodeURIComponent(id) + '/start', { method: 'POST' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    const pid = d.server && d.server.pid ? ' (pid ' + d.server.pid + ')' : '';
    showToast('Started MCP server "' + id + '"' + pid + '. Run Discover tools to expose its tools in the registry.', 5000, 'success');
    await loadToolsDashboard();
  } catch (e) { showToast(e.message); }
}

async function mcpRuntimeDiscoverTools(id) {
  try {
    const r = await fetch('/api/mcp/runtime/servers/' + encodeURIComponent(id) + '/discover-tools', { method: 'POST' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    const count = Array.isArray(d.server?.tools) ? d.server.tools.length : 0;
    showToast('Discovered ' + count + ' MCP tool(s) for "' + id + '".', 5000, 'success');
    await loadToolsDashboard();
  } catch (e) { showToast(e.message); }
}

async function mcpRuntimeStop(id) {
  try {
    const r = await fetch('/api/mcp/runtime/servers/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    await loadToolsDashboard();
  } catch (e) { showToast(e.message); }
}

async function mcpRuntimeDelete(id) {
  if (!await confirmToast('Remove MCP runtime server "' + id + '"?')) return;
  try {
    const r = await fetch('/api/mcp/runtime/servers/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    await loadToolsDashboard();
  } catch (e) { showToast(e.message); }
}

async function createMcpRuntimeFromForm() {
  const status = document.getElementById('mcpRuntimeFormStatus');
  const id = document.getElementById('mcpNewId')?.value.trim() || '';
  const command = document.getElementById('mcpNewCommand')?.value.trim() || '';
  const argsText = document.getElementById('mcpNewArgs')?.value.trim() || '';
  const envText = document.getElementById('mcpNewEnv')?.value || '';
  const toolsText = document.getElementById('mcpNewTools')?.value || '';
  if (!id || !command) { if (status) status.textContent = 'Enter both id and command.'; return; }
  const env = {};
  envText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  const payload = {
    id,
    command,
    args: splitArgsInput(argsText),
    env,
    tools: toolsText.split(',').map((name) => name.trim()).filter(Boolean).map((name) => ({ name })),
    enabled: true,
  };
  try {
    const response = await fetch('/api/mcp/runtime/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (data.error) { if (status) status.textContent = 'Save failed: ' + data.error; return; }
    if (status) status.textContent = 'Saved MCP server ' + data.server.id + '.';
    await loadToolsDashboard();
  } catch (error) { if (status) status.textContent = 'Save failed: ' + (error.message || error); }
}

function splitArgsInput(value) {
  const args = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function scheduleTimedToolRefresh(registry) {
  if (_timedToolRefreshTimer) { clearTimeout(_timedToolRefreshTimer); _timedToolRefreshTimer = null; }
  const tools = (registry && registry.tools) || [];
  const now = Date.now();
  let hasTimed = false;
  let earliest = Infinity;
  for (const t of tools) {
    if (t.enabledUntil) {
      hasTimed = true;
      const exp = new Date(t.enabledUntil).getTime();
      if (exp > now && exp < earliest) earliest = exp;
    }
  }
  if (hasTimed) {
    // Refresh at the earlier of: 60s (countdown update) or expiry + 1s
    const expiryDelay = earliest < Infinity ? earliest - now + 1000 : Infinity;
    const delay = Math.max(1000, Math.min(60_000, expiryDelay));
    _timedToolRefreshTimer = setTimeout(() => {
      // Only refresh if the tools tab is still visible
      const td = document.getElementById('toolsDashboardView');
      if (td && td.style.display !== 'none') loadToolsDashboard();
    }, delay);
  }
}

function renderPermissionPanel(perm) {
  if (!perm) return '';
  const ks = perm.killSwitch || { active: false, reason: '' };
  const badge = ks.active
    ? '<span class="rag-backend-badge danger-badge">🛑 KILL SWITCH ACTIVE</span>'
    : '<span class="rag-backend-badge success-badge">✅ Tools allowed</span>';
  const reasonRow = ks.active && ks.reason ? '<div class="trace-meta">Reason: ' + esc(ks.reason) + '</div>' : '';
  const button = ks.active
    ? '<button class="btn-sm" onclick="releaseKillSwitch()">Release kill switch</button>'
    : '<button class="btn-sm danger" onclick="engageKillSwitch()">🛑 Engage kill switch</button>';
  return '<div class="trace-item trace-block-spaced-large" id="permissionPanel">'
    + '<div class="trace-title">🔐 Permissions</div>'
    + '<div class="permission-status-row">' + badge + ' <span class="trace-meta">Mode: <strong>' + esc(perm.mode || 'default') + '</strong></span> <span class="trace-meta">Pending: ' + (perm.pendingCount || 0) + '</span></div>'
    + reasonRow
    + '<div class="trace-meta top-spaced">Engaging the kill switch denies every subsequent tool call (including reads) until released. The agent loop keeps running but cannot touch the system.</div>'
    + '<div class="inline-actions trace-block-spaced">' + button + '</div>'
    + '</div>';
}

function renderCapabilityAlignmentPanel(capabilities, auditEvents) {
  const items = (capabilities && capabilities.items) || [];
  if (items.length === 0) return '';
  const summary = capabilities.summary || {};
  const grants = Array.isArray(capabilities.grants) ? capabilities.grants : [];
  const grantCount = grants.length;
  const presets = Array.isArray(capabilities.shellCommandPresets) ? capabilities.shellCommandPresets : [];
  const events = Array.isArray(auditEvents) ? auditEvents : [];
  const auditPageSize = 20;
  const visibleEvents = events.slice(0, auditPageSize);
  window._lastAuditEvents = events;
  const summaryText = ['gated', 'design-only', 'blocked', 'available']
    .map((key) => key + ': ' + (summary[key] || 0))
    .join(' · ');
  const postureMeta = {
    available: { className: 'success-pill', label: 'available' },
    gated: { className: 'warning-pill', label: 'gated' },
    'design-only': { className: 'info-pill', label: 'design-only' },
    blocked: { className: 'danger-pill', label: 'blocked' },
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
      + '<span class="capability-pill ' + meta.className + '">' + esc(meta.label) + '</span>'
      + '<span class="capability-pill">' + esc(cap.category || 'policy') + '</span>'
      + '<div class="trace-meta">' + esc(cap.summary || '') + '</div>'
      + '<div class="trace-meta">Coverage: ' + esc(coverage) + '</div>'
      + '<div class="trace-meta">Controls: ' + esc(controls) + '</div>'
        + (grantButton ? '<div class="inline-actions trace-block-spaced">' + grantButton + '</div>' : '')
      + '</div>';
  }).join('');
      const grantRows = grants.length ? grants.map((grant) => {
        const expiry = new Date(grant.expiresAt).getTime() - Date.now();
        const isLongLived = expiry > 30 * 24 * 60 * 60 * 1000;
        const longLivedPill = isLongLived ? '<span class="capability-pill warning-pill" title="Lifted from the 24h cap because this grant carries a commandAllowlist (regex is the bound).">🛡 long-lived</span>' : '';
        const patterns = Array.isArray(grant.commandAllowlist) && grant.commandAllowlist.length > 0
          ? '<details class="details-mt8"><summary class="trace-meta clickable-summary">Command allowlist (' + grant.commandAllowlist.length + ' pattern' + (grant.commandAllowlist.length > 1 ? 's' : '') + ')</summary>'
            + grant.commandAllowlist.map((pattern) => '<div class="trace-meta trace-meta-sm"><code>' + esc(pattern) + '</code></div>').join('')
            + '</details>'
          : '';
        return '<div class="trace-row">'
          + '<strong>' + esc(grant.capabilityId) + '</strong> '
          + '<span class="capability-pill">expires ' + esc(new Date(grant.expiresAt).toLocaleString()) + '</span>'
          + longLivedPill
          + '<div class="trace-meta">' + esc(grant.reason || '') + '</div>'
          + patterns
          + '<div class="inline-actions trace-block-spaced"><button class="btn-sm danger" onclick="revokeCapabilityGrant(\'' + escAttr(grant.id) + '\')">Revoke</button></div>'
          + '</div>';
      }).join('') : '<div class="trace-meta">No active grants.</div>';
      const presetRows = presets.length ? '<details class="details-mt8"><summary class="trace-meta clickable-summary">Shell command allowlist presets (' + presets.length + ')</summary>' + presets.map((preset) => '<div class="trace-meta trace-meta-sm"><strong>' + esc(preset.label || preset.id) + '</strong>: ' + esc((preset.examples || []).join(', ')) + '</div>').join('') + '</details>' : '';
  const hasMore = events.length > auditPageSize;
  const grantEventCount = events.filter((ev) => AUDIT_FILTER_MAP.grant.includes(ev.type)).length;
  const autonomyEventCount = events.filter((ev) => AUDIT_FILTER_MAP.autonomy.includes(ev.type)).length;
  const automationEventCount = events.filter((ev) => AUDIT_FILTER_MAP.automation.includes(ev.type)).length;
  const filterOptions = '<div class="audit-filter-row"><select id="auditFilterSelect" class="audit-filter-select" onchange="filterAuditEvents()"><option value="">All (' + events.length + ')</option><option value="grant">Grants (' + grantEventCount + ')</option><option value="autonomy">Autonomy (' + autonomyEventCount + ')</option><option value="automation">Automation (' + automationEventCount + ')</option></select>'
    + '<input id="auditSearchInput" type="text" placeholder="Search events…" oninput="filterAuditEvents()" class="audit-search-input"></div>'
    + '<div class="audit-filter-row"><span class="trace-meta audit-date-label">Date range:</span><input id="auditDateFrom" type="date" onchange="filterAuditEvents()" class="audit-date-input"><input id="auditDateTo" type="date" onchange="filterAuditEvents()" class="audit-date-input"></div>';
  const auditSection = events.length ? '<details class="details-mt8"><summary class="trace-meta clickable-summary">Audit log (' + events.length + ' events)</summary>'
    + filterOptions
    + '<div id="auditLogRows">' + visibleEvents.map(renderAuditRowHtml).join('') + '</div>'
    + (hasMore ? '<button class="btn-sm btn-show-more" id="auditShowMoreBtn" onclick="showAllAuditEvents()">Show all ' + events.length + ' events</button>' : '')
    + '</details>' : '';
  return '<div class="trace-list trace-block-spaced-large" id="capabilityAlignmentPanel">'
    + '<div class="trace-title trace-title-padded">Capability alignment · ' + esc(summaryText) + ' · active grants: ' + grantCount + '</div>'
    + '<div class="trace-item">'
    +   '<details' + (grantCount > 5 ? '' : ' open') + '>'
    +     '<summary class="trace-title clickable-summary">Active grants (' + grantCount + ')</summary>'
    +     '<div class="details-body-mt4">' + grantRows + '</div>'
    +   '</details>'
    +   presetRows + auditSection
    + '</div>'
    + '<div class="trace-item">' + rows + '</div>'
    + '</div>';
}

window._lastAuditEvents = [];
function showAllAuditEvents() {
  const container = document.getElementById('auditLogRows');
  const btn = document.getElementById('auditShowMoreBtn');
  if (!container || !window._lastAuditEvents) return;
  container.innerHTML = window._lastAuditEvents.map(renderAuditRowHtml).join('');
  if (btn) btn.remove();
}

function filterAuditEvents() {
  const select = document.getElementById('auditFilterSelect');
  const searchInput = document.getElementById('auditSearchInput');
  const dateFrom = document.getElementById('auditDateFrom');
  const dateTo = document.getElementById('auditDateTo');
  const container = document.getElementById('auditLogRows');
  const btn = document.getElementById('auditShowMoreBtn');
  if (!container || !window._lastAuditEvents) return;
  const filter = select ? select.value : '';
  const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const fromTs = dateFrom && dateFrom.value ? new Date(dateFrom.value).getTime() : 0;
  const toTs = dateTo && dateTo.value ? new Date(dateTo.value + 'T23:59:59').getTime() : Infinity;
  const allowed = AUDIT_FILTER_MAP[filter] || null;
  let filtered = allowed ? window._lastAuditEvents.filter((ev) => allowed.includes(ev.type)) : window._lastAuditEvents;
  if (searchTerm) {
    filtered = filtered.filter((ev) => {
      const text = [ev.type, ev.capabilityId, ev.command, ev.reason, ev.presetId, ev.grantId, ev.jobId].filter(Boolean).join(' ').toLowerCase();
      return text.includes(searchTerm);
    });
  }
  if (fromTs > 0 || toTs < Infinity) {
    filtered = filtered.filter((ev) => {
      if (!ev.createdAt) return false;
      const ts = new Date(ev.createdAt).getTime();
      return ts >= fromTs && ts <= toTs;
    });
  }
  container.innerHTML = filtered.map(renderAuditRowHtml).join('') || '<div class="trace-meta">No events match this filter.</div>';
  if (btn) btn.remove();
}

async function grantCapability(capabilityId) {
  const reason = await promptToast('Reason for this capability grant?', 'Manual grant from Tools dashboard.');
  if (reason === null) return;
  // For shell-style capabilities, offer to attach a per-grant
  // commandAllowlist of regex sources. When ANY pattern is supplied the
  // server lifts the 24h ceiling to up to 1 year (the regex is itself
  // the security bound), so prompt for a longer expiry too. Behaviour
  // for other capabilities is unchanged.
  const isShellCapability = capabilityId === 'arbitrary-shell' || capabilityId === 'background-autonomous-jobs';
  let commandAllowlist = [];
  let maxExpiry = 1440;
  if (isShellCapability) {
    const patternsRaw = await promptToast(
      'OPTIONAL: command allowlist (one regex per line). '
      + 'Leave blank for the default 24h preset-only grant. '
      + 'Each pattern is anchored at run time and matched against the trimmed command. '
      + 'Example: ^cmd /c "cd /d C:\\\\AI\\\\Project && python script\\.py.*"$',
      ''
    );
    if (patternsRaw === null) return;
    commandAllowlist = patternsRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (commandAllowlist.length > 0) maxExpiry = 525_600; // 1 year
  }
  const expiresRaw = await promptToast('Expire after how many minutes? (1-' + maxExpiry + ')', commandAllowlist.length > 0 ? '525600' : '60');
  if (expiresRaw === null) return;
  const capabilities = await fetch('/api/capabilities').then((r) => r.json());
  const item = (capabilities.capabilities || []).find((cap) => cap.id === capabilityId);
  if (!item || item.posture !== 'gated') { showToast('Only gated capabilities can be granted.'); return; }
  const body = {
    capabilityId,
    controls: item.requiredControls || [],
    reason,
    expiresInMinutes: Number(expiresRaw) || 60,
  };
  if (commandAllowlist.length > 0) body.commandAllowlist = commandAllowlist;
  const response = await fetch('/api/capabilities/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) { showToast('Grant failed: ' + data.error); return; }
  await loadToolsDashboard();
}

async function revokeCapabilityGrant(grantId) {
  if (!await confirmToast('Revoke this capability grant?')) return;
  const response = await fetch('/api/capabilities/grants/' + encodeURIComponent(grantId), { method: 'DELETE' });
  const data = await response.json();
  if (data.error) { showToast('Revoke failed: ' + data.error); return; }
  await loadToolsDashboard();
}

function formatCountdown(isoExpiry) {
  const ms = new Date(isoExpiry).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return totalMin + 'm remaining';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h + 'h ' + (m > 0 ? m + 'm ' : '') + 'remaining';
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
      const riskClass = t.riskLevel === 'high' ? 'danger-pill' : t.riskLevel === 'medium' ? 'warning-pill' : 'success-pill';
      const riskBadge = '<span class="capability-pill ' + riskClass + '">' + esc(t.riskLevel || 'low') + '</span>';
      const catBadge = '<span class="capability-pill">' + esc(t.permissionCategory || 'read') + '</span>';
      const ro = t.isReadOnly ? '<span class="capability-pill">read-only</span>' : '';
      const dryRun = t.canDryRun ? '<span class="capability-pill">dry-run</span>' : '';
      const enabled = t.enabled !== false;
      const timedBadge = t.enabledUntil ? ' <span class="capability-pill warning-pill">' + esc(formatCountdown(t.enabledUntil)) + '</span>' : '';
      let buttons;
      if (enabled && !t.enabledUntil) {
        // Permanently enabled — offer Disable
        buttons = '<button class="btn-sm" onclick="toggleTool(\'' + escAttr(t.name) + '\', false)">Disable</button>';
      } else if (enabled && t.enabledUntil) {
        // Time-limited enabled — offer Disable (which cancels the timer)
        buttons = '<button class="btn-sm" onclick="toggleTool(\'' + escAttr(t.name) + '\', false)">Disable</button>';
      } else {
        // Disabled — offer Enable or Enable (timed)
        buttons = '<button class="btn-sm" onclick="toggleTool(\'' + escAttr(t.name) + '\', true)">Enable</button>'
          + ' <button class="btn-sm" onclick="toggleToolTimed(\'' + escAttr(t.name) + '\')">Enable (timed)</button>';
      }
      const rowClass = enabled ? 'trace-row' : 'trace-row row-dimmed';
      const stateBadge = enabled ? '' : ' <span class="capability-pill danger-pill">disabled</span>';
      return '<div class="' + rowClass + '"><strong>' + esc(t.name) + '</strong> ' + riskBadge + ' ' + catBadge + ' ' + ro + ' ' + dryRun + stateBadge + timedBadge + ' ' + buttons + '<div class="trace-meta">' + esc(t.description) + '</div></div>';
    }).join('');
    const toolsetNames = items.map((t) => escAttr(t.name));
    const disabledNames = items.filter((t) => t.enabled === false).map((t) => escAttr(t.name));
    const enabledNames = items.filter((t) => t.enabled !== false).map((t) => escAttr(t.name));
    const showBulk = disabledNames.length > 0 || enabledNames.length > 0 && enabledNames.length < items.length;
    const bulkBtns = (disabledNames.length > 0 || enabledNames.length > 0) ? '<div class="inline-actions compact-action-row">'
      + (disabledNames.length > 0 ? '<button class="btn-sm" onclick="bulkToggleToolset(' + JSON.stringify(disabledNames) + ', true)">Enable all</button> ' : '')
      + (disabledNames.length > 0 ? '<button class="btn-sm" onclick="bulkToggleToolsetTimed(' + JSON.stringify(disabledNames) + ')">Enable all (timed)</button> ' : '')
      + (enabledNames.length > 0 ? '<button class="btn-sm" onclick="bulkToggleToolset(' + JSON.stringify(enabledNames) + ', false)">Disable all</button>' : '')
      + '</div>' : '';
    return '<div class="trace-item"><div class="trace-title">' + esc(toolset) + ' (' + items.length + ')</div>' + bulkBtns + rows + '</div>';
  }).join('');
  const disabledCount = (registry.disabled || []).length;
  const timedCount = tools.filter((t) => t.enabledUntil).length;
  const disabledNote = disabledCount > 0 ? ' · <span class="trace-meta-error">' + disabledCount + ' disabled</span>' : '';
  const timedNote = timedCount > 0 ? ' · <span class="trace-meta-warning">' + timedCount + ' timed</span>' : '';
  return '<div class="trace-list trace-block-spaced-large" id="toolRegistryPanel"><div class="trace-title trace-title-padded">🛠 Tool registry · ' + tools.length + ' total' + disabledNote + timedNote + '</div>' + sections + '</div>';
}

async function toggleTool(name, enable, expiresInMinutes) {
  try {
    const body = { enabled: enable };
    if (expiresInMinutes) body.expiresInMinutes = expiresInMinutes;
    const response = await fetch('/api/tools/' + encodeURIComponent(name) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error) { showToast('Toggle failed: ' + data.error, 4000, 'error'); return; }
    await loadToolsDashboard();
  } catch (error) { showToast('Toggle failed: ' + (error.message || error), 4000, 'error'); }
}

async function toggleToolTimed(name) {
  const minutesRaw = await promptToast('Enable ' + name + ' for how many minutes? (1-1440)', '60');
  if (minutesRaw === null) return;
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) { showToast('Enter a number between 1 and 1440.'); return; }
  await toggleTool(name, true, minutes);
}

async function bulkToggleToolset(names, enable, expiresInMinutes) {
  const body = { names: names, enabled: enable };
  if (expiresInMinutes) body.expiresInMinutes = expiresInMinutes;
  await fetch('/api/tools/bulk-toggle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
  await loadToolsDashboard();
}

async function bulkToggleToolsetTimed(names) {
  const minutesRaw = await promptToast('Enable all tools in this group for how many minutes? (1-1440)', '60');
  if (minutesRaw === null) return;
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) { showToast('Enter a number between 1 and 1440.'); return; }
  await bulkToggleToolset(names, true, minutes);
}

async function engageKillSwitch() {
  const reason = await promptToast('Why are you engaging the kill switch?', 'Manual stop from dashboard.');
  if (reason === null) return;
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason }) });
  await loadToolsDashboard();
}

async function releaseKillSwitch() {
  if (!await confirmToast('Release the kill switch and resume normal tool calls?')) return;
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  await loadToolsDashboard();
}

