// Code intelligence panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Code Intelligence Tab ─────────────────────────────────────────
async function loadCodeIntel() {
  const view = document.getElementById('codeintelView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading code intelligence…</div>';
  try {
    const res = await fetch('/api/code-intelligence/summary');
    if (res.status === 404) {
      view.innerHTML = '<div class="trace-item"><div class="trace-title">🧬 Code Intelligence</div>'
        + '<div class="trace-meta">No repo graph built yet.</div>'
        + '<div class="document-actions"><button class="btn-sm" onclick="buildCodeIntelGraph()">Build Graph</button></div></div>';
      return;
    }
    const data = await res.json();
    const topImported = (data.most_imported || []).slice(0, 8).map((f) => '<div class="trace-meta" style="cursor:pointer" onclick="showFileImpact(\'' + escAttr(f.file) + '\')">📥 ' + esc(f.file) + ' (' + f.count + ' importers) <span style="opacity:0.5">▶ impact</span></div>').join('');
    const topComplex = (data.most_complex || []).slice(0, 8).map((f) => '<div class="trace-meta" style="cursor:pointer" onclick="showFileImpact(\'' + escAttr(f.file) + '\')">🔀 ' + esc(f.file) + ' (' + f.imports + ' imports, ' + f.exports + ' exports) <span style="opacity:0.5">▶ impact</span></div>').join('');
    view.innerHTML = '<div class="trace-item"><div class="trace-title">🧬 Code Intelligence</div>'
      + '<div class="trace-meta">' + (data.total_files || 0) + ' files · ' + (data.total_edges || 0) + ' edges · ' + (data.total_exports || 0) + ' exports · ' + (data.test_files || 0) + ' tests</div>'
      + '<div class="document-actions"><button class="btn-sm" onclick="buildCodeIntelGraph()">Rebuild</button> <button class="btn-sm" onclick="showArchDiagram()">Architecture Diagram</button></div>'
      + '<div style="margin:8px 0"><input type="text" id="codeIntelSearch" placeholder="Search file for impact analysis…" class="panel-search" style="width:100%" onkeydown="if(event.key===\'Enter\')showFileImpact(this.value)"><button class="btn-sm" onclick="showFileImpact(document.getElementById(\'codeIntelSearch\').value)" style="margin-top:4px">Analyze</button></div>'
      + '<div class="trace-item"><div class="trace-title">Most Imported</div>' + (topImported || '<div class="trace-meta">—</div>') + '</div>'
      + '<div class="trace-item"><div class="trace-title">Most Complex</div>' + (topComplex || '<div class="trace-meta">—</div>') + '</div>'
      + '<div id="codeIntelImpactPanel"></div>'
      + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}
async function buildCodeIntelGraph() {
  const view = document.getElementById('codeintelView');
  if (view) view.innerHTML = '<div class="trace-meta">Building repo graph…</div>';
  try {
    await fetch('/api/code-intelligence/build', { method: 'POST' });
    loadCodeIntel();
  } catch (error) {
    if (view) view.innerHTML = '<div class="trace-meta">Build failed: ' + esc(error.message || error) + '</div>';
  }
}
async function showFileImpact(filePath) {
  const panel = document.getElementById('codeIntelImpactPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="trace-meta">Analyzing impact of ' + esc(filePath) + '…</div>';
  try {
    const res = await fetch('/api/code-intelligence/impact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [filePath] }),
    });
    const data = await res.json();
    if (data.error) { panel.innerHTML = '<div class="trace-meta">' + esc(data.error) + '</div>'; return; }
    const riskColor = data.risk_score > 0.5 ? 'var(--danger,red)' : data.risk_score > 0.2 ? 'var(--warning,orange)' : 'var(--success,green)';
    const directRows = (data.direct || []).slice(0, 10).map((f) => '<div class="trace-meta">  → ' + esc(f) + '</div>').join('');
    const transitiveRows = (data.transitive || []).slice(0, 10).map((f) => '<div class="trace-meta" style="opacity:0.7">  ⤳ ' + esc(f) + '</div>').join('');
    const testRows = (data.affected_tests || []).slice(0, 10).map((f) => '<div class="trace-meta">  🧪 ' + esc(f) + '</div>').join('');
    panel.innerHTML = '<div class="trace-item"><div class="trace-title">Impact: ' + esc(filePath) + '</div>'
      + '<div class="trace-meta">Risk: <span style="color:' + riskColor + '">' + Math.round((data.risk_score || 0) * 100) + '%</span>'
      + ' · ' + (data.direct || []).length + ' direct · ' + (data.transitive || []).length + ' transitive · ' + (data.affected_tests || []).length + ' tests</div>'
      + (directRows ? '<div class="trace-meta" style="font-weight:600">Direct importers:</div>' + directRows : '')
      + (transitiveRows ? '<div class="trace-meta" style="font-weight:600">Transitive:</div>' + transitiveRows : '')
      + (testRows ? '<div class="trace-meta" style="font-weight:600">Affected tests:</div>' + testRows : '')
      + '</div>';
  } catch (error) {
    panel.innerHTML = '<div class="trace-meta">Impact analysis failed: ' + esc(error.message || error) + '</div>';
  }
}
async function showArchDiagram() {
  const panel = document.getElementById('codeIntelImpactPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="trace-meta">Generating architecture diagram…</div>';
  try {
    const res = await fetch('/api/code-intelligence/diagram');
    const data = await res.json();
    if (data.error) { panel.innerHTML = '<div class="trace-meta">' + esc(data.error) + '</div>'; return; }
    const mermaidTheme = localStorage.getItem('harness-theme') === 'light' ? 'default' : 'dark';
    const mermaidBg = mermaidTheme === 'default' ? '#fff' : '#1e1e2e';
    const mmdBlob = JSON.stringify(data.mermaid);
    panel.innerHTML = '<div class="trace-item"><div class="trace-title">Architecture Diagram</div>'
      + '<iframe sandbox="allow-scripts" style="width:100%;height:500px;border:1px solid var(--border,#333);border-radius:4px;background:' + mermaidBg + '" srcdoc="' + escAttr('<!doctype html><html><head><meta charset=utf-8><script src=https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js></script><style>body{margin:8px;font-family:system-ui,sans-serif;background:' + mermaidBg + ';overflow:auto}svg{max-width:100%;height:auto}</style></head><body><div class=mermaid>' + esc(data.mermaid) + '</div><script>mermaid.initialize({startOnLoad:true,theme:\'' + mermaidTheme + '\',securityLevel:"loose",fontFamily:"system-ui,sans-serif",fontSize:13,flowchart:{htmlLabels:true,curve:"basis",padding:20,nodeSpacing:50,rankSpacing:80}})</script></body></html>') + '"></iframe>'
      + '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:0.75em;opacity:0.6">Raw Mermaid</summary>'
      + '<pre style="font-size:0.65em;overflow-x:auto;background:var(--bg-code,#1e1e2e);padding:8px;border-radius:4px;max-height:200px">' + esc(data.mermaid) + '</pre></details>'
      + '<div class="document-actions"><button class="btn-sm" onclick="downloadMmd(' + mmdBlob + ',\'architecture.mmd\')">📥 Download .mmd</button>'
      + '<button class="btn-sm" onclick="navigator.clipboard.writeText(' + mmdBlob + ')">📋 Copy Mermaid</button></div></div>';
  } catch (error) {
    panel.innerHTML = '<div class="trace-meta">Diagram failed: ' + esc(error.message || error) + '</div>';
  }
}

