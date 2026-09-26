// Snapshots and backups panel.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

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
    const header = '<div class="panel-header panel-header-flat"><h3>Snapshots</h3><div class="inline-actions"><button class="btn-sm" onclick="takeSnapshot()">+ Take</button><button class="btn-sm" onclick="loadSnapshots()">Refresh</button></div></div>';
    const intro = '<div class="trace-meta panel-copy-loose">Backs up .harness/skills, MEMORY.md, USER.md, SOUL.md so the agent\'s self-improvement is reversible.</div>';
    if (snaps.length === 0) {
      view.innerHTML = header + intro + '<div class="trace-meta panel-empty">(no snapshots yet — click <strong>Take</strong> to capture one)</div>';
      return;
    }
    const rows = snaps.map((s) => '<div class="trace-item"><div class="trace-title">' + esc(s.id) + '</div>'
      + '<div class="trace-meta">' + esc(new Date(s.createdAt).toLocaleString()) + ' · ' + s.fileCount + ' files · ' + Math.round((s.totalBytes || 0) / 1024) + ' KB</div>'
      + '<div class="trace-meta">' + esc(s.reason || '') + '</div>'
      + '<div class="inline-actions trace-block-spaced"><button class="btn-sm" onclick="diffSnapshot(\'' + esc(s.id) + '\')">Diff</button>'
      + '<button class="btn-sm" onclick="restoreSnapshot(\'' + esc(s.id) + '\')">Restore</button>'
      + '<button class="btn-sm danger" onclick="deleteSnapshot(\'' + esc(s.id) + '\')">Delete</button></div>'
      + '<div class="trace-detail initial-hidden" id="snapDiff-' + esc(s.id) + '"></div></div>').join('');
    view.innerHTML = header + intro + '<div class="trace-list">' + rows + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message) + '</div>';
  }
}

async function takeSnapshot() {
  const reason = await promptToast('Snapshot label (optional):', 'manual');
  if (reason === null) return;
  try {
    const r = await fetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    await loadSnapshots();
  } catch (e) { showToast(e.message); }
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
    if (d.added && d.added.length)    sections.push('<div><strong>Added (' + d.added.length + ')</strong><div class="prewrap-text">' + esc(d.added.join('\n')) + '</div></div>');
    if (d.modified && d.modified.length) sections.push('<div><strong>Modified (' + d.modified.length + ')</strong><div class="prewrap-text">' + esc(d.modified.join('\n')) + '</div></div>');
    if (d.removed && d.removed.length) sections.push('<div><strong>Removed (' + d.removed.length + ')</strong><div class="prewrap-text">' + esc(d.removed.join('\n')) + '</div></div>');
    detail.innerHTML = sections.length ? sections.join('<div class="spacer-6"></div>') : '<div>No changes since this snapshot.</div>';
  } catch (e) { detail.textContent = e.message; }
}

async function restoreSnapshot(id) {
  if (!await confirmToast('Restore snapshot ' + id + '?\n\nA pre-restore safety snapshot will be taken first so you can undo.')) return;
  try {
    const r = await fetch('/api/snapshots/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    showToast('Restored ' + d.restoredFiles + ' file(s).\nSafety snapshot: ' + d.safetySnapshotId);
    await loadSnapshots();
  } catch (e) { showToast(e.message); }
}

async function deleteSnapshot(id) {
  if (!await confirmToast('Delete snapshot ' + id + '? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/snapshots/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    await loadSnapshots();
  } catch (e) { showToast(e.message); }
}

