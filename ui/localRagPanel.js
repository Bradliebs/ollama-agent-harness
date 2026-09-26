// Local RAG panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

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
    const header = '<div class="panel-header panel-header-flat"><h3>Local RAG</h3><div class="inline-actions"><button class="btn-sm" onclick="loadRagTab()">Refresh</button></div></div>';
    if (ragState.selectedPaths.size === 0) {
      for (const suggestion of ['README.md', 'docs', 'cookbook']) ragState.selectedPaths.add(suggestion);
    }
    const builder = '<div class="trace-item">'
      + '<div class="trace-title">Build index</div>'
      + '<div class="trace-meta panel-copy">Pick files and folders to index. Use the project tree for this repo, or browse to another folder on disk. Only text files are indexed; <code>node_modules</code>, <code>.git</code>, <code>dist</code>, and <code>.harness</code> are skipped.</div>'
      + '<div class="settings-action-row"><input id="ragBuildName" type="text" placeholder="index name (e.g. docs)" class="compact-panel-input"></div>'
      + '<div class="rag-picker">'
      +   '<div class="rag-picker-label">Selected files & folders</div>'
      +   '<div id="ragSelectedList" class="rag-selected"></div>'
      +   '<div class="inline-actions trace-block-spaced"><button class="btn-sm" onclick="toggleRagDirBrowser()">Browse folders</button><button class="btn-sm" onclick="ragAddProjectRoot()">Add project root</button></div>'
      +   '<div id="ragDirBrowser" class="settings-browser-panel hidden-by-default"></div>'
      +   '<details class="details-mt6" open><summary class="trace-meta clickable-summary">Project files</summary>'
      +   '<div id="ragFileTree" class="rag-tree"><div class="trace-meta">Loading project files…</div></div>'
      +   '</details>'
      + '</div>'
      + '<details class="details-mt6"><summary class="trace-meta clickable-summary">Advanced: type paths manually</summary>'
      +   '<div class="settings-action-row trace-block-spaced"><input id="ragBuildPathsManual" type="text" placeholder="comma-separated, e.g. docs,README.md" class="compact-panel-input"><button class="btn-sm" onclick="ragAddManualPaths()">Add</button></div>'
      + '</details>'
      + '<div class="settings-action-row trace-block-spaced-large"><select id="ragBuildBackend" class="compact-panel-select"><option value="">auto-detect backend</option><option value="ollama">ollama embeddings</option><option value="hash">hash fallback (offline)</option></select></div>'
      + '<div class="inline-actions trace-block-spaced-large"><button class="btn-sm" onclick="ragPreview()">🔍 Preview matches</button> <button class="btn-sm primary" onclick="ragBuild()">Build index</button></div>'
      + '<div id="ragBuildStatus" class="rag-status trace-block-spaced-large"></div>'
      + '<div id="ragPreviewResults" class="rag-preview"></div>'
      + '</div>';
    const queryBox = '<div class="trace-item">'
      + '<div class="trace-title">Search</div>'
      + '<div class="settings-action-row"><select id="ragQueryName" class="compact-panel-select">' + indexes.map((i) => '<option value="' + escAttr(i.name) + '">' + esc(i.name) + ' (' + i.chunks + ')</option>').join('') + '</select></div>'
      + '<div class="settings-action-row"><input id="ragQueryText" type="text" placeholder="natural-language query" class="compact-panel-input" onkeydown="if(event.key===\'Enter\'){ragSearch()}"></div>'
      + '<button class="btn-sm" onclick="ragSearch()">Search</button>'
      + '<div class="trace-detail initial-hidden trace-block-spaced" id="ragQueryResults"></div>'
      + '</div>';
    let listing;
    if (indexes.length === 0) {
      listing = '<div class="trace-meta panel-empty">(no indexes yet)</div>';
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
          + '<div class="inline-actions trace-block-spaced">'
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
  } catch(e){ /* leave status empty */ }
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

function ragAddProjectRoot() {
  ragState.selectedPaths.add('.');
  renderRagSelectedList();
  renderRagTree();
}

function toggleRagDirBrowser() {
  const browser = document.getElementById('ragDirBrowser');
  if (!browser) return;
  if (browser.classList.contains('hidden-by-default')) {
    browser.classList.remove('hidden-by-default');
    loadRagDirBrowser('');
  } else {
    browser.classList.add('hidden-by-default');
  }
}

async function loadRagDirBrowser(targetPath) {
  const browser = document.getElementById('ragDirBrowser');
  if (!browser) return;
  browser.innerHTML = '<div class="settings-status-line">Loading folders...</div>';
  try {
    const url = '/api/browse-dirs' + (targetPath ? '?path=' + encodeURIComponent(targetPath) : '');
    const response = await fetch(url);
    if (!response.ok) throw new Error('browse failed (' + response.status + ')');
    const data = await response.json();
    renderRagDirBrowser(data);
  } catch (error) {
    browser.innerHTML = '<div class="settings-warning-line">Could not browse folders: ' + esc(error.message || error) + '</div>';
  }
}

function renderRagDirBrowser(data) {
  const browser = document.getElementById('ragDirBrowser');
  if (!browser) return;
  let html = '<div class="folder-preset-row">';
  for (const preset of (data.presets || [])) {
    html += '<button class="btn-sm btn-folder-preset" data-path="' + escAttr(preset.path) + '" onclick="loadRagDirBrowser(this.dataset.path)" title="' + escAttr(preset.path) + '">' + esc(preset.label) + '</button>';
  }
  html += '</div>';
  html += '<div class="folder-current-row">'
    + '<span class="folder-current-path" title="' + escAttr(data.cwd || '') + '"><code>' + esc(data.cwd || '') + '</code></span>'
    + '<button class="btn-sm primary btn-folder-use" data-path="' + escAttr(data.cwd || '') + '" onclick="ragUseBrowsedDir(this.dataset.path)">Add this folder</button>'
    + '</div>';
  if (data.parent) html += '<div class="folder-up-row"><button class="btn-sm btn-folder-up" data-path="' + escAttr(data.parent) + '" onclick="loadRagDirBrowser(this.dataset.path)">Up</button></div>';
  if (data.error) html += '<div class="settings-warning-line folder-warning">' + esc(data.error) + '</div>';
  const dirs = data.dirs || [];
  if (dirs.length === 0) {
    html += '<div class="folder-empty">No subfolders here.</div>';
  } else {
    html += '<div class="folder-list">';
    for (const dir of dirs.slice(0, 200)) {
      html += '<div class="folder-list-row" data-path="' + escAttr(dir.path) + '" onclick="loadRagDirBrowser(this.dataset.path)">📁 ' + esc(dir.name) + '</div>';
    }
    html += '</div>';
    if (dirs.length > 200) html += '<div class="folder-overflow-note">' + (dirs.length - 200) + ' more not shown</div>';
  }
  browser.innerHTML = html;
}

function ragUseBrowsedDir(folderPath) {
  if (!folderPath) return;
  ragState.selectedPaths.add(folderPath);
  renderRagSelectedList();
  const browser = document.getElementById('ragDirBrowser');
  if (browser) browser.classList.add('hidden-by-default');
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
  } catch(e){ ragState.treeCache.set(relativeDir, []); }
  renderRagTree();
}

function renderRagTree() {
  const root = document.getElementById('ragFileTree');
  if (!root) return;
  root.innerHTML = renderRagTreeLevel('', 0);
  applyDataIndents(root);
}

function renderRagTreeLevel(relativeDir, depth) {
  const items = ragState.treeCache.get(relativeDir);
  if (!items) return '<div class="trace-meta" data-indent-depth="' + depth + '">…</div>';
  if (items.length === 0) return '<div class="trace-meta" data-indent-depth="' + depth + '">(empty)</div>';
  return items.map((item) => renderRagTreeItem(item, relativeDir, depth)).join('');
}

function renderRagTreeItem(item, parentRelative, depth) {
  const relative = typeof item.relative === 'string' && item.relative
    ? item.relative
    : (parentRelative ? parentRelative + '/' + item.name : item.name);
  const isDir = item.type === 'dir';
  const checked = ragState.selectedPaths.has(relative) ? 'checked' : '';
  const expanded = ragState.expanded.has(relative);
  const toggleSymbol = isDir ? (expanded ? '▾' : '▸') : '·';
  const onToggle = isDir ? 'onclick="ragToggleDir(\'' + escAttr(relative) + '\')"' : '';
  const row = '<div class="rag-tree-row" data-indent-depth="' + depth + '">'
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
  const backend = data.backend ? '<div class="trace-meta trace-block-spaced">Detected backend: <strong>' + esc(data.backend.name) + '</strong> (' + esc(data.backend.model) + ', dim=' + data.backend.dim + ')</div>' : '';
  out.innerHTML = '<div class="rag-preview-body"><div class="trace-title panel-copy">Preview · ' + (data.totalFiles || 0) + ' file(s) total</div>' + (rows || '<div class="trace-meta">No paths selected.</div>') + backend + '</div>';
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
        try { payload = JSON.parse(dataLine); } catch(e){ continue; }
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
    + '<div class="prewrap-muted details-body-mt4">' + esc(row.content.slice(0, 600)) + (row.content.length > 600 ? '…' : '') + '</div>'
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
  if (!await confirmToast('Delete index "' + name + '"?')) return;
  try {
    const r = await fetch('/api/rag/indexes/' + encodeURIComponent(name), { method: 'DELETE' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    await loadRagTab();
  } catch (e) { showToast(e.message); }
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
  if (!await confirmToast('Rebuild index "' + name + '" with the same ' + idx.prefs.paths.length + ' path(s)?')) return;
  ragState.selectedPaths = new Set(idx.prefs.paths);
  const nameInput = document.getElementById('ragBuildName');
  if (nameInput) nameInput.value = name;
  const backendSelect = document.getElementById('ragBuildBackend');
  if (backendSelect) backendSelect.value = idx.prefs.backend || '';
  await ragBuild();
}

