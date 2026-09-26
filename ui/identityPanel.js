// Identity panel: adaptive USER/SOUL updates, proposal review, history.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Adaptive identity controls ────────────────────────────────────
// USER auto-apply: when on, observation passes can rewrite USER.md
// directly (a snapshot is taken first). SOUL suggest: when on, the
// scheduler may write SOUL.proposed.md but never SOUL.md itself —
// proposals appear here for the user to accept or discard.
async function refreshIdentityAutoUpdatePanel() {
  const panel = document.getElementById('identityAutoUpdatePanel');
  if (!panel) return;
  try {
    const [configRes, proposalRes, historyRes] = await Promise.all([
      fetch('/api/identity/auto-update'),
      fetch('/api/identity/soul-proposal'),
      fetch('/api/identity/history'),
    ]);
    const configData = await configRes.json();
    const proposalData = await proposalRes.json();
    const historyData = await historyRes.json();
    const cfg = configData.config || { user: false, soul: false };
    const running = !!configData.schedulerRunning;
    const proposal = proposalData.proposal;
    const snapshots = Array.isArray(historyData.snapshots) ? historyData.snapshots : [];

    const statusBadge = running
      ? '<span class="trace-meta" style="color:#4ec9b0">scheduler: running</span>'
      : '<span class="trace-meta" style="color:#888">scheduler: stopped</span>';

    const togglesHtml =
      '<div style="display:flex;flex-direction:column;gap:8px;margin:8px 0">'
      + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">'
      +   '<input type="checkbox" id="identityToggleUser" ' + (cfg.user ? 'checked' : '') + ' onchange="setIdentityAutoUpdate(\'user\', this.checked)" />'
      +   '<span><strong>USER auto-apply</strong> — periodically rewrite <code>USER.md</code> from recent sessions. Snapshot taken first.</span>'
      + '</label>'
      + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">'
      +   '<input type="checkbox" id="identityToggleSoul" ' + (cfg.soul ? 'checked' : '') + ' onchange="setIdentityAutoUpdate(\'soul\', this.checked)" />'
      +   '<span><strong>SOUL suggest</strong> — periodically write proposed edits to <code>SOUL.proposed.md</code> for review. Never auto-applied.</span>'
      + '</label>'
      + '</div>'
      + '<div style="display:flex;gap:8px;align-items:center;margin:8px 0">'
      +   '<button class="btn-secondary btn-sm" onclick="runIdentityAutoUpdateNow()">Run now</button>'
      +   statusBadge
      + '</div>';

    let proposalHtml = '';
    if (proposal && proposal.after) {
      const rationale = proposal.rationale ? '<div class="trace-meta" style="margin-top:6px"><em>' + esc(proposal.rationale) + '</em></div>' : '';
      const generatedAt = proposal.capturedAt ? ' · proposed ' + esc(proposal.capturedAt) : '';
      proposalHtml =
        '<div class="skill-card" style="border-left:3px solid #d7ba7d;margin-top:8px">'
        + '<div class="skill-card-top">'
        +   '<div style="flex:1">'
        +     '<div class="skill-card-name">Pending SOUL proposal</div>'
        +     '<div class="skill-card-meta">SOUL.proposed.md is ready for review' + generatedAt + '</div>'
        +     rationale
        +     '<pre style="margin-top:8px;max-height:240px;overflow:auto;background:#1e1e1e;padding:8px;border-radius:4px;font-size:12px">' + esc(proposal.after) + '</pre>'
        +   '</div>'
        + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:8px">'
        +   '<button class="btn-secondary btn-sm" onclick="acceptIdentitySoulProposal()">Accept</button>'
        +   '<button class="btn-secondary btn-sm" onclick="discardIdentitySoulProposal()">Discard</button>'
        + '</div>'
        + '</div>';
    }

    let historyHtml = '';
    if (snapshots.length > 0) {
      const rows = snapshots.slice(0, 5).map((snap) => {
        const when = snap.capturedAt ? esc(snap.capturedAt) : esc(snap.id);
        const reason = snap.reason ? esc(snap.reason) : 'manual';
        return '<div class="skill-card"><div class="skill-card-top">'
          + '<div style="flex:1"><div class="skill-card-name">' + when + '</div><div class="skill-card-meta">' + reason + '</div></div>'
          + '<div><button class="btn-secondary btn-sm" onclick="restoreIdentitySnapshot(\'' + esc(snap.id) + '\')">Restore</button></div>'
          + '</div></div>';
      }).join('');
      historyHtml = '<div style="margin-top:12px"><div class="trace-meta" style="margin-bottom:4px">Recent snapshots (' + snapshots.length + ' total, showing 5)</div>' + rows + '</div>';
    } else {
      historyHtml = '<div class="trace-meta" style="margin-top:12px">No identity snapshots yet — one is taken automatically before any change.</div>';
    }

    panel.innerHTML = '<h5>Adaptive identity</h5>' + togglesHtml + proposalHtml + historyHtml;
  } catch (error) {
    panel.innerHTML = '<h5>Adaptive identity</h5><div class="trace-meta">Failed to load: ' + esc(error && error.message ? error.message : String(error)) + '</div>';
  }
}

async function setIdentityAutoUpdate(field, value) {
  try {
    // Read current then merge — the PUT endpoint is whole-object replace.
    const currentRes = await fetch('/api/identity/auto-update');
    const currentData = await currentRes.json();
    const cfg = currentData.config || { user: false, soul: false };
    cfg[field] = !!value;
    // The server audit-gates any config where adaptive identity stays enabled
    // (user || soul). Collect a reason then, mirroring the dontAsk escalation.
    const enabling = !!cfg.user || !!cfg.soul;
    let reason;
    if (enabling) {
      const reasonInput = await promptToast('Enabling adaptive identity lets the scheduler rewrite USER.md and propose SOUL edits. Enter a reason (minimum 8 characters):', 'Enabling adaptive identity for this workspace');
      if (reasonInput === null) { refreshIdentityAutoUpdatePanel(); return; }
      reason = String(reasonInput).trim();
      if (reason.length < 8) {
        showToast('Reason must be at least 8 characters.');
        refreshIdentityAutoUpdatePanel();
        return;
      }
    }
    const response = await fetch('/api/identity/auto-update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: !!cfg.user, soul: !!cfg.soul, reason }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    showToast('Adaptive identity: ' + field + ' = ' + (value ? 'on' : 'off'));
  } catch (error) {
    showToast('Update failed: ' + (error && error.message ? error.message : error));
    refreshIdentityAutoUpdatePanel();
  }
}

async function runIdentityAutoUpdateNow() {
  // A manual tick can rewrite USER.md or stage a SOUL proposal, so the server
  // requires an audit reason just like enabling the toggle.
  const reasonInput = await promptToast('Running a tick can rewrite USER.md or stage a SOUL proposal. Enter a reason (minimum 8 characters):', 'Manual identity auto-update tick');
  if (reasonInput === null) return;
  const reason = String(reasonInput).trim();
  if (reason.length < 8) { showToast('Reason must be at least 8 characters.'); return; }
  showToast('Running identity auto-update tick…');
  try {
    const response = await fetch('/api/identity/auto-update/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (data.ran === false) {
      showToast('Tick skipped: ' + (data.reason || 'no work to do'));
    } else {
      showToast('Tick complete.');
    }
    refreshIdentityAutoUpdatePanel();
  } catch (error) {
    showToast('Run failed: ' + (error && error.message ? error.message : error));
  }
}

async function acceptIdentitySoulProposal() {
  if (!await confirmToast('Accept proposed SOUL.md? A snapshot of the current SOUL is taken first.')) return;
  try {
    const response = await fetch('/api/identity/soul-proposal/accept', { method: 'POST' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    showToast('SOUL updated. Snapshot: ' + (data.snapshotId || 'taken'));
    await loadIdentity();
    if (typeof checkIdentityHealth === 'function') checkIdentityHealth();
  } catch (error) {
    showToast('Accept failed: ' + (error && error.message ? error.message : error));
  }
}

async function discardIdentitySoulProposal() {
  if (!await confirmToast('Discard pending SOUL proposal?')) return;
  try {
    const response = await fetch('/api/identity/soul-proposal/discard', { method: 'POST' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    showToast(data.discarded ? 'Proposal discarded.' : 'No proposal to discard.');
    refreshIdentityAutoUpdatePanel();
    if (typeof checkIdentityHealth === 'function') checkIdentityHealth();
  } catch (error) {
    showToast('Discard failed: ' + (error && error.message ? error.message : error));
  }
}

async function restoreIdentitySnapshot(id) {
  if (!await confirmToast('Restore identity from snapshot ' + id + '? Current SOUL/USER will be backed up first.')) return;
  try {
    const response = await fetch('/api/identity/history/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    const backupId = data.backup && data.backup.id ? data.backup.id : 'taken';
    showToast('Restored. Backup of prior state: ' + backupId);
    await loadIdentity();
    if (typeof checkIdentityHealth === 'function') checkIdentityHealth();
  } catch (error) {
    showToast('Restore failed: ' + (error && error.message ? error.message : error));
  }
}

