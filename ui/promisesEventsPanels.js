// Promises, activity, triggers, agents, squads, identity, artifacts, health, and events panels.
//
// Moved out of app.js to shrink it.
// Loaded before app.js; shares its global scope (classic script).

// ─── Promises Tab ───────────────────────────────────────────────────
async function loadPromises() {
  const view = document.getElementById('promisesView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading promises…</div>';
  try {
    const [promisesR, obligationsR] = await Promise.allSettled([
      fetch('/api/promises').then((r) => r.json()),
      fetch('/api/promises/obligations').then((r) => r.json()),
    ]);
    const promises = promisesR.status === 'fulfilled' ? promisesR.value : { promises: [] };
    const obligations = obligationsR.status === 'fulfilled' ? obligationsR.value : { breaches: [] };
    const breaches = obligations.breaches || [];
    const rows = (promises.promises || []).map((p) => {
      const statusIcon = p.status === 'fulfilled' ? '✅' : p.status === 'failed' ? '❌' : p.status === 'expired' ? '⏰' : p.status === 'cancelled' ? '🚫' : '🔵';
      // Timeline: created → fulfilled/failed/expired/cancelled
      const created = p.created_at?.slice(0, 16) || '?';
      const endTs = p.last_fulfilled_at?.slice(0, 16) || p.updated_at?.slice(0, 16) || '';
      const timeline = p.status !== 'pending' && endTs ? ' → ' + esc(p.status) + ' ' + esc(endTs) : '';
      const failCount = p.failure_count > 0 ? ' · ' + p.failure_count + ' failure(s)' : '';
      return '<div class="trace-item"><div class="trace-title">' + statusIcon + ' ' + esc(p.commitment.slice(0, 100)) + '</div>'
        + '<div class="trace-meta">' + esc(p.status) + ' · ' + esc(created) + timeline + failCount
        + (p.next_due_at ? ' · due ' + esc(p.next_due_at.slice(0, 16)) : '')
        + (p.service_id ? ' · service: ' + esc(p.service_id) : '')
        + (p.schedule_id ? ' · schedule: ' + esc(p.schedule_id.slice(0, 12)) : '')
        + '</div>'
        + (p.status === 'pending' ? '<div class="document-actions"><button class="btn-sm" onclick="fulfilPromise(\'' + escAttr(p.promise_id) + '\')">✅ Fulfil</button> <button class="btn-sm" onclick="cancelPromise(\'' + escAttr(p.promise_id) + '\')">🚫 Cancel</button></div>' : '')
        + '</div>';
    }).join('');
    const breachRows = breaches.map((b) => '<div class="trace-meta trace-meta-sm-top" style="color:var(--danger)">⚠️ ' + esc(b.breach_type) + ': ' + esc(b.detail.slice(0, 120)) + '</div>').join('');
    view.innerHTML = '<div class="trace-item"><div class="trace-title">🤝 Promise Ledger</div>'
      + '<div class="trace-meta">' + (promises.total || 0) + ' promise(s) · '
      + (obligations.pending || 0) + ' pending · '
      + (obligations.fulfilled || 0) + ' fulfilled · '
      + breaches.length + ' breach(es)</div>'
      + breachRows + rows
      + (rows ? '' : '<div class="trace-meta">No promises recorded yet.</div>')
      + '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:0.8em;opacity:0.7">➕ Create Promise</summary>'
      + '<div style="padding:8px 0"><input type="text" id="newPromiseCommitment" placeholder="What are you committing to?" class="panel-search" style="width:100%;margin-bottom:4px">'
      + '<input type="text" id="newPromiseServiceId" placeholder="Service ID (optional)" class="panel-search" style="width:100%;margin-bottom:4px">'
      + '<input type="text" id="newPromiseDueAt" placeholder="Due date (optional, ISO)" class="panel-search" style="width:100%;margin-bottom:4px">'
      + '<button class="btn-sm" onclick="createManualPromise()">Create</button></div></details>'
      + '</div>';
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}
async function fulfilPromise(id) {
  try {
    await fetch('/api/promises/' + encodeURIComponent(id) + '/fulfil', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    loadPromises();
    loadPromiseWidget();
  } catch (error) {
    console.error('fulfil failed', error);
  }
}
async function cancelPromise(id) {
  try {
    await fetch('/api/promises/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    loadPromises();
    loadPromiseWidget();
  } catch (error) {
    console.error('cancel failed', error);
  }
}

async function createManualPromise() {
  const commitment = document.getElementById('newPromiseCommitment')?.value?.trim();
  if (!commitment) return;
  const serviceId = document.getElementById('newPromiseServiceId')?.value?.trim() || undefined;
  const dueAt = document.getElementById('newPromiseDueAt')?.value?.trim() || undefined;
  try {
    await fetch('/api/promises', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitment, service_id: serviceId, next_due_at: dueAt }),
    });
    loadPromises();
    loadPromiseWidget();
  } catch (error) {
    console.error('create promise failed', error);
  }
}

async function loadPromiseWidget() {
  const widget = document.getElementById('promiseWidget');
  if (!widget) return;
  try {
    const res = await fetch('/api/promises/obligations');
    const data = await res.json();
    if (data.total === 0 && data.breaches.length === 0) { widget.style.display = 'none'; return; }
    widget.style.display = 'block';
    const breachNote = data.breaches.length > 0
      ? '<div class="pw-breach">⚠️ ' + data.breaches.length + ' breach(es)</div>'
      : '';
    // Play a subtle alert tone on new breaches
    if (data.breaches.length > 0) playBreachTone();
    widget.innerHTML = '<div class="pw-row"><span>🤝 Promises</span><span class="pw-count">' + data.pending + ' pending</span></div>'
      + '<div class="pw-row"><span style="opacity:0.6">' + data.fulfilled + ' fulfilled · ' + data.failed + ' failed · ' + data.expired + ' expired</span>'
      + '<button class="btn-sm" onclick="openLeftTabByName(\'promises\')" style="font-size:0.75em">View</button></div>'
      + breachNote;
  } catch(e){
    widget.style.display = 'none';
  }
}

// ─── Events Tab ─────────────────────────────────────────────────────

/** Play a subtle two-tone alert via Web Audio API. No external audio file needed. */
function playBreachTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch(e){ /* audio not available */ }
}

// ─── Event Timeline Builder ─────────────────────────────────────────
let _eventCategoryFilter = new Set(); // empty = show all
let _eventStreamSource = null; // SSE EventSource for live events
let _liveEventCount = 0;
function buildEventTimeline(events) {
  if (!events || events.length === 0) return '';
  // Group by hour bucket for last 24 hours
  const now = Date.now();
  const buckets = new Array(24).fill(0);
  const catBuckets = {};
  for (const ev of events) {
    if (!ev.timestamp) continue;
    const ts = new Date(ev.timestamp).getTime();
    const hoursAgo = Math.floor((now - ts) / 3_600_000);
    if (hoursAgo >= 0 && hoursAgo < 24) {
      buckets[23 - hoursAgo]++;
      const cat = ev.category || 'other';
      if (!catBuckets[cat]) catBuckets[cat] = new Array(24).fill(0);
      catBuckets[cat][23 - hoursAgo]++;
    }
  }
  const maxVal = Math.max(1, ...buckets);
  const bars = buckets.map((count, i) => {
    const pct = Math.round((count / maxVal) * 100);
    const label = i === 23 ? 'now' : (23 - i) + 'h';
    const title = count + ' event(s) ' + label + ' ago';
    return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0" title="' + title + '">'
      + '<div style="width:100%;background:var(--accent,#646cff);border-radius:2px;min-height:2px;height:' + Math.max(2, pct * 0.4) + 'px;opacity:' + (count > 0 ? 1 : 0.15) + '"></div>'
      + (i % 6 === 0 ? '<span style="font-size:0.6em;opacity:0.5;margin-top:2px">' + label + '</span>' : '')
      + '</div>';
  }).join('');
  return '<div style="display:flex;align-items:flex-end;gap:1px;height:50px;margin:8px 0;padding:4px 0">' + bars + '</div>';
}

async function loadTasks() {
  const view = document.getElementById('tasksView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading tasks…</div>';
  try {
    const response = await fetch('/api/tasks');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const summary = data.summary || {};
    const groups = ['pending', 'assigned', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled'];
    const groupLabels = { pending: 'Pending', assigned: 'Assigned', in_progress: 'In Progress', blocked: 'Blocked', review: 'Review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
    const summaryLine = '<div class="tools-summary-line"><strong>' + (summary.total || 0) + '</strong> tasks · ' + groups.map((g) => esc(groupLabels[g]) + ': ' + (summary[g] || 0)).join(' · ') + '</div>';
    const newForm = '<div class="automation-wizard"><div class="automation-wizard-title">New task</div><div class="automation-field"><label for="newTaskTitle">Title</label><input id="newTaskTitle" type="text" placeholder="Short summary" /></div><div class="automation-field"><label for="newTaskAssignee">Assignee (optional)</label><input id="newTaskAssignee" type="text" placeholder="agent id" /></div><div class="automation-field"><label for="newTaskPriority">Priority</label><input id="newTaskPriority" type="text" placeholder="low | normal | high" value="normal" /></div><div class="settings-collapse-actions"><button class="btn-sm" onclick="createTaskFromForm()">+ Create</button></div></div>';
    const groupHtml = groups.map((status) => {
      const items = tasks.filter((task) => task.status === status);
      if (items.length === 0) return '';
      const rows = items.map((task) => {
        const progress = Math.max(0, Math.min(100, Number(task.progressPercent) || 0));
        const lastCheckIn = Array.isArray(task.checkIns) && task.checkIns.length > 0 ? task.checkIns[task.checkIns.length - 1] : null;
        const meta = [
          task.priority ? esc(task.priority) : null,
          task.assigneeId ? '→ ' + esc(task.assigneeId) : null,
          lastCheckIn ? 'last: ' + esc(lastCheckIn.message).slice(0, 60) : null,
        ].filter(Boolean).join(' · ');
        const actionable = status !== 'done' && status !== 'cancelled' && status !== 'failed';
        const advance = actionable ? '<button class="btn-sm" onclick="updateTaskStatus(\'' + esc(task.id) + '\', \'done\')">Done</button> <button class="btn-sm" onclick="updateTaskStatus(\'' + esc(task.id) + '\', \'cancelled\')">Cancel</button>' : '';
        return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(task.title) + '</div><div class="skill-card-meta">' + meta + '</div></div><div class="skill-card-actions-right">' + advance + ' <button class="sk-del" onclick="deleteTaskById(\'' + esc(task.id) + '\')" title="Delete task">✕</button></div></div><div style="height:6px;background:var(--surface3);border-radius:4px;overflow:hidden;margin-top:6px"><div style="height:100%;width:' + progress + '%;background:var(--accent)"></div></div></div>';
      }).join('');
      return '<div class="mem-section"><h5>' + esc(groupLabels[status]) + ' (' + items.length + ')</h5><div class="skills-gallery">' + rows + '</div></div>';
    }).join('');
    view.innerHTML = summaryLine + newForm + (groupHtml || '<div class="trace-meta">No tasks yet — create one above.</div>') + '<div id="kanbanBoardSection"></div>';
    loadKanbanBoard();
  } catch (error) {
    view.textContent = 'Failed to load tasks: ' + (error && error.message ? error.message : error);
  }
}

async function loadKanbanBoard() {
  const host = document.getElementById('kanbanBoardSection');
  if (!host) return;
  host.innerHTML = '<div class="mem-section"><h5>Kanban</h5><div class="trace-meta">Loading board…</div></div>';
  try {
    const response = await fetch('/api/kanban/board');
    const board = await response.json();
    if (board && board.error) { host.innerHTML = '<div class="mem-section"><h5>Kanban</h5><div class="trace-meta">' + esc(board.error) + '</div></div>'; return; }
    const columns = [
      { key: 'triage', label: 'Triage' },
      { key: 'doing', label: 'Doing' },
      { key: 'done', label: 'Done' },
    ];
    const colHtml = columns.map((col) => {
      const items = Array.isArray(board[col.key]) ? board[col.key] : [];
      const cards = items.map((task) => {
        const moveBtns = columns.filter((c) => c.key !== col.key)
          .map((c) => '<button class="btn-sm" onclick="moveKanbanCard(\'' + esc(task.id) + '\', \'' + c.key + '\')">→ ' + c.label + '</button>')
          .join(' ');
        return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(task.title || task.id) + '</div><div class="skill-card-meta">' + esc(task.status || '') + ' · ' + esc(col.label) + '</div></div></div><div style="margin-top:6px">' + moveBtns + '</div></div>';
      }).join('') || '<div class="trace-meta">(empty)</div>';
      return '<div class="mem-section"><h5>' + esc(col.label) + ' (' + items.length + ')</h5><div class="skills-gallery">' + cards + '</div></div>';
    }).join('');
    host.innerHTML = '<div class="mem-section"><h5>Kanban</h5>' + colHtml + '</div>';
  } catch (error) {
    host.innerHTML = '<div class="mem-section"><h5>Kanban</h5><div class="trace-meta">Failed to load board: ' + esc((error && error.message) ? error.message : String(error)) + '</div></div>';
  }
}

async function moveKanbanCard(taskId, column) {
  try {
    const response = await fetch('/api/kanban/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, column }) });
    const data = await response.json();
    if (data && data.error) throw new Error(data.error);
    if (column === 'triage' && data && data.promoted && data.promoted.mutated) {
      showToast('Moved to triage and added to IMPLEMENTATION_PLAN.md');
    }
    await loadKanbanBoard();
  } catch (error) {
    showToast('Move failed: ' + (error && error.message ? error.message : error));
  }
}

async function createTaskFromForm() {
  const titleEl = document.getElementById('newTaskTitle');
  const assigneeEl = document.getElementById('newTaskAssignee');
  const priorityEl = document.getElementById('newTaskPriority');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) { showToast('Title is required.'); return; }
  const body = { title };
  if (assigneeEl && assigneeEl.value.trim()) body.assigneeId = assigneeEl.value.trim();
  if (priorityEl && priorityEl.value.trim()) body.priority = priorityEl.value.trim();
  try {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (titleEl) titleEl.value = '';
    await loadTasks();
  } catch (error) {
    showToast('Create failed: ' + (error && error.message ? error.message : error));
  }
}

async function updateTaskStatus(id, status) {
  try {
    const response = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadTasks();
  } catch (error) {
    showToast('Update failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteTaskById(id) {
  if (!await confirmToast('Delete this task?')) return;
  try {
    const response = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadTasks();
  } catch (error) {
    showToast('Delete failed: ' + (error && error.message ? error.message : error));
  }
}

// Live updates: when the WebSocket pushes a task event, refresh the board if visible.
(function attachTasksWebSocket() {
  if (typeof WebSocket === 'undefined') return;
  let ws = null;
  let reconnectTimer = null;
  function connect() {
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws');
      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!message) return;
          // Server may batch events into `event_batch` when WS coalescing
          // is on. Fan out to the same per-event handler so downstream
          // logic stays unchanged.
          if (message.type === 'event_batch' && Array.isArray(message.events)) {
            for (const inner of message.events) {
              if (inner && inner.type === 'event' && inner.event) handleHarnessEvent(inner.event);
            }
            return;
          }
          if (message.type !== 'event' || !message.event) return;
          handleHarnessEvent(message.event);
        } catch(e){ /* ignore parse errors */ }
      });
      function handleHarnessEvent(harnessEvent) {
        const category = harnessEvent.category;
        const type = harnessEvent.type;
        if (category === 'task') {
          const view = document.getElementById('tasksView');
          if (view && view.style.display === 'block') loadTasks();
        } else if (category === 'tool' || category === 'permission') {
          const view = document.getElementById('auditView');
          if (view && view.style.display === 'block') loadAudit();
        } else if (category === 'notification' && type === 'trigger.message') {
          const view = document.getElementById('triggersView');
          if (view && view.style.display === 'block') loadTriggers();
        } else if (category === 'system' && (type === 'subagent.start' || type === 'subagent.end' || type === 'subagent.cancel')) {
          // Live refresh of the active sub-agents bar above the chat input.
          loadActiveSubagentsBar();
        }
      }
      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', () => { try { ws && ws.close(); } catch(e){} });
    } catch(e){
      scheduleReconnect();
    }
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect);
  else connect();
})();

// Local UI state for the audit tab — persists across re-renders within
// a session but not across page reloads (it's a quick-look filter).
const auditFilterState = { eventType: '', tool: '' };

async function loadAudit() {
  const view = document.getElementById('auditView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading audit log…</div>';
  try {
    const response = await fetch('/api/permissions/audit?limit=500');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const allEntries = Array.isArray(data.entries) ? data.entries.slice().reverse() : [];
    if (allEntries.length === 0) {
      view.innerHTML = '<div class="tools-summary-line"><strong>0</strong> audit entries — every tool call is appended to .harness/audit.log.</div>';
      return;
    }
    const eventTypes = Array.from(new Set(allEntries.map((entry) => entry.eventType))).sort();
    const tools = Array.from(new Set(allEntries.map((entry) => entry.tool || '(none)'))).sort();
    const filtered = allEntries.filter((entry) => {
      if (auditFilterState.eventType && entry.eventType !== auditFilterState.eventType) return false;
      if (auditFilterState.tool && (entry.tool || '(none)') !== auditFilterState.tool) return false;
      return true;
    });
    const eventChips = ['<span class="trace-meta" style="margin-right:6px">Event:</span>',
      '<button class="btn-sm" onclick="setAuditFilter(\'eventType\',\'\')"' + (auditFilterState.eventType === '' ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>all</button>',
      ...eventTypes.map((t) => '<button class="btn-sm" onclick="setAuditFilter(\'eventType\',\'' + esc(t) + '\')"' + (auditFilterState.eventType === t ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>' + esc(t) + '</button>'),
    ].join(' ');
    const toolChips = ['<span class="trace-meta" style="margin:0 6px 0 12px">Tool:</span>',
      '<button class="btn-sm" onclick="setAuditFilter(\'tool\',\'\')"' + (auditFilterState.tool === '' ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>all</button>',
      ...tools.map((t) => '<button class="btn-sm" onclick="setAuditFilter(\'tool\',\'' + esc(t) + '\')"' + (auditFilterState.tool === t ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '>' + esc(t) + '</button>'),
    ].join(' ');
    const summary = '<div class="tools-summary-line"><strong>' + filtered.length + '</strong> of <strong>' + allEntries.length + '</strong> entries shown</div><div class="settings-collapse-actions" style="flex-wrap:wrap;justify-content:flex-start;gap:4px">' + eventChips + toolChips + '</div>';
    const rows = filtered.map((entry) => {
      const eventClass = entry.eventType === 'PostToolUseFailure' ? 'error'
        : entry.eventType === 'PreToolUse' ? 'accent'
        : '';
      const inputBlock = entry.input ? '<div class="trace-meta">Input: ' + esc(String(entry.input).slice(0, 400)) + '</div>' : '';
      const outputBlock = entry.output ? '<div class="trace-meta">Output: ' + esc(String(entry.output).slice(0, 400)) + '</div>' : '';
      const errorBlock = entry.error ? '<div class="trace-meta" style="color:var(--error)">Error: ' + esc(entry.error) + '</div>' : '';
      const toolName = entry.tool || '(no tool)';
      const drillButton = entry.tool ? ' <button class="btn-sm" onclick="setAuditFilter(\'tool\',\'' + esc(entry.tool) + '\')">drill</button>' : '';
      return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name ' + eventClass + '">' + esc(entry.eventType) + ' · ' + esc(toolName) + '</div><div class="skill-card-meta">' + esc(entry.timestamp) + '</div></div><div class="skill-card-actions-right">' + drillButton + '</div></div>' + inputBlock + outputBlock + errorBlock + '</div>';
    }).join('');
    view.innerHTML = summary + '<div class="skills-gallery">' + (rows || '<div class="trace-meta">No entries match the current filter.</div>') + '</div>';
  } catch (error) {
    view.textContent = 'Failed to load audit log: ' + (error && error.message ? error.message : error);
  }
}

function setAuditFilter(field, value) {
  auditFilterState[field] = value;
  loadAudit();
}

async function loadTriggers() {
  const view = document.getElementById('triggersView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading triggers…</div>';
  try {
    const response = await fetch('/api/triggers');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const triggers = Array.isArray(data.triggers) ? data.triggers : [];
    const enabled = data.enabled === true;
    const status = '<div class="tools-summary-line">Trigger scheduler: <strong>' + (enabled ? 'enabled' : 'disabled') + '</strong> · ' + triggers.length + ' trigger(s) configured</div>';
    const newForm = '<div class="automation-wizard"><div class="automation-wizard-title">New trigger</div><div class="automation-field"><label for="newTriggerId">Id</label><input id="newTriggerId" type="text" placeholder="email-poll" /></div><div class="automation-field"><label for="newTriggerCommand">Command</label><input id="newTriggerCommand" type="text" placeholder="node" /></div><div class="automation-field"><label for="newTriggerArgs">Args (space-separated)</label><input id="newTriggerArgs" type="text" placeholder="scripts/check-email.js" /></div><div class="automation-field"><label for="newTriggerInterval">Interval (seconds, min 5)</label><input id="newTriggerInterval" type="number" value="30" min="5" /></div><div class="settings-collapse-actions"><button class="btn-sm" onclick="createTriggerFromForm()">+ Create</button></div></div>';
    const rows = triggers.map((trigger) => {
      const meta = [
        'every ' + trigger.intervalSeconds + 's',
        trigger.enabled === false ? 'disabled' : 'enabled',
      ].join(' · ');
      const cmdLine = esc(trigger.command) + (Array.isArray(trigger.args) && trigger.args.length ? ' ' + esc(trigger.args.join(' ')) : '');
      const toggleLabel = trigger.enabled === false ? 'Enable' : 'Disable';
      const toggleVal = trigger.enabled === false ? 'true' : 'false';
      return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(trigger.id) + '</div><div class="skill-card-meta">' + meta + '</div><div class="skill-card-meta"><code>' + cmdLine + '</code></div></div><div class="skill-card-actions-right"><button class="btn-sm" onclick="setTriggerEnabled(\'' + esc(trigger.id) + '\', ' + toggleVal + ')">' + toggleLabel + '</button> <button class="sk-del" onclick="deleteTriggerById(\'' + esc(trigger.id) + '\')" title="Delete trigger">✕</button></div></div></div>';
    }).join('');
    view.innerHTML = status + newForm + (rows ? '<div class="skills-gallery">' + rows + '</div>' : '<div class="trace-meta">No triggers yet — create one above.</div>');
  } catch (error) {
    view.textContent = 'Failed to load triggers: ' + (error && error.message ? error.message : error);
  }
}

async function createTriggerFromForm() {
  const idEl = document.getElementById('newTriggerId');
  const commandEl = document.getElementById('newTriggerCommand');
  const argsEl = document.getElementById('newTriggerArgs');
  const intervalEl = document.getElementById('newTriggerInterval');
  const id = idEl ? idEl.value.trim() : '';
  const command = commandEl ? commandEl.value.trim() : '';
  if (!id || !command) { showToast('id and command are required.'); return; }
  const args = argsEl && argsEl.value.trim() ? argsEl.value.trim().split(/\s+/) : [];
  const intervalSeconds = intervalEl ? Math.max(5, Number(intervalEl.value) || 30) : 30;
  try {
    const response = await fetch('/api/triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, command, args, intervalSeconds, enabled: true }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (idEl) idEl.value = '';
    if (commandEl) commandEl.value = '';
    if (argsEl) argsEl.value = '';
    await loadTriggers();
  } catch (error) {
    showToast('Create failed: ' + (error && error.message ? error.message : error));
  }
}

async function setTriggerEnabled(id, enabled) {
  try {
    const response = await fetch('/api/triggers/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadTriggers();
  } catch (error) {
    showToast('Update failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteTriggerById(id) {
  if (!await confirmToast('Delete trigger ' + id + '?')) return;
  try {
    const response = await fetch('/api/triggers/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadTriggers();
  } catch (error) {
    showToast('Delete failed: ' + (error && error.message ? error.message : error));
  }
}

async function loadAgents() {
  const view = document.getElementById('agentsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading agents…</div>';
  try {
    const response = await fetch('/api/agents');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const summary = '<div class="tools-summary-line"><strong>' + agents.length + '</strong> agents (built-in + custom under .harness/agents/)</div>';
    const newForm = '<div class="automation-wizard"><div class="automation-wizard-title">New custom agent</div><div class="automation-field"><label for="newAgentId">Id <span class="automation-field-hint">(auto from name if blank)</span></label><input id="newAgentId" type="text" placeholder="finance-analyst" /></div><div class="automation-field"><label for="newAgentName">Name</label><input id="newAgentName" type="text" placeholder="Finance Analyst" /></div><div class="automation-field"><label for="newAgentDescription">Description</label><input id="newAgentDescription" type="text" placeholder="Reviews ledgers and budgets." /></div><div class="automation-field"><label for="newAgentPreset">Preset (optional)</label><input id="newAgentPreset" type="text" placeholder="explore | plan | review | summarize | general" /></div><div class="automation-field"><label for="newAgentSystemPrompt">System prompt</label><textarea id="newAgentSystemPrompt" rows="4" placeholder="You are a Finance Analyst..."></textarea></div><div class="settings-collapse-actions"><button class="btn-sm" onclick="createAgentFromForm()">+ Create</button></div></div>';
    const rows = agents.map((agent) => {
      const sourceBadge = agent.source === 'custom' ? 'custom' : 'built-in';
      const meta = [
        sourceBadge,
        agent.role ? esc(agent.role) : null,
        agent.preset ? 'preset: ' + esc(agent.preset) : null,
      ].filter(Boolean).join(' · ');
      const allowed = Array.isArray(agent.allowedTools) && agent.allowedTools.length > 0
        ? '<div class="skill-card-meta">tools: ' + esc(agent.allowedTools.slice(0, 6).join(', ')) + (agent.allowedTools.length > 6 ? '…' : '') + '</div>' : '';
      const description = agent.description ? '<div class="skill-card-desc">' + esc(agent.description) + '</div>' : '';
      const safeId = esc(agent.id);
      const runBtn = '<button class="btn-sm" data-requires-model="1" onclick="toggleAgentRunPanel(\'' + safeId + '\')" title="Run this agent">▶ Run</button>';
      const delBtn = agent.source === 'custom' ? '<button class="sk-del" onclick="deleteAgentById(\'' + safeId + '\')" title="Delete custom agent">✕</button>' : '';
      const actions = runBtn + delBtn;
      const runPanel = '<div id="agentRunPanel-' + safeId + '" class="automation-wizard" style="display:none;margin-top:8px;">'
        + '<div class="automation-field"><label for="agentRunPrompt-' + safeId + '">Prompt for ' + esc(agent.name) + '</label>'
        + '<textarea id="agentRunPrompt-' + safeId + '" rows="3" placeholder="What should this agent do?"></textarea></div>'
        + '<div class="settings-collapse-actions">'
        + '<button class="btn-sm primary" onclick="runAgentFromPanel(\'' + safeId + '\')">Run</button>'
        + '<button class="btn-sm" onclick="toggleAgentRunPanel(\'' + safeId + '\')">Close</button>'
        + '</div>'
        + '<div id="agentRunResult-' + safeId + '" class="trace-meta" style="margin-top:8px;"></div>'
        + '</div>';
      return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(agent.name) + '</div><div class="skill-card-meta">' + meta + '</div></div><div class="skill-card-actions-right">' + actions + '</div></div>' + description + allowed + runPanel + '</div>';
    }).join('');
    view.innerHTML = summary + newForm + '<div class="skills-gallery">' + rows + '</div>';
    applyModelGate();
  } catch (error) {
    view.textContent = 'Failed to load agents: ' + (error && error.message ? error.message : error);
  }
}

function slugifyAgentId(value) {
  if (typeof value !== 'string') return '';
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : '';
}

async function createAgentFromForm() {
  const fields = ['newAgentId', 'newAgentName', 'newAgentDescription', 'newAgentPreset', 'newAgentSystemPrompt'].map((id) => document.getElementById(id));
  const [idEl, nameEl, descEl, presetEl, promptEl] = fields;
  const rawId = idEl ? idEl.value.trim() : '';
  const name = nameEl ? nameEl.value.trim() : '';
  const systemPrompt = promptEl ? promptEl.value.trim() : '';
  if (!name || !systemPrompt) { showToast('name and system prompt are required.'); return; }
  // Auto-derive id from the name when the user leaves Id blank or types
  // characters the server would reject (spaces, punctuation, etc).
  const idValidator = /^[a-z0-9][a-z0-9-_]*$/i;
  let id = rawId;
  if (!id || !idValidator.test(id)) id = slugifyAgentId(rawId || name);
  if (!id) { showToast('Could not derive an id from the name. Use letters/digits.'); return; }
  if (idEl && id !== rawId) idEl.value = id;
  const body = {
    id,
    name,
    description: descEl ? descEl.value.trim() : '',
    preset: presetEl && presetEl.value.trim() ? presetEl.value.trim() : undefined,
    systemPrompt,
  };
  try {
    const response = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    fields.forEach((field) => { if (field) field.value = ''; });
    await loadAgents();
  } catch (error) {
    showToast('Create failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteAgentById(id) {
  if (!await confirmToast('Delete custom agent ' + id + '?')) return;
  try {
    const response = await fetch('/api/agents/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadAgents();
  } catch (error) {
    showToast('Delete failed: ' + (error && error.message ? error.message : error));
  }
}

function toggleAgentRunPanel(id) {
  const panel = document.getElementById('agentRunPanel-' + id);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) {
    const input = document.getElementById('agentRunPrompt-' + id);
    if (input) input.focus();
  }
}

async function runAgentFromPanel(id) {
  const promptEl = document.getElementById('agentRunPrompt-' + id);
  const resultEl = document.getElementById('agentRunResult-' + id);
  if (!promptEl || !resultEl) return;
  const prompt = promptEl.value.trim();
  if (!prompt) { resultEl.textContent = 'Enter a prompt first.'; return; }
  const sel = document.getElementById('modelSelect');
  if (!sel || !sel.value) {
    resultEl.textContent = 'Pick a model in the top bar before running an agent.';
    return;
  }
  resultEl.textContent = 'Running ' + id + '… (cancel from the sub-agents bar at the top of Chat)';
  try {
    const response = await fetch('/api/agents/' + encodeURIComponent(id) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    // Render the summary as preformatted text so structure survives.
    resultEl.innerHTML = '<div style="font-weight:600;margin-bottom:4px;">Summary</div>'
      + '<pre style="white-space:pre-wrap;margin:0;">' + esc(data.summary || '(empty summary)') + '</pre>';
  } catch (error) {
    resultEl.textContent = 'Run failed: ' + (error && error.message ? error.message : error);
  }
}

async function loadSquads() {
  const view = document.getElementById('squadsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading squads…</div>';
  try {
    const response = await fetch('/api/squads');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const squads = Array.isArray(data.squads) ? data.squads : [];
    const summary = '<div class="tools-summary-line"><strong>' + squads.length + '</strong> squad(s) configured</div>';
    const newForm = '<div class="automation-wizard"><div class="automation-wizard-title">New squad</div><div class="automation-field"><label for="newSquadId">Id <span class="automation-field-hint">(auto from name if blank)</span></label><input id="newSquadId" type="text" placeholder="eng" /></div><div class="automation-field"><label for="newSquadName">Name</label><input id="newSquadName" type="text" placeholder="Engineering" /></div><div class="automation-field"><label for="newSquadLead">Lead agent id</label><input id="newSquadLead" type="text" placeholder="architect" /></div><div class="automation-field"><label for="newSquadAutonomy">Autonomy</label><input id="newSquadAutonomy" type="text" value="supervised" placeholder="supervised | semi-autonomous | autonomous" /></div><div class="settings-collapse-actions"><button class="btn-sm" onclick="createSquadFromForm()">+ Create</button></div></div>';
    const rows = squads.map((squad) => {
      const meta = [
        'lead: ' + esc(squad.leadAgentId || '?'),
        esc(squad.autonomy || 'supervised'),
        squad.roster && squad.roster.length ? squad.roster.length + ' on roster' : null,
      ].filter(Boolean).join(' · ');
      const desc = squad.description ? '<div class="skill-card-desc">' + esc(squad.description) + '</div>' : '';
      const rules = Array.isArray(squad.routingRules) ? squad.routingRules : [];
      const rulesRows = rules.length === 0
        ? '<div class="trace-meta" style="margin-top:6px">No routing rules — every message falls back to lead agent.</div>'
        : '<div class="trace-meta" style="margin-top:6px"><strong>' + rules.length + ' routing rule(s)</strong> (highest priority wins):</div>'
          + rules.map((rule, idx) => '<div class="settings-collapse-actions" style="justify-content:flex-start;gap:6px;margin-top:4px"><code style="flex:1;background:var(--surface3);padding:3px 6px;border-radius:4px;font-size:11px">/' + esc(rule.pattern) + '/i</code> → <strong>' + esc(rule.agentId) + '</strong> <span class="trace-meta">(p=' + (rule.priority || 0) + ')</span> <button class="sk-del" onclick="deleteSquadRule(\'' + esc(squad.id) + '\',' + idx + ')" title="Delete rule">✕</button></div>').join('');
      const ruleForm = '<div class="settings-collapse-actions" style="gap:4px;margin-top:8px;flex-wrap:wrap"><input id="newRulePattern_' + esc(squad.id) + '" type="text" placeholder="regex pattern" style="flex:2;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;font-family:monospace" /><input id="newRuleAgent_' + esc(squad.id) + '" type="text" placeholder="agent id" style="flex:1;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px" /><input id="newRulePriority_' + esc(squad.id) + '" type="number" placeholder="priority" value="10" style="width:70px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px" /><button class="btn-sm" onclick="addSquadRule(\'' + esc(squad.id) + '\')">+ Rule</button></div>';
      return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(squad.name) + '</div><div class="skill-card-meta">' + meta + '</div></div><div class="skill-card-actions-right"><button class="sk-del" onclick="deleteSquadById(\'' + esc(squad.id) + '\')" title="Delete squad">✕</button></div></div>' + desc + rulesRows + ruleForm + '</div>';
    }).join('');
    view.innerHTML = summary + newForm + (rows ? '<div class="skills-gallery">' + rows + '</div>' : '<div class="trace-meta">No squads yet — create one above.</div>');
  } catch (error) {
    view.textContent = 'Failed to load squads: ' + (error && error.message ? error.message : error);
  }
}

async function createSquadFromForm() {
  const fields = ['newSquadId', 'newSquadName', 'newSquadLead', 'newSquadAutonomy'].map((id) => document.getElementById(id));
  const [idEl, nameEl, leadEl, autonomyEl] = fields;
  const rawId = idEl ? idEl.value.trim() : '';
  const name = nameEl ? nameEl.value.trim() : '';
  const leadAgentId = leadEl ? leadEl.value.trim() : '';
  if (!name || !leadAgentId) { showToast('name and lead agent id are required.'); return; }
  // Same shape as createAgentFromForm: server requires a slug-safe id, so
  // auto-derive one from the name when the user leaves Id blank or types
  // characters the server would reject.
  let id = rawId;
  if (!id || !slugifyAgentId(id)) id = slugifyAgentId(rawId || name);
  if (!id) { showToast('Could not derive an id from the name. Use letters/digits.'); return; }
  if (idEl && id !== rawId) idEl.value = id;
  const body = { id, name, leadAgentId, autonomy: autonomyEl && autonomyEl.value.trim() ? autonomyEl.value.trim() : 'supervised' };
  try {
    const response = await fetch('/api/squads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    fields.forEach((field) => { if (field) field.value = field === autonomyEl ? 'supervised' : ''; });
    await loadSquads();
  } catch (error) {
    showToast('Create failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteSquadById(id) {
  if (!await confirmToast('Delete squad ' + id + '?')) return;
  try {
    const response = await fetch('/api/squads/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadSquads();
  } catch (error) {
    showToast('Delete failed: ' + (error && error.message ? error.message : error));
  }
}

async function addSquadRule(squadId) {
  const patternEl = document.getElementById('newRulePattern_' + squadId);
  const agentEl = document.getElementById('newRuleAgent_' + squadId);
  const priorityEl = document.getElementById('newRulePriority_' + squadId);
  const pattern = patternEl ? patternEl.value.trim() : '';
  const agentId = agentEl ? agentEl.value.trim() : '';
  if (!pattern || !agentId) { showToast('pattern and agent id are required.'); return; }
  // Validate regex client-side so the user sees immediate feedback.
  try { new RegExp(pattern); } catch (error) { showToast('Invalid regex: ' + (error && error.message ? error.message : error)); return; }
  const priority = priorityEl ? Math.floor(Number(priorityEl.value) || 0) : 0;
  try {
    const current = await fetch('/api/squads/' + encodeURIComponent(squadId)).then((r) => r.json());
    if (current.error || !current.squad) throw new Error(current.error || 'Squad not found');
    const routingRules = Array.isArray(current.squad.routingRules) ? current.squad.routingRules.slice() : [];
    routingRules.push({ pattern, agentId, priority });
    const response = await fetch('/api/squads/' + encodeURIComponent(squadId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routingRules }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (patternEl) patternEl.value = '';
    if (agentEl) agentEl.value = '';
    await loadSquads();
  } catch (error) {
    showToast('Add rule failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteSquadRule(squadId, index) {
  try {
    const current = await fetch('/api/squads/' + encodeURIComponent(squadId)).then((r) => r.json());
    if (current.error || !current.squad) throw new Error(current.error || 'Squad not found');
    const routingRules = Array.isArray(current.squad.routingRules) ? current.squad.routingRules.slice() : [];
    if (index < 0 || index >= routingRules.length) return;
    routingRules.splice(index, 1);
    const response = await fetch('/api/squads/' + encodeURIComponent(squadId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routingRules }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadSquads();
  } catch (error) {
    showToast('Delete rule failed: ' + (error && error.message ? error.message : error));
  }
}

async function loadIdentity() {
  const view = document.getElementById('identityView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading identity…</div>';
  try {
    const response = await fetch('/api/identity');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const soul = (data && typeof data.soul === 'string') ? data.soul : '';
    const user = (data && typeof data.user === 'string') ? data.user : '';
    const entries = (data && data.structured && Array.isArray(data.structured.entries)) ? data.structured.entries : [];
    const summary = '<div class="tools-summary-line">Identity files persisted under <strong>.harness/identity/</strong></div>';
    const soulPanel = '<div class="mem-section"><h5>SOUL.md <button class="mem-edit-btn" onclick="saveIdentityFile(\'SOUL.md\')">Save</button></h5><textarea id="identitySoulText" rows="8" style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:\'Cascadia Code\',\'Fira Code\',monospace;font-size:12px">' + esc(soul) + '</textarea></div>';
    const userPanel = '<div class="mem-section"><h5>USER.md <button class="mem-edit-btn" onclick="saveIdentityFile(\'USER.md\')">Save</button></h5><textarea id="identityUserText" rows="8" style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:\'Cascadia Code\',\'Fira Code\',monospace;font-size:12px">' + esc(user) + '</textarea></div>';
    const newEntryForm = '<div class="automation-wizard"><div class="automation-wizard-title">New structured fact</div><div class="automation-field"><label for="newIdentityCategory">Category</label><input id="newIdentityCategory" type="text" placeholder="preference | project | person" /></div><div class="automation-field"><label for="newIdentitySummary">Summary</label><input id="newIdentitySummary" type="text" placeholder="Prefers concise answers" /></div><div class="settings-collapse-actions"><button class="btn-sm" onclick="addIdentityEntry()">+ Add</button></div></div>';
    const entryRows = entries.map((entry) => {
      return '<div class="skill-card"><div class="skill-card-top"><div><div class="skill-card-name">' + esc(entry.category) + '</div><div class="skill-card-meta">' + esc(entry.summary) + '</div></div><div class="skill-card-actions-right"><button class="sk-del" onclick="deleteIdentityEntry(\'' + esc(entry.id) + '\')" title="Delete entry">✕</button></div></div></div>';
    }).join('');
    const entriesPanel = '<div class="mem-section"><h5>structured.json (' + entries.length + ' entries)</h5>' + newEntryForm + (entryRows ? '<div class="skills-gallery">' + entryRows + '</div>' : '<div class="trace-meta">No structured facts yet.</div>') + '</div>';
    const autoUpdatePanel = '<div class="mem-section" id="identityAutoUpdatePanel"><h5>Adaptive identity</h5><div class="trace-meta">Loading…</div></div>';
    view.innerHTML = summary + soulPanel + userPanel + entriesPanel + autoUpdatePanel;
    // Fire-and-forget — failures render inline, never block the main panel.
    refreshIdentityAutoUpdatePanel();
  } catch (error) {
    view.textContent = 'Failed to load identity: ' + (error && error.message ? error.message : error);
  }
}

async function saveIdentityFile(fileName) {
  const textareaId = fileName === 'SOUL.md' ? 'identitySoulText' : 'identityUserText';
  const el = document.getElementById(textareaId);
  if (!el) return;
  try {
    const response = await fetch('/api/identity/' + encodeURIComponent(fileName), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: el.value }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
  } catch (error) {
    showToast('Save failed: ' + (error && error.message ? error.message : error));
  }
}

async function addIdentityEntry() {
  const categoryEl = document.getElementById('newIdentityCategory');
  const summaryEl = document.getElementById('newIdentitySummary');
  const category = categoryEl ? categoryEl.value.trim() : '';
  const summary = summaryEl ? summaryEl.value.trim() : '';
  if (!category || !summary) { showToast('category and summary are required.'); return; }
  try {
    const response = await fetch('/api/identity/structured', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, summary }) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (categoryEl) categoryEl.value = '';
    if (summaryEl) summaryEl.value = '';
    await loadIdentity();
  } catch (error) {
    showToast('Add failed: ' + (error && error.message ? error.message : error));
  }
}

async function deleteIdentityEntry(id) {
  if (!await confirmToast('Delete entry ' + id + '?')) return;
  try {
    const response = await fetch('/api/identity/structured/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadIdentity();
  } catch (error) {
    showToast('Delete failed: ' + (error && error.message ? error.message : error));
  }
}

// ─── Artifacts browser ─────────────────────────────────────────────
// Cross-session view of every file the agent has written into
// agent-outputs/ (or the configured Agent Files directory). Auto-tagged
// by file extension so users can filter quickly without an LLM.
let _artifactsState = { category: '', search: '' };
async function loadArtifacts() {
  const view = document.getElementById('artifactsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading artifacts…</div>';
  try {
    const params = new URLSearchParams();
    if (_artifactsState.category) params.set('category', _artifactsState.category);
    if (_artifactsState.search) params.set('search', _artifactsState.search);
    const queryString = params.toString();
    const artifactsUrl = queryString ? '/api/artifacts?' + queryString : '/api/artifacts';
    const response = await fetch(artifactsUrl);
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const root = data.root || '';
    const records = Array.isArray(data.artifacts) ? data.artifacts : [];
    const categories = ['', 'code', 'document', 'data', 'image', 'web', 'script', 'archive', 'other'];
    const catOptions = categories.map((cat) => '<option value="' + esc(cat) + '"' + (_artifactsState.category === cat ? ' selected' : '') + '>' + (cat || 'all categories') + '</option>').join('');
    const header = '<div class="tools-summary-line"><strong>' + records.length + '</strong> artifact(s) under <code>' + esc(root) + '</code></div>'
      + '<div style="display:flex;gap:8px;align-items:center;margin:8px 0">'
      + '<input type="search" id="artifactsSearchInput" placeholder="Search filename…" value="' + esc(_artifactsState.search) + '" style="flex:1;padding:4px 8px" />'
      + '<select id="artifactsCategorySelect" style="padding:4px 8px">' + catOptions + '</select>'
      + '<button class="btn-secondary" onclick="loadArtifacts()" style="padding:4px 10px">Refresh</button>'
      + '</div>';
    if (records.length === 0) {
      view.innerHTML = header + '<div class="trace-meta">No artifacts yet — files written by the agent will appear here.</div>';
      bindArtifactControls();
      return;
    }
    const rows = records.map((record) => {
      const sizeKb = record.size >= 1024 ? (record.size / 1024).toFixed(1) + ' KB' : record.size + ' B';
      const dateLabel = record.modifiedAt ? record.modifiedAt.replace('T', ' ').slice(0, 19) : '';
      const tagPills = (record.tags || []).slice(0, 5).map((tag) => '<span class="trace-tag" style="font-size:10px;padding:1px 6px;margin-right:4px;border-radius:8px;background:var(--surface2);color:var(--text-dim)">' + esc(tag) + '</span>').join('');
      return '<div class="trace-row" style="padding:6px 8px;border-bottom:1px solid var(--border)">'
        + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">'
        + '<a href="#" onclick="openArtifactPreview(\'' + esc(record.relativePath).replace(/'/g, "\\'") + '\');return false" style="font-weight:600;color:var(--accent);text-decoration:none">' + esc(record.relativePath) + '</a>'
        + '<span class="trace-meta" style="font-size:11px;white-space:nowrap">' + esc(sizeKb) + ' · ' + esc(dateLabel) + '</span>'
        + '</div>'
        + '<div style="margin-top:2px">' + tagPills + '</div>'
        + '</div>';
    }).join('');
    view.innerHTML = header + '<div class="trace-list">' + rows + '</div><div id="artifactPreview"></div>';
    bindArtifactControls();
  } catch (error) {
    view.textContent = 'Failed to load artifacts: ' + (error && error.message ? error.message : error);
  }
}

function bindArtifactControls() {
  const search = document.getElementById('artifactsSearchInput');
  if (search) {
    search.oninput = (e) => {
      _artifactsState.search = e.target.value || '';
      // debounce via timeout
      clearTimeout(window._artifactsSearchTimer);
      window._artifactsSearchTimer = setTimeout(() => loadArtifacts(), 250);
    };
  }
  const catSel = document.getElementById('artifactsCategorySelect');
  if (catSel) {
    catSel.onchange = (e) => {
      _artifactsState.category = e.target.value || '';
      loadArtifacts();
    };
  }
}

async function openArtifactPreview(relativePath) {
  const host = document.getElementById('artifactPreview');
  if (!host) return;
  host.innerHTML = '<div class="trace-meta">Loading preview of ' + esc(relativePath) + '…</div>';
  try {
    const response = await fetch('/api/artifacts/content?path=' + encodeURIComponent(relativePath));
    const data = await response.json();
    if (data.error) { host.textContent = data.error; return; }
    const truncatedNote = data.truncated ? ' (truncated to first 256 KB)' : '';
    host.innerHTML = '<div class="trace-section" style="margin-top:12px"><div class="tools-summary-line"><strong>' + esc(relativePath) + '</strong> · ' + data.size + ' bytes' + truncatedNote + '</div>'
      + '<pre style="white-space:pre-wrap;background:var(--surface2);padding:8px;border-radius:4px;max-height:480px;overflow:auto">' + esc(data.content) + '</pre></div>';
  } catch (error) {
    host.textContent = 'Preview failed: ' + (error && error.message ? error.message : error);
  }
}

async function loadHealth() {
  const view = document.getElementById('healthView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading system health…</div>';
  try {
    const response = await fetch('/api/system/health');
    const data = await response.json();
    if (data.error) { view.textContent = data.error; return; }
    const killBadge = data.kill_switch && data.kill_switch.active
      ? '<span style="color:var(--error);font-weight:600">KILL SWITCH ACTIVE</span> — ' + esc(data.kill_switch.reason || '')
      : '<span style="color:var(--success)">kill switch off</span>';
    const taskSummary = data.tasks ? Object.entries(data.tasks).filter(([key]) => key !== 'total').map(([key, val]) => esc(key) + ': ' + val).join(' · ') : '';
    const summaryLine = '<div class="tools-summary-line">' + killBadge + ' · capability grants: <strong>' + (data.capabilities ? data.capabilities.active_grants : 0) + '</strong> active / ' + (data.capabilities ? data.capabilities.total_grants : 0) + ' total · squads: <strong>' + (data.squads ? data.squads.total : 0) + '</strong> · tasks: <strong>' + (data.tasks ? data.tasks.total : 0) + '</strong>' + (taskSummary ? ' (' + taskSummary + ')' : '') + '</div>';
    function flagToggle(label, key, enabled) {
      const stateLabel = enabled ? 'ON' : 'OFF';
      const colour = enabled ? 'var(--accent)' : 'var(--text-dim)';
      return '<div class="settings-collapse-actions" style="justify-content:space-between;gap:8px;margin-top:6px"><span style="color:' + colour + ';font-weight:600">' + esc(label) + ' — ' + stateLabel + '</span><div><button class="btn-sm" onclick="setHealthFlag(\'' + esc(key) + '\', true)">enable</button> <button class="btn-sm" onclick="setHealthFlag(\'' + esc(key) + '\', false)">disable</button> <button class="btn-sm" onclick="setHealthFlag(\'' + esc(key) + '\', null)">env</button></div></div>';
    }
    const flagsPanel = '<div class="mem-section"><h5>Feature flags (override env defaults)</h5>'
      + flagToggle('Heartbeat', 'heartbeatEnabled', data.heartbeat && data.heartbeat.enabled)
      + flagToggle('Triggers', 'triggersEnabled', data.triggers && data.triggers.enabled)
      + flagToggle('Concierge', 'conciergeEnabled', data.concierge && data.concierge.enabled)
      + flagToggle('Concierge auto-route', 'conciergeAutoRoute', data.concierge && data.concierge.auto_route)
      + flagToggle('Squad auto-route', 'squadAutoRoute', data.squads && data.squads.auto_route)
      + flagToggle('OTLP trace export', 'otelExportEnabled', data.observability && data.observability.otel_export_enabled)
      + '</div>';
    const lastHb = data.heartbeat && data.heartbeat.last_run_summary;
    const lastHbBlock = lastHb ? '<div class="trace-meta" style="margin-top:6px">Last tick: ' + esc(lastHb.timestamp) + ' (' + lastHb.durationMs + ' ms; ' + lastHb.actions.length + ' action(s))</div>' : '<div class="trace-meta" style="margin-top:6px">No ticks recorded yet.</div>';
    const recentRows = data.heartbeat && Array.isArray(data.heartbeat.recent_runs)
      ? data.heartbeat.recent_runs.slice(-10).reverse().map((run) => '<div class="trace-meta">• ' + esc(run.timestamp) + ' · ' + run.durationMs + ' ms · ' + run.actions.map((act) => (act.ok ? '✓' : '✕') + esc(act.name)).join(' · ') + '</div>').join('')
      : '';
    // Inline SVG sparkline: tick durations across the last N heartbeat
    // runs. Pure DOM, no library — renders inline so it scales with the
    // panel and stays empty when there's nothing yet.
    function buildHeartbeatSparkline(runs) {
      if (!runs || runs.length < 2) return '';
      const sample = runs.slice(-30).map((run) => Number(run.durationMs) || 0);
      const w = 240;
      const h = 36;
      const max = Math.max(...sample, 1);
      const stepX = w / Math.max(1, sample.length - 1);
      const points = sample.map((value, idx) => {
        const x = (idx * stepX).toFixed(1);
        const y = (h - (value / max) * (h - 4) - 2).toFixed(1);
        return x + ',' + y;
      }).join(' ');
      const lastValue = sample[sample.length - 1];
      const avg = Math.round(sample.reduce((sum, value) => sum + value, 0) / sample.length);
      return '<div style="margin-top:6px;display:flex;align-items:center;gap:8px">'
        + '<svg width="' + w + '" height="' + h + '" style="display:block">'
        + '<polyline fill="none" stroke="var(--accent,#6cf)" stroke-width="1.5" points="' + points + '"></polyline>'
        + '</svg>'
        + '<span class="trace-meta" style="font-size:11px">last ' + sample.length + ' ticks · avg ' + avg + ' ms · current ' + lastValue + ' ms</span>'
        + '</div>';
    }
    const sparkline = data.heartbeat && Array.isArray(data.heartbeat.recent_runs) ? buildHeartbeatSparkline(data.heartbeat.recent_runs) : '';
    const heartbeatPanel = '<div class="mem-section"><h5>Heartbeat (' + (data.heartbeat && data.heartbeat.running ? 'running' : 'stopped') + ')</h5>' + lastHbBlock + sparkline + recentRows + '</div>';
    const conciergeRows = data.concierge && Array.isArray(data.concierge.recent_decisions) && data.concierge.recent_decisions.length > 0
      ? data.concierge.recent_decisions.slice(-10).reverse().map((entry) => '<div class="trace-meta">• ' + esc(entry.timestamp) + ' · ' + (entry.delegateTo ? '→ ' + esc(entry.delegateTo) : 'direct') + ' · conf=' + (typeof entry.confidence === 'number' ? entry.confidence.toFixed(2) : '?') + (entry.autoRouted ? ' [auto]' : '') + ' · ' + esc(entry.messagePreview).slice(0, 80) + '</div>').join('')
      : '<div class="trace-meta">No concierge decisions recorded yet.</div>';
    const conciergePanel = '<div class="mem-section"><h5>Concierge decisions</h5>' + conciergeRows + '</div>';
    const otherPanel = '<div class="mem-section"><h5>Schedulers</h5><div class="trace-meta">Automation: ' + (data.automation && data.automation.running ? 'running' : 'stopped') + '</div><div class="trace-meta">Curator: ' + (data.curator && data.curator.running ? 'running' : 'stopped') + '</div></div>';
    // Inline diagnostic banners. Surface stale context-cap configs and
    // missing/installed vision models so users can spot misconfigurations
    // without digging through logs.
    function buildDiagnosticBanner(kind, message) {
      const colours = { warn: 'var(--warning,orange)', error: 'var(--danger,#e55)', info: 'var(--accent,#6cf)' };
      const colour = colours[kind] || colours.info;
      return '<div class="mem-section" style="border-left:3px solid ' + colour + ';padding:6px 10px;margin-top:8px"><div class="trace-meta">' + message + '</div></div>';
    }
    let diagnosticsHtml = '';
    if (data.context) {
      if (data.context.mode === 'auto' && data.context.auto_bumped && data.context.detected) {
        diagnosticsHtml += buildDiagnosticBanner('info', '⚙️ Context auto-detected as <strong>' + data.context.effective + '</strong> tokens for <code>' + esc(data.context.model) + '</code> (model exposes a ' + data.context.detected + '-token window). Set <em>Context max tokens</em> in Settings to a non-default value if you want to throttle.');
      } else if (data.context.mode === 'capped' && data.context.detected && data.context.configured > data.context.detected) {
        diagnosticsHtml += buildDiagnosticBanner('warn', '⚠️ Configured context cap (' + data.context.configured + ') exceeds the detected window for <code>' + esc(data.context.model) + '</code> (' + data.context.detected + '). Effective limit clamped to ' + data.context.effective + ' to avoid request rejection.');
      } else if (data.context.mode === 'capped' && data.context.detected) {
        diagnosticsHtml += buildDiagnosticBanner('info', '⚙️ Context capped at <strong>' + data.context.effective + '</strong> tokens by your settings. Model <code>' + esc(data.context.model) + '</code> can take up to ' + data.context.detected + '.');
      }
      // Per-model profile editor: lets the user set a model-specific
      // contextMaxTokens override without leaving System Health.
      if (data.context.model) {
        const profileCap = typeof data.context.profile_cap === 'number' ? data.context.profile_cap : '';
        const profileNote = data.context.profile_cap !== undefined
          ? '<span class="trace-meta">Per-model profile cap is set to <strong>' + data.context.profile_cap + '</strong> (overrides global).</span>'
          : '<span class="trace-meta">No per-model profile set; using global cap.</span>';
        diagnosticsHtml += '<div class="mem-section" style="border-left:3px solid var(--accent,#6cf);padding:6px 10px;margin-top:8px">'
          + '<div class="trace-meta">🎛 Per-model profile for <code>' + esc(data.context.model) + '</code></div>'
          + '<div class="settings-collapse-actions" style="gap:8px;margin-top:6px;align-items:center">'
          + '<input type="number" id="modelProfileCapInput" min="0" placeholder="0 = auto" value="' + esc(String(profileCap)) + '" style="width:120px">'
          + '<button class="btn-sm" onclick="saveModelProfileCap()">save cap</button>'
          + '<button class="btn-sm" onclick="clearModelProfileCap()">clear</button>'
          + '</div>'
          + '<div style="margin-top:6px">' + profileNote + '</div>'
          + '</div>';
      }
    }
    if (data.vision) {
      const visionStatus = data.vision.ok ? 'ready' : 'broken';
      const visionColour = data.vision.ok ? 'info' : 'error';
      const installedNote = data.vision.installed && data.vision.installed.length > 0 ? ' Installed: ' + data.vision.installed.map(esc).join(', ') + '.' : ' No vision-capable models installed.';
      const reasonNote = data.vision.reason ? ' ' + esc(data.vision.reason) : '';
      diagnosticsHtml += buildDiagnosticBanner(visionColour, '🎨 Vision model: <strong>' + esc(data.vision.effective || '(none)') + '</strong> (' + visionStatus + '). Configured: <code>' + esc(data.vision.configured || '(unset)') + '</code>.' + installedNote + reasonNote);
    }
    view.innerHTML = summaryLine + diagnosticsHtml + flagsPanel + heartbeatPanel + conciergePanel + otherPanel;
  } catch (error) {
    view.textContent = 'Failed to load health: ' + (error && error.message ? error.message : error);
  }
}

async function setHealthFlag(key, enabled) {
  try {
    const body = {};
    body[key] = enabled;
    const response = await fetch('/api/system/feature-flags', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadHealth();
  } catch (error) {
    showToast('Update failed: ' + (error && error.message ? error.message : error));
  }
}

async function saveModelProfileCap() {
  const input = document.getElementById('modelProfileCapInput');
  if (!input) return;
  const raw = (input.value || '').trim();
  const value = raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(value) || value < 0) { showToast('Cap must be a non-negative number (0 = auto-detect).'); return; }
  // Resolve the active model from the latest health payload via the
  // input's data attribute fallback or by hitting /api/system/health.
  try {
    const healthResp = await fetch('/api/system/health');
    const health = await healthResp.json();
    const model = health && health.context && health.context.model;
    if (!model) { showToast('No active model — cannot save profile.'); return; }
    const response = await fetch('/api/system/model-profiles/' + encodeURIComponent(model), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMaxTokens: value }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadHealth();
  } catch (error) {
    showToast('Save failed: ' + (error && error.message ? error.message : error));
  }
}

async function clearModelProfileCap() {
  try {
    const healthResp = await fetch('/api/system/health');
    const health = await healthResp.json();
    const model = health && health.context && health.context.model;
    if (!model) { showToast('No active model — cannot clear profile.'); return; }
    const response = await fetch('/api/system/model-profiles/' + encodeURIComponent(model), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMaxTokens: null }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    await loadHealth();
  } catch (error) {
    showToast('Clear failed: ' + (error && error.message ? error.message : error));
  }
}

async function loadEvents() {
  const view = document.getElementById('eventsView');
  if (!view) return;
  view.innerHTML = '<div class="trace-meta">Loading events…</div>';  try {
    const [summaryR, eventsR] = await Promise.allSettled([
      fetch('/api/events/summary').then((r) => r.json()),
      fetch('/api/events?limit=50').then((r) => r.json()),
    ]);
    const summary = summaryR.status === 'fulfilled' ? summaryR.value : {};
    const events = eventsR.status === 'fulfilled' ? eventsR.value : { events: [] };
    const categoryPills = Object.entries(summary.categories || {}).map(([k, v]) => {
      const active = _eventCategoryFilter.size === 0 || _eventCategoryFilter.has(k);
      return '<button class="tag' + (active ? '' : ' tag-muted') + '" onclick="toggleEventCategory(\'' + escAttr(k) + '\')" style="cursor:pointer;opacity:' + (active ? '1' : '0.4') + '">' + esc(k) + ': ' + v + '</button>';
    }).join(' ');
    const filterNote = _eventCategoryFilter.size > 0 ? '<span class="trace-meta" style="font-size:0.7em"> (filtered · <a href="#" onclick="event.preventDefault();_eventCategoryFilter.clear();loadEvents()">show all</a>)</span>' : '';
    // Timeline chart: group events by hour for last 24h
    const timelineChart = buildEventTimeline(events.events || []);
    const filteredEvents = _eventCategoryFilter.size === 0
      ? (events.events || [])
      : (events.events || []).filter((ev) => _eventCategoryFilter.has(ev.category));
    const rows = filteredEvents.map((ev) => {
      const icon = ev.category === 'promise' ? '🤝' : ev.category === 'service' ? '🔧' : ev.category === 'tool' ? '🔨' : ev.category === 'system' ? '⚙️' : '📋';
      const searchText = [ev.category, ev.type, ev.actor, ev.subject_id, JSON.stringify(ev.data)].join(' ').toLowerCase();
      return '<div class="trace-item event-row" data-search="' + escAttr(searchText.slice(0, 300)) + '"><div class="trace-title">' + icon + ' ' + esc(ev.category) + '/' + esc(ev.type) + '</div>'
        + '<div class="trace-meta">' + esc(ev.timestamp?.slice(0, 19) || '') + ' · ' + esc(ev.actor) + (ev.subject_id ? ' · ' + esc(ev.subject_id.slice(0, 20)) : '') + '</div>'
        + '<div class="trace-meta" style="font-size:0.75em;opacity:0.7">' + esc(JSON.stringify(ev.data).slice(0, 120)) + '</div></div>';
    }).join('');
    view.innerHTML = '<div class="trace-item"><div class="trace-title">📋 Event Store</div>'
      + '<div class="trace-meta">' + (summary.total_events || 0) + ' total events · ' + (summary.snapshot_count || 0) + ' snapshots' + filterNote + '</div>'
      + '<div class="trace-meta">' + categoryPills + '</div>'
      + '<div class="document-actions"><button class="btn-sm" onclick="exportEvents()">Export JSON</button></div>'
      + '<div style="margin:4px 0"><input type="text" id="eventSearchInput" placeholder="Search events by type, category, or data..." class="panel-search" style="width:100%" onkeydown="if(event.key===\'Enter\')filterEventsBySearch()"></div>'
      + timelineChart
      + rows
      + '<div id="liveEventFeed"></div>'
      + (rows ? '' : '<div class="trace-meta">No events recorded yet.</div>')
      + ((events.events || []).length >= 50 ? '<div class="document-actions" style="margin-top:4px"><button class="btn-sm" onclick="loadMoreEvents()">Load More</button></div>' : '')
      + '</div>';
    // Start live event stream
    startEventStream();
  } catch (error) {
    view.innerHTML = '<div class="trace-meta">Failed to load: ' + esc(error.message || error) + '</div>';
  }
}
function startEventStream() {
  if (_eventStreamSource) { _eventStreamSource.close(); _eventStreamSource = null; }
  try {
    _eventStreamSource = new EventSource('/api/events/stream');
    _eventStreamSource.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        const feed = document.getElementById('liveEventFeed');
        if (!feed) return;
        // Apply category filter
        if (_eventCategoryFilter.size > 0 && !_eventCategoryFilter.has(ev.category)) return;
        _liveEventCount++;
        const icon = ev.category === 'promise' ? '🤝' : ev.category === 'service' ? '🔧' : ev.category === 'tool' ? '🔨' : ev.category === 'system' ? '⚙️' : '📋';
        const row = document.createElement('div');
        row.className = 'trace-item';
        row.style.borderLeft = '3px solid var(--accent)';
        row.innerHTML = '<div class="trace-title">' + icon + ' 🔴 ' + esc(ev.category) + '/' + esc(ev.type) + ' <span style="font-size:0.7em;opacity:0.5">(live)</span></div>'
          + '<div class="trace-meta">' + esc(ev.timestamp?.slice(11, 19) || '') + ' · ' + esc(ev.actor) + '</div>';
        feed.prepend(row);
        // Auto-scroll to top if user is near the top (within 100px)
        const view = document.getElementById('eventsView');
        if (view && view.scrollTop < 100) view.scrollTop = 0;
        // Keep max 20 live events visible
        while (feed.children.length > 20) feed.removeChild(feed.lastChild);
      } catch(e){ /* ignore parse errors */ }
    };
    _eventStreamSource.onerror = () => { /* reconnects automatically */ };
  } catch(e){ /* SSE not supported or blocked */ }
}
function toggleEventCategory(cat) {
  if (_eventCategoryFilter.has(cat)) {
    _eventCategoryFilter.delete(cat);
  } else {
    _eventCategoryFilter.add(cat);
  }
  loadEvents();
}
async function exportEvents() {
  try {
    const res = await fetch('/api/events?limit=10000');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'harness-events-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('export events failed', error);
  }
}

function filterEventsBySearch() {
  const query = (document.getElementById('eventSearchInput')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('.event-row');
  rows.forEach((row) => {
    const searchText = row.getAttribute('data-search') || '';
    row.style.display = !query || searchText.includes(query) ? '' : 'none';
  });
}

let _eventPageSize = 50;
async function loadMoreEvents() {
  _eventPageSize += 50;
  // Re-fetch with larger limit; loadEvents uses the hardcoded 50 so we override here
  const view = document.getElementById('eventsView');
  if (!view) return;
  try {
    const res = await fetch('/api/events?limit=' + _eventPageSize);
    const data = await res.json();
    const events = data.events || [];
    const feed = document.getElementById('liveEventFeed');
    // Find the existing event rows container and append new rows
    const existingRows = view.querySelectorAll('.event-row');
    const existingIds = new Set();
    existingRows.forEach((r) => existingIds.add(r.getAttribute('data-event-id')));
    let added = 0;
    for (const ev of events) {
      if (existingIds.has(ev.event_id)) continue;
      const icon = ev.category === 'promise' ? '🤝' : ev.category === 'service' ? '🔧' : ev.category === 'tool' ? '🔨' : ev.category === 'system' ? '⚙️' : '📋';
      const searchText = [ev.category, ev.type, ev.actor, ev.subject_id, JSON.stringify(ev.data)].join(' ').toLowerCase();
      const row = document.createElement('div');
      row.className = 'trace-item event-row';
      row.setAttribute('data-search', searchText.slice(0, 300));
      row.setAttribute('data-event-id', ev.event_id);
      row.innerHTML = '<div class="trace-title">' + icon + ' ' + esc(ev.category) + '/' + esc(ev.type) + '</div>'
        + '<div class="trace-meta">' + esc(ev.timestamp?.slice(0, 19) || '') + ' · ' + esc(ev.actor) + (ev.subject_id ? ' · ' + esc(ev.subject_id.slice(0, 20)) : '') + '</div>'
        + '<div class="trace-meta" style="font-size:0.75em;opacity:0.7">' + esc(JSON.stringify(ev.data).slice(0, 120)) + '</div>';
      if (feed) feed.parentNode.insertBefore(row, feed);
      added++;
    }
    // If we got fewer than the page size, hide load more
    if (events.length < _eventPageSize) {
      const btn = view.querySelector('button[onclick="loadMoreEvents()"]');
      if (btn) btn.parentNode.remove();
    }
  } catch (error) {
    console.error('load more events failed', error);
  }
}

