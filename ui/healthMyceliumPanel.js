// Health check card and Mycelium routing panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Health check ───────────────────────────────────────────────────

async function refreshHealthCardAsync() {
  try {
    const r = await fetch('/api/setup/health').then((r) => r.json());
    const items = [];
    if (r.ollama) items.push(r.ollama.ok ? 'Ollama: connected' : 'Ollama: ' + (r.ollama.error || 'unreachable'));
    if (r.vision) items.push(r.vision.ok ? 'Vision: ready' : 'Vision: not configured');
    if (r.audio) items.push(r.audio.ok ? 'Audio: ready' : 'Audio: not configured');
    const allOk = items.every((i) => !i.includes('unreachable') && !i.includes('error'));
    const card = document.querySelector('.trace-item:last-child');
    if (card && card.textContent.includes('System health')) {
      const valueEl = card.querySelector('.trace-meta');
      const subEl = card.querySelectorAll('.trace-meta')[1];
      if (valueEl) valueEl.innerHTML = '<span style="color:' + (allOk ? '#50c878' : '#ffb050') + '">' + (allOk ? 'All systems OK' : 'Some issues detected') + '</span>';
      if (subEl) subEl.textContent = items.join(' · ');
    }
  } catch(e){ /* health check is optional */ }
}

function refreshHealthCard() { refreshHealthCardAsync(); }


// ─── Mycelium tab ───────────────────────────────────────────────────

async function resetMyceliumGraph() {
  if (!await confirmToast('Reset the mycelium graph? All learned routes will be lost.')) return;
  try {
    const response = await fetch('/api/mycelium', { method: 'DELETE' });
    const data = await response.json();
    if (data.error) { showToast('Reset failed: ' + data.error); return; }
    loadMycelium();
  } catch (error) { showToast('Reset failed: ' + (error.message || error)); }
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
      + 'Nodes: ' + (stats.nodes || 0) + ' (' + (stats.protectedNodes || 0) + ' protected)'
      + ' · Edges: ' + (stats.edges || 0) + ' (' + (stats.protectedEdges || 0) + ' protected, ' + (stats.archivedEdges || 0) + ' archived)'
      + ' · Episodes: ' + (stats.episodes || 0) + ' · Avg weight: ' + (stats.avgWeight || 0)
      + '</div>';

    // Group nodes by type
    const nodesByType = {};
    for (const node of nodes) {
      if (!nodesByType[node.type]) nodesByType[node.type] = [];
      nodesByType[node.type].push(node);
    }

    const typeColors = { query: '#5bb0ff', memory: '#b080ff', tool: '#50c878', skill: '#ffb050', agent: '#ff5050', strategy: '#8ab4f8', document: '#888', output: '#50c878', safety: '#ff8c00', verifier: '#9c27b0', prompt_template: '#00bcd4', workflow: '#3f51b5', constraint: '#795548', preference: '#607d8b' };

    const nodesSections = Object.entries(nodesByType).sort(([a], [b]) => a.localeCompare(b)).map(([type, typeNodes]) => {
      const color = typeColors[type] || '#888';
      const rows = typeNodes.map((node) => {
        const trustBar = '<span style="display:inline-block;width:40px;height:6px;background:var(--border);border-radius:3px;margin-left:6px;vertical-align:middle"><span style="display:block;width:' + Math.round(node.trust * 100) + '%;height:100%;background:' + color + ';border-radius:3px"></span></span>';
        const protectedBadge = node.protected ? ' <span style="color:#ff8c00" title="protected from pruning">🛡</span>' : '';
        return '<div class="trace-meta" style="font-size:11px">'
          + '<span style="color:' + color + '">●</span> '
          + '<strong>' + esc(node.label) + '</strong>' + protectedBadge
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
      const protectedBadge = edge.protected ? ' <span style="color:#ff8c00" title="protected">🛡</span>' : '';
      const blockedBadge = edge.blockedCount && edge.blockedCount > 0
        ? ' <span style="color:#fff;background:#c62828;padding:0 4px;border-radius:3px;font-size:10px" title="hard verifier blocks">⛔' + edge.blockedCount + '</span>'
        : '';
      const originBadge = edge.origin
        ? ' <span style="font-size:10px;padding:1px 4px;border:1px solid var(--border);border-radius:3px;color:var(--text-dim)" title="origin">' + esc(edge.origin) + '</span>'
        : '';
      const relationLabel = edge.relation
        ? ' <span style="font-size:10px;color:var(--text-dim)">[' + esc(edge.relation) + ']</span>'
        : '';
      return '<div class="trace-meta" style="font-size:11px">'
        + esc(sourceLabel) + ' → ' + esc(targetLabel)
        + ' <span style="display:inline-block;width:60px;height:6px;background:var(--border);border-radius:3px;vertical-align:middle"><span style="display:block;width:' + barWidth + '%;height:100%;background:#50c878;border-radius:3px"></span></span>'
        + ' ' + edge.weight.toFixed(3)
        + ' (✓' + (edge.successCount || 0) + ' ✗' + (edge.failureCount || 0) + ')'
        + protectedBadge + blockedBadge + relationLabel + originBadge
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
      const taskBadge = ep.taskType
        ? ' <span style="font-size:10px;padding:1px 4px;border:1px solid var(--border);border-radius:3px;color:var(--text-dim)">' + esc(ep.taskType) + '</span>'
        : '';
      const dryBadge = ep.dryRun ? ' <span style="font-size:10px;color:#ffb050">[dry-run]</span>' : '';
      const blockedBadge = ep.blocked ? ' <span style="font-size:10px;color:#fff;background:#c62828;padding:0 4px;border-radius:3px" title="' + escAttr(ep.blockReason || 'blocked') + '">⛔</span>' : '';
      return '<div class="trace-meta" style="font-size:11px">'
        + '<span style="color:' + rewardColor + '">' + (ep.reward || 0).toFixed(2) + '</span>' + taskBadge + dryBadge + blockedBadge + ' '
        + esc(routeStr || '(empty)')
        + ' <span style="color:var(--text-dim)">' + esc(ts) + '</span>'
        + '</div>';
    }).join('');

    const episodesPanel = episodes.length === 0
      ? '<div class="trace-meta">No episodes yet. Routes are recorded after each chat.</div>'
      : '<details><summary class="trace-meta" style="cursor:pointer">Recent episodes (' + Math.min(episodes.length, 10) + ' of ' + episodes.length + ')</summary>' + episodeRows + '</details>';

    // Last route inspector — fetched separately from /api/mycelium/last-route.
    let lastRoutePanel = '<div class="trace-meta">No route recorded yet.</div>';
    try {
      const lastRouteData = await fetch('/api/mycelium/last-route').then((r) => r.json());
      const ep = lastRouteData.episode;
      if (ep) {
        const routeNodes = Array.isArray(lastRouteData.nodes) ? lastRouteData.nodes : [];
        const reasonsObj = ep.selectionReasons || {};
        // Group selection reasons by reason type so safety vs. learning splits scan easily.
        const reasonGroups = {};
        for (const [edgeKey, reason] of Object.entries(reasonsObj)) {
          if (!reasonGroups[reason]) reasonGroups[reason] = [];
          reasonGroups[reason].push(edgeKey);
        }
        const reasonOrder = ['safety_required', 'verifier_required', 'protected_required', 'exploitation', 'exploration', 'fallback'];
        const reasonColors = {
          safety_required: '#ff4444',
          verifier_required: '#ff8c00',
          protected_required: '#ff8c00',
          exploitation: '#50c878',
          exploration: '#5bb0ff',
          fallback: '#888',
        };
        const groupedReasonRows = Object.entries(reasonGroups)
          .sort(([a], [b]) => (reasonOrder.indexOf(a) === -1 ? 99 : reasonOrder.indexOf(a)) - (reasonOrder.indexOf(b) === -1 ? 99 : reasonOrder.indexOf(b)))
          .map(([reason, edgeKeys]) => {
            const color = reasonColors[reason] || '#888';
            const rows = edgeKeys.map((k) => '<div class="trace-meta" style="font-size:11px;padding-left:14px">↳ ' + esc(k) + '</div>').join('');
            return '<details' + (reason.endsWith('_required') ? ' open' : '') + '><summary class="trace-meta" style="cursor:pointer;color:' + color + '">'
              + esc(reason) + ' (' + edgeKeys.length + ')</summary>' + rows + '</details>';
          }).join('');
        const orderedRoute = (ep.route || []).map((id) => esc(id.replace(/^[^.]+\./, ''))).join(' → ');
        const rewardColor = ep.reward > 0.5 ? '#50c878' : ep.reward > 0.3 ? '#ffb050' : '#ff5050';
        const headerLine = '<div class="trace-meta" style="font-size:11px"><strong>' + esc(ep.query || '(no query)') + '</strong>'
          + ' <span style="color:' + rewardColor + '">reward:' + (ep.reward || 0).toFixed(2) + '</span>'
          + (ep.taskType ? ' <span style="font-size:10px;padding:1px 4px;border:1px solid var(--border);border-radius:3px">' + esc(ep.taskType) + '</span>' : '')
          + (ep.dryRun ? ' <span style="color:#ffb050">[dry-run]</span>' : '')
          + (ep.blocked ? ' <span style="color:#fff;background:#c62828;padding:1px 6px;border-radius:3px;font-weight:bold" title="' + escAttr(ep.blockReason || 'verifier hard-check failure') + '">⛔ BLOCKED</span>' : '')
          + '</div>';
        const blockReasonLine = ep.blocked && ep.blockReason
          ? '<div class="trace-meta" style="font-size:11px;color:#ff5050;padding:2px 0">' + esc(ep.blockReason) + '</div>'
          : '';
        // Applied verifiers from the heuristic verifier.
        const appliedVerifiers = Array.isArray(ep.appliedVerifiers) ? ep.appliedVerifiers : [];
        const verifiersPanel = appliedVerifiers.length > 0
          ? '<details><summary class="trace-meta" style="cursor:pointer;color:#9c27b0">Applied verifiers (' + appliedVerifiers.length + ')</summary>'
            + appliedVerifiers.map((v) => '<div class="trace-meta" style="font-size:11px;padding-left:14px">✓ ' + esc(v) + '</div>').join('')
            + '</details>'
          : '';
        // Reward components breakdown.
        const rcObj = ep.rewardComponents || {};
        const rcEntries = Object.entries(rcObj).filter(([k]) => k !== 'final');
        const rewardComponentsPanel = rcEntries.length > 0
          ? '<details><summary class="trace-meta" style="cursor:pointer">Reward components</summary>'
            + rcEntries.map(([k, v]) => '<div class="trace-meta" style="font-size:11px;padding-left:14px">' + esc(k) + ': ' + Number(v).toFixed(2) + '</div>').join('')
            + '</details>'
          : '';
        lastRoutePanel = headerLine
          + blockReasonLine
          + '<div class="trace-meta" style="font-size:11px;padding:4px 0"><strong>Route:</strong> ' + (orderedRoute || '(empty)') + '</div>'
          + (Object.keys(reasonsObj).length > 0
            ? '<details open><summary class="trace-meta" style="cursor:pointer">Selection reasons by type (' + Object.keys(reasonsObj).length + ' edges)</summary>' + groupedReasonRows + '</details>'
            : '')
          + verifiersPanel
          + rewardComponentsPanel
          + (routeNodes.length > 0
            ? '<details><summary class="trace-meta" style="cursor:pointer">Route nodes (' + routeNodes.length + ')</summary>'
              + routeNodes.map((n) => '<div class="trace-meta" style="font-size:11px"><span style="color:' + (typeColors[n.type] || '#888') + '">●</span> ' + esc(n.label) + ' <span style="color:var(--text-dim)">[' + esc(n.type) + ']</span></div>').join('')
              + '</details>'
            : '');
      }
    } catch(e){ /* last route is optional */ }

    // Blocked routes panel: edges that have repeatedly hit a verifier hard-check.
    const blockedEdges = edges.filter((e) => e.blockedCount && e.blockedCount > 0);
    let blockedPanel = '<div class="trace-meta">No blocked routes recorded.</div>';
    if (blockedEdges.length > 0) {
      const sorted = [...blockedEdges].sort((a, b) => (b.blockedCount || 0) - (a.blockedCount || 0));
      const rows = sorted.map((edge) => {
        const sourceLabel = edge.source.replace(/^[^.]+\./, '');
        const targetLabel = edge.target.replace(/^[^.]+\./, '');
        const lastBlocked = edge.lastBlockedAt ? new Date(edge.lastBlockedAt).toLocaleString() : '?';
        return '<div class="trace-meta" style="font-size:11px">'
          + '<span style="color:#fff;background:#c62828;padding:1px 5px;border-radius:3px">⛔ ' + (edge.blockedCount || 0) + '</span> '
          + esc(sourceLabel) + ' → ' + esc(targetLabel)
          + ' <span style="color:var(--text-dim)">weight=' + (edge.weight || 0).toFixed(3) + ', last blocked ' + esc(lastBlocked) + '</span>'
          + '</div>';
      }).join('');
      blockedPanel = '<details open><summary class="trace-meta" style="cursor:pointer;color:#c62828">'
        + 'Routes blocked by verifier hard-checks (' + sorted.length + ')</summary>' + rows + '</details>';
    }

    view.innerHTML = header + statsHtml
      + '<div class="trace-list">'
      + '<div class="trace-item"><div class="trace-title">Last route</div>' + lastRoutePanel + '</div>'
      + '<div class="trace-item"><div class="trace-title">Blocked routes</div>' + blockedPanel + '</div>'
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

