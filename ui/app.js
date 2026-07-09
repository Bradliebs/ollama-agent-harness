// Guard against CDN failure — if marked.js failed to load, provide a
// minimal fallback so the rest of app.js still executes and the UI
// remains interactive (buttons, panel toggles, etc.).
if (typeof marked === 'undefined') {
  window.marked = { parse: function(text) { return '<pre style="white-space:pre-wrap;word-break:break-word">' + String(text).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }) + '</pre>'; }, setOptions: function() {} };
}
marked.setOptions({ breaks: true, gfm: true });

const HARNESS_API_TOKEN_STORAGE_KEY = 'harness.apiToken';
const rawFetch = window.fetch.bind(window);
let harnessApiToken = '';
try { harnessApiToken = localStorage.getItem(HARNESS_API_TOKEN_STORAGE_KEY) || ''; } catch(e){}

function setHarnessApiToken(token) {
  harnessApiToken = String(token || '').trim();
  try {
    if (harnessApiToken) localStorage.setItem(HARNESS_API_TOKEN_STORAGE_KEY, harnessApiToken);
    else localStorage.removeItem(HARNESS_API_TOKEN_STORAGE_KEY);
  } catch(e){}
}

function isApiRequest(input) {
  const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
  return url.startsWith('/api/');
}

window.fetch = async function harnessFetchWithApiAuth(input, init) {
  if (!isApiRequest(input) || String(input).startsWith('/api/auth/config')) {
    return rawFetch(input, init);
  }
  const requestInit = init ? { ...init } : {};
  const headers = new Headers(requestInit.headers || {});
  if (harnessApiToken && !headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer ' + harnessApiToken);
  }
  requestInit.headers = headers;
  return rawFetch(input, requestInit);
};

async function ensureApiAuthReady() {
  try {
    const response = await rawFetch('/api/auth/config');
    if (!response.ok) return;
    const config = await response.json();
    if (!config || !config.required) return;
    if (harnessApiToken) return;
    const entered = await promptToast('Harness API auth is required. Enter HARNESS_API_AUTH_TOKEN:');
    if (entered && entered.trim()) {
      setHarnessApiToken(entered.trim());
    }
  } catch(e){
    // Best-effort check only.
  }
}

let isSending = false;
let activeCodexTaskRun = null;
// Reply-to-message state. When set, the next outbound user message is
// prefixed with a markdown blockquote of the referenced assistant reply
// so the model knows which earlier turn the user is responding to.
let pendingReply = null;
// ─── Toasts ───────────────────────────────────────────────────────
// Non-blocking notification used in place of the browser's blocking
// modal dialog. Stacked bottom-right above the sub-agents bar. The
// severity tone is auto-detected from common keywords in the message
// so call sites can stay as terse as the old one-liners they replaced.
// Pass { type, ttl } in options to override.
// See also confirmToast() / promptToast() below for the async drop-in
// replacements for the browser's synchronous dialog APIs (added in
// v0.5.10 so destructive actions no longer freeze the page).
function showToast(message, options) {
  try {
    const opts = options || {};
    const text = String(message == null ? '' : message);
    let type = opts.type;
    if (!type) {
      const lower = text.toLowerCase();
      if (/\b(fail|failed|error|invalid|denied|cannot|could not|not found|missing)\b/.test(lower)) type = 'error';
      else if (/\b(saved|created|updated|deleted|imported|exported|restored|added|installed|cleared|registered|sent|delivered|granted|revoked|copied|forked|executed)\b/.test(lower)) type = 'success';
      else type = 'info';
    }
    const ttl = opts.ttl !== undefined ? opts.ttl : (type === 'error' ? 0 : 4000);
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    el.innerHTML = '<div class="toast-msg">' + safeText + '</div>'
      + '<button type="button" class="toast-close" aria-label="Dismiss">&times;</button>';
    el.querySelector('.toast-close').onclick = () => el.remove();
    host.appendChild(el);
    if (ttl > 0) setTimeout(() => { if (el.parentNode) el.remove(); }, ttl);
    return el;
  } catch (e) {
    // Fail-safe: if anything goes wrong building the toast, fall back to
    // the native blocking dialog so the message is never silently lost.
    // Accessed via bracket notation so the alert→showToast sweep cannot
    // rewrite this line into infinite recursion.
    try { window['alert'](String(message)); } catch { /* truly nothing we can do */ }
    return null;
  }
}
if (typeof window !== 'undefined') window.showToast = showToast;

// ─── Modal toast prompts (confirm / prompt replacements) ──────────
// Drop-in async replacements for the browser's synchronous confirm
// and prompt dialogs, so destructive actions no longer freeze the whole page (which also
// pauses websockets, sub-agent telemetry, and the chat stream). The
// modal is centered, focus-trapped, dismissable with Esc, and resolves
// to:
//   confirmToast(message)        → Promise<boolean>
//   promptToast(message, def)    → Promise<string | null>  (null on cancel)
// Existing call-site idioms keep working when prefixed with `await`:
//   if (!await confirmToast('Delete?')) return;
//   const name = await promptToast('Name:', 'foo');
function _harnessModal({ kind, message, defaultValue }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'harness-modal-host';
    const safe = String(message == null ? '' : message)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const inputHtml = kind === 'prompt'
      ? '<input class="harness-modal-input" type="text" />'
      : '';
    host.innerHTML = ''
      + '<div class="harness-modal-backdrop"></div>'
      + '<div class="harness-modal" role="dialog" aria-modal="true">'
      +   '<div class="harness-modal-body">' + safe + '</div>'
      +   inputHtml
      +   '<div class="harness-modal-actions">'
      +     (kind === 'confirm' || kind === 'prompt'
              ? '<button type="button" class="btn-sm harness-modal-cancel">Cancel</button>'
              : '')
      +     '<button type="button" class="btn-sm primary harness-modal-ok">OK</button>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(host);
    const input = host.querySelector('.harness-modal-input');
    if (input) {
      input.value = defaultValue == null ? '' : String(defaultValue);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      setTimeout(() => { const ok = host.querySelector('.harness-modal-ok'); ok && ok.focus(); }, 0);
    }
    const cleanup = (result) => {
      document.removeEventListener('keydown', onKey, true);
      if (host.parentNode) host.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(kind === 'prompt' ? null : false); }
      else if (e.key === 'Enter' && (e.target === input || !input)) {
        e.preventDefault();
        cleanup(kind === 'prompt' ? (input ? input.value : '') : true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    host.querySelector('.harness-modal-ok').onclick = () => cleanup(kind === 'prompt' ? (input ? input.value : '') : true);
    const cancelBtn = host.querySelector('.harness-modal-cancel');
    if (cancelBtn) cancelBtn.onclick = () => cleanup(kind === 'prompt' ? null : false);
    host.querySelector('.harness-modal-backdrop').onclick = () => cleanup(kind === 'prompt' ? null : false);
  });
}
function confirmToast(message) { return _harnessModal({ kind: 'confirm', message }); }
function promptToast(message, defaultValue) { return _harnessModal({ kind: 'prompt', message, defaultValue }); }
if (typeof window !== 'undefined') {
  window.confirmToast = confirmToast;
  window.promptToast = promptToast;
}

// ─── Beginner UX: Simple/Advanced settings mode ───────────────────
// Stored in localStorage. Simple mode adds body.simple-mode which hides
// settings sections that aren't marked .essential and More-menu items
// marked .more-advanced. Defaults to simple on first visit.
const SETTINGS_MODE_KEY = 'harness.settingsMode';
function getSettingsMode() {
  try { return localStorage.getItem(SETTINGS_MODE_KEY) || 'simple'; } catch(e){ return 'simple'; }
}
function applySettingsMode(mode) {
  const simple = mode !== 'advanced';
  document.body.classList.toggle('simple-mode', simple);
  const simpleBtn = document.getElementById('settingsModeSimple');
  const advBtn = document.getElementById('settingsModeAdvanced');
  if (simpleBtn) simpleBtn.classList.toggle('active', simple);
  if (advBtn) advBtn.classList.toggle('active', !simple);
}
function setSettingsMode(mode) {
  const next = mode === 'advanced' ? 'advanced' : 'simple';
  try { localStorage.setItem(SETTINGS_MODE_KEY, next); } catch(e){ try { showToast('Could not save settings mode', 2500, 'warning'); } catch(_){} }
  applySettingsMode(next);
}
if (typeof window !== 'undefined') {
  window.setSettingsMode = setSettingsMode;
  // Apply early (before DOMContentLoaded so the body class is set ASAP).
  try { applySettingsMode(getSettingsMode()); } catch(e){}
  document.addEventListener('DOMContentLoaded', () => applySettingsMode(getSettingsMode()));
}

// ─── Beginner UX: Topbar emergency STOP ───────────────────────────
// Always-visible safety net. Confirms, then engages the kill switch via
// the same backend endpoint as the Tools panel. Lets users abort without
// having to find the buried button.
async function topbarEmergencyStop() {
  const ok = await confirmToast('Emergency STOP\n\nThis will halt the AI and block ALL tool calls (including reads) until you release it from the Tools tab. Proceed?');
  if (!ok) return;
  try {
    const r = await fetch('/api/permissions/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, reason: 'Topbar STOP button.' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    showToast('🛑 Kill switch engaged. The AI cannot run any tools.', 5000, 'warning');
  } catch (err) {
    showToast('⚠️ Could not engage kill switch: ' + (err && err.message ? err.message : err), 5000, 'error');
  }
}
if (typeof window !== 'undefined') {
  window.topbarEmergencyStop = topbarEmergencyStop;
}

// ─── Beginner UX: First-visit onboarding modal ────────────────────
// Shown once, dismissed forever via localStorage. Example prompts wire
// directly to the chat composer so the user can run them with one click.
const ONBOARD_SEEN_KEY = 'harness.onboardSeen';
function shouldShowOnboardModal() {
  try { return !localStorage.getItem(ONBOARD_SEEN_KEY); } catch(e){ return false; }
}
function dismissOnboardModal(remember) {
  const modal = document.getElementById('onboardModal');
  if (modal) modal.classList.add('hidden-by-default');
  const cb = document.getElementById('onboardDontShow');
  const shouldRemember = remember !== false && (!cb || cb.checked);
  if (shouldRemember) {
    try { localStorage.setItem(ONBOARD_SEEN_KEY, String(Date.now())); } catch(e){}
  }
}
function showOnboardModal() {
  const modal = document.getElementById('onboardModal');
  if (!modal) return;
  modal.classList.remove('hidden-by-default');
  // Wire example buttons to populate the chat composer.
  const examples = modal.querySelectorAll('.onboard-example');
  examples.forEach((btn) => {
    btn.onclick = () => {
      const prompt = btn.getAttribute('data-prompt') || '';
      const input = document.getElementById('chatInput');
      if (input) {
        input.value = prompt;
        try { autoSize(input); } catch(e){}
        input.focus();
      }
      dismissOnboardModal(true);
    };
  });
}
function replayOnboardingTour() {
  try { localStorage.removeItem(ONBOARD_SEEN_KEY); } catch(e){}
  showOnboardModal();
}
if (typeof window !== 'undefined') {
  window.dismissOnboardModal = dismissOnboardModal;
  window.showOnboardModal = showOnboardModal;
  window.replayOnboardingTour = replayOnboardingTour;
  document.addEventListener('DOMContentLoaded', () => {
    if (shouldShowOnboardModal()) {
      // Slight delay so the page paints first.
      setTimeout(() => { try { showOnboardModal(); } catch(e){} }, 400);
    }
  });
}

// ─── Teammate mode (Daily Brief scheduler) ─────────────────────────
// Powers the welcome-card "Your teammate" widget and the setup wizard.
// Talks to /api/teammate/* — see src/automation/teammateScheduler.ts on
// the server. Everything here is best-effort: a failed status fetch
// hides the card rather than blocking the chat surface.
const TEAMMATE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let _teammateState = null;

function _formatTeammateSubtitle(state) {
  const s = state && state.settings;
  if (!s) return 'Loading…';
  if (!s.enabled) return 'Idle — set up a Daily Brief so I work for you between sessions.';
  const channels = (s.channels || []).join(' + ') || 'file only';
  const next = state.nextRunAt ? new Date(state.nextRunAt) : null;
  let when = '';
  if (next && !isNaN(next.getTime())) {
    const diffMin = Math.round((next.getTime() - Date.now()) / 60000);
    if (diffMin <= 0) when = 'queued';
    else if (diffMin < 60) when = `in ${diffMin}m`;
    else if (diffMin < 1440) when = `in ${Math.round(diffMin / 60)}h`;
    else when = `at ${next.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  } else {
    when = `at ${s.scheduleTime}`;
  }
  return `Next brief ${when} · delivering to ${channels}`;
}

async function loadTeammateStatus() {
  const card = document.getElementById('teammateCard');
  if (!card) return;
  let state;
  try {
    const r = await fetch('/api/teammate/status');
    if (!r.ok) { card.classList.add('initial-hidden'); return; }
    state = await r.json();
  } catch (err) {
    card.classList.add('initial-hidden');
    return;
  }
  _teammateState = state;
  card.classList.remove('initial-hidden');
  card.classList.toggle('active', Boolean(state.settings && state.settings.enabled));
  card.classList.toggle('paused', !(state.settings && state.settings.enabled));
  const title = document.getElementById('teammateCardTitle');
  const sub = document.getElementById('teammateCardSubtitle');
  const cta = document.getElementById('teammateCardCta');
  const runBtn = document.getElementById('teammateRunNowBtn');
  if (title) title.textContent = state.settings && state.settings.enabled ? 'Your teammate is active' : 'Your teammate is asleep';
  if (sub) sub.textContent = _formatTeammateSubtitle(state);
  if (cta) cta.textContent = state.settings && state.settings.enabled ? 'Edit' : 'Set up';
  if (runBtn) runBtn.style.display = state.settings && state.settings.enabled ? '' : 'none';
}

function _renderTeammateDays(selectedDays) {
  const host = document.getElementById('teammateDays');
  if (!host) return;
  host.innerHTML = '';
  for (const day of TEAMMATE_DAYS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'teammate-day-chip' + (selectedDays.includes(day) ? ' active' : '');
    chip.textContent = day;
    chip.dataset.day = day;
    chip.onclick = () => { chip.classList.toggle('active'); };
    host.appendChild(chip);
  }
}

function _renderTeammateChannels(selectedChannels, state) {
  const host = document.getElementById('teammateChannels');
  if (!host) return;
  host.innerHTML = '';
  const channels = [
    { id: 'file', label: '📄 File (always saved)', enabled: true, disabled: true, alwaysOn: true },
    { id: 'telegram', label: '📱 Telegram', enabled: state.telegramConfigured, disabledReason: 'Configure HARNESS_TELEGRAM_BOT_TOKEN in Settings first.' },
    { id: 'discord', label: '💬 Discord webhook', enabled: state.discordConfigured, disabledReason: 'Configure Discord webhook in Settings first.' },
    { id: 'slack', label: '💬 Slack webhook', enabled: state.slackConfigured, disabledReason: 'Configure Slack webhook in Settings first.' },
  ];
  for (const c of channels) {
    const chip = document.createElement('label');
    chip.className = 'teammate-channel-chip' + (selectedChannels.includes(c.id) || c.alwaysOn ? ' active' : '') + (c.enabled ? '' : ' disabled');
    chip.title = c.enabled ? '' : (c.disabledReason || '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedChannels.includes(c.id) || c.alwaysOn === true;
    cb.disabled = c.alwaysOn === true || !c.enabled;
    cb.dataset.channel = c.id;
    cb.onchange = () => { chip.classList.toggle('active', cb.checked); };
    chip.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = c.label;
    chip.appendChild(span);
    host.appendChild(chip);
  }
}

function _readTeammateWizard() {
  const time = document.getElementById('teammateTime').value || '08:00';
  const days = Array.from(document.querySelectorAll('#teammateDays .teammate-day-chip.active')).map((el) => el.dataset.day);
  const channels = Array.from(document.querySelectorAll('#teammateChannels input[type=checkbox]')).filter((el) => el.checked).map((el) => el.dataset.channel);
  const briefingPrompt = (document.getElementById('teammateBriefingPrompt')?.value || '').trim();
  const maxWordsRaw = parseInt(document.getElementById('teammateBriefingMaxWords')?.value || '150', 10);
  const briefingMaxWords = Number.isFinite(maxWordsRaw) ? maxWordsRaw : 150;
  const calendarPath = (document.getElementById('teammateCalendarPath')?.value || '').trim();
  return { enabled: true, scheduleTime: time, scheduleDays: days.length > 0 ? days : TEAMMATE_DAYS, channels: channels.length > 0 ? channels : ['file'], briefingPrompt, briefingMaxWords, calendarPath };
}

async function openTeammateWizard() {
  const modal = document.getElementById('teammateModal');
  if (!modal) return;
  // Refresh status so chip availability reflects current connector config.
  await loadTeammateStatus();
  const state = _teammateState || { settings: { scheduleTime: '08:00', scheduleDays: TEAMMATE_DAYS, channels: ['file'] }, telegramConfigured: false, discordConfigured: false, slackConfigured: false };
  document.getElementById('teammateTime').value = state.settings.scheduleTime || '08:00';
  _renderTeammateDays(Array.isArray(state.settings.scheduleDays) && state.settings.scheduleDays.length ? state.settings.scheduleDays : TEAMMATE_DAYS);
  _renderTeammateChannels(Array.isArray(state.settings.channels) && state.settings.channels.length ? state.settings.channels : ['file'], state);
  const promptEl = document.getElementById('teammateBriefingPrompt');
  if (promptEl) promptEl.value = state.settings.briefingPrompt || '';
  const wordsEl = document.getElementById('teammateBriefingMaxWords');
  if (wordsEl) wordsEl.value = state.settings.briefingMaxWords || 150;
  const calEl = document.getElementById('teammateCalendarPath');
  if (calEl) calEl.value = state.settings.calendarPath || '';
  const hint = document.getElementById('teammateNextRunHint');
  if (hint) hint.textContent = state.nextRunAt ? `Next run: ${new Date(state.nextRunAt).toLocaleString()}` : '';
  modal.classList.remove('hidden-by-default');
}

function dismissTeammateWizard() {
  const modal = document.getElementById('teammateModal');
  if (modal) modal.classList.add('hidden-by-default');
}

async function teammateSave() {
  const payload = _readTeammateWizard();
  try {
    const r = await fetch('/api/teammate/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); }
    showToast('🤝 Teammate scheduled', 2500, 'success');
    dismissTeammateWizard();
    loadTeammateStatus();
  } catch (err) {
    showToast('⚠️ Save failed: ' + (err && err.message ? err.message : err), 4000, 'error');
  }
}

async function teammateSaveAndRunNow() {
  await teammateSave();
  await teammateRunNow();
}

async function teammateRunNow() {
  try {
    const r = await fetch('/api/teammate/run-now', { method: 'POST' });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); }
    const data = await r.json();
    if (data && data.result && data.result.fired) {
      const delivered = (data.result.channelsDelivered || []).join(', ') || 'file';
      const failed = (data.result.channelsFailed || []).length;
      showToast(`📓 Brief delivered to ${delivered}${failed ? ` (${failed} channel(s) failed)` : ''}`, 4000, failed ? 'warning' : 'success');
    } else {
      showToast('Brief did not fire: ' + (data && data.result ? data.result.reason : 'unknown'), 3500, 'warning');
    }
    loadTeammateStatus();
  } catch (err) {
    showToast('⚠️ Could not run brief: ' + (err && err.message ? err.message : err), 4000, 'error');
  }
}

if (typeof window !== 'undefined') {
  window.openTeammateWizard = openTeammateWizard;
  window.dismissTeammateWizard = dismissTeammateWizard;
  window.teammateSave = teammateSave;
  window.teammateSaveAndRunNow = teammateSaveAndRunNow;
  window.teammateRunNow = teammateRunNow;
  window.loadTeammateStatus = loadTeammateStatus;
  document.addEventListener('DOMContentLoaded', () => {
    // Defer slightly so we don't compete with the initial model fetch.
    setTimeout(() => { try { loadTeammateStatus(); } catch(e){} }, 600);
    // Refresh every 5 min so the "Next brief in Xh" hint stays fresh.
    setInterval(() => { try { loadTeammateStatus(); } catch(e){} }, 5 * 60_000);
  });
}


// ─── Active sub-agents bar ────────────────────────────────────────
// Renders a compact pill row above the chat input showing every
// currently-running sub-agent with a cancel button. Driven by the
// /api/subagents endpoint and refreshed by WS events
// (subagent.start / subagent.end / subagent.cancel). When the list is
// empty the bar is hidden so it never adds vertical noise.
async function loadActiveSubagentsBar() {
  const host = document.getElementById('activeSubagentsBar');
  if (!host) return;
  try {
    const response = await fetch('/api/subagents');
    const data = await response.json();
    const list = Array.isArray(data && data.subagents) ? data.subagents : [];
    if (list.length === 0) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    const safeEsc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const pills = list.map((record) => {
      const seconds = Math.max(0, Math.round((record.durationMs || 0) / 1000));
      const snippet = safeEsc((record.promptSnippet || '').slice(0, 60));
      const idAttr = safeEsc(record.id);
      const activity = safeEsc((record.lastActivity || '').slice(0, 60));
      const activityAge = record.updatedAtMs ? Math.max(0, Math.round((Date.now() - record.updatedAtMs) / 1000)) : null;
      const activityHtml = activity
        ? '<span style="color:var(--accent);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + activity + (activityAge !== null ? ' (' + activityAge + 's ago)' : '') + '">' + activity + '</span>'
        : '<span style="color:var(--text-dim);font-style:italic" title="No activity reported yet \u2014 the agent may still be thinking">thinking\u2026</span>';
      return '<span class="active-subagent-pill" style="display:inline-flex;align-items:center;gap:6px;padding:2px 6px;margin:2px;border-radius:10px;background:var(--surface2,rgba(120,120,120,0.15));font-size:11px">'
        + '<span style="color:var(--accent)">\u26AC</span>'
        + '<strong>' + safeEsc(record.name || 'subagent') + '</strong>'
        + '<span style="color:var(--text-dim)">' + seconds + 's</span>'
        + activityHtml
        + (snippet ? '<span style="color:var(--text-dim);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + snippet + '">' + snippet + '</span>' : '')
        + '<button type="button" class="msg-action-btn" title="Cancel sub-agent" onclick="cancelActiveSubagent(\'' + idAttr.replace(/'/g, "\\'") + '\')" style="padding:0 6px">\u2715</button>'
        + '</span>';
    }).join('');
    host.style.display = 'block';
    host.innerHTML = '<div style="padding:4px 6px;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text-dim);margin-right:6px">Active sub-agents (' + list.length + ')</span>' + pills + '</div>';
  } catch(e){
    // Best-effort — don't disturb chat on transient failures.
    host.style.display = 'none';
    host.innerHTML = '';
  }
}

async function cancelActiveSubagent(id) {
  if (!id) return;
  try {
    await fetch('/api/subagents/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
    loadActiveSubagentsBar();
  } catch (error) {
    console.warn('Cancel sub-agent failed', error);
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadActiveSubagentsBar);
  else loadActiveSubagentsBar();
  // Periodic refresh as a safety net so the bar reflects in-flight runs
  // even when the WS reconnects mid-flight. 2s so the live activity
  // label ("\uD83D\uDD27 read_file", etc) feels live.
  setInterval(() => {
    const host = document.getElementById('activeSubagentsBar');
    if (host) loadActiveSubagentsBar();
  }, 2000);
}
function renderPendingReplyChip() {
  const host = document.getElementById('pendingReplyChip') || (() => {
    const inp = document.getElementById('chatInput');
    if (!inp || !inp.parentNode) return null;
    const el = document.createElement('div');
    el.id = 'pendingReplyChip';
    el.className = 'pending-reply-chip';
    el.style.cssText = 'display:none;margin:4px 0;padding:6px 8px;border-left:3px solid var(--accent,#6cf);background:var(--surface2,rgba(120,120,120,0.1));font-size:12px;color:var(--text-dim,#aaa);border-radius:4px;display:flex;align-items:center;gap:6px';
    inp.parentNode.insertBefore(el, inp);
    return el;
  })();
  if (!host) return;
  if (!pendingReply) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = 'flex';
  const snippet = (pendingReply.snippet || '').slice(0, 140).replace(/\s+/g, ' ');
  const safeSnippet = document.createElement('em');
  safeSnippet.textContent = snippet;
  host.innerHTML = '<span style="flex:1">↪ Replying to: </span><button type="button" class="msg-action-btn" id="cancelPendingReplyBtn" title="Cancel reply" style="padding:2px 6px">✕</button>';
  host.querySelector('span').appendChild(safeSnippet);
  const cancel = document.getElementById('cancelPendingReplyBtn');
  if (cancel) cancel.onclick = () => { pendingReply = null; renderPendingReplyChip(); };
}
function startReplyTo(messageIndex) {
  const msg = chatMessages[messageIndex];
  if (!msg || msg.role !== 'assistant') return;
  pendingReply = { index: messageIndex, snippet: String(msg.content || '').trim() };
  renderPendingReplyChip();
  const inp = document.getElementById('chatInput');
  if (inp) inp.focus();
}
function saveChatSession() {
  window.HarnessChatHistory.saveChatSession({ chatMessages, currentChatId });
}
function outboundChatHistory() {
  return window.HarnessChatHistory.outboundChatHistory(chatMessages);
}
let chatMessages = [];
let currentChatId = null;
let lastSessionId = null;
let pendingFiles = [];
let permissionPollTimer = null;
let activeChatController = null;
let activeTraceExport = null;
let latestEvidenceObject = null;
let currentModelRouting = {};
let currentMediaTools = {};
let currentOutputValidation = { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: true };
let currentOutputValidationProfiles = [];
let currentOutputValidationTemplates = [];
let currentModelCatalog = { url: '', ttlHours: 24 };
let currentExtensionActivation = { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
let currentModelDebugLog = { enabled: false, path: '.harness/model-debug.jsonl' };
const LAST_VALIDATION_PROMPT_KEY = 'harness.lastValidationPrompt';
let lastValidationPrompt = (() => {
  try { return localStorage.getItem(LAST_VALIDATION_PROMPT_KEY) || ''; } catch(e){ return ''; }
})();
let currentWalkthrough = { completed: [] };
let availableModels = [];
let compareEnabled = false;
let statusCenterConnectionState = 'loading';
let statusCenterAutonomyState = 'idle';
let statusCenterPendingPermissions = 0;
let statusCenterReadiness = {
  blocked: 0,
  warn: 0,
  message: '',
  actionLabel: '',
  actionHandler: null,
};
let statusCenterActionHandler = null;

// ─── Parallel Session Tabs ──────────────────────────────────────────
// Each session tab holds its own chat state so the user can start a prompt,
// open a new tab, prompt again, and come back when either finishes.
const sessionTabs = new Map(); // tabId → { title, chatMessages, currentChatId, isSending, activeChatController, sessionUsage, htmlSnapshot, status }
let activeTabId = null;
let _tabIdCounter = 0;

function _nextTabId() { return 'tab-' + (++_tabIdCounter); }

function _defaultSessionState(title) {
  return {
    title: title || 'New chat',
    chatMessages: [],
    currentChatId: null,
    model: null, // per-tab model override; null = use whatever's selected
    isSending: false,
    activeChatController: null,
    sessionUsage: { calls: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTurnMs: 0, lastModel: null },
    htmlSnapshot: null,
    status: 'idle', // idle | streaming | done
  };
}

function _snapshotActiveTab() {
  if (!activeTabId || !sessionTabs.has(activeTabId)) return;
  const tab = sessionTabs.get(activeTabId);
  tab.chatMessages = [...chatMessages]; // Deep copy — don't share by reference
  tab.currentChatId = currentChatId;
  tab.isSending = isSending;
  tab.activeChatController = activeChatController;
  tab.sessionUsage = typeof sessionUsage !== 'undefined' ? { ...sessionUsage } : tab.sessionUsage;
  tab.htmlSnapshot = document.getElementById('chatArea').innerHTML;
  tab.title = chatMessages.length > 0 ? (chatMessages[0].content || '').slice(0, 40) || 'Chat' : 'New chat';
  const modelSel = document.getElementById('modelSelect');
  if (modelSel) tab.model = modelSel.value || null;
}

function _restoreTab(tabId) {
  const tab = sessionTabs.get(tabId);
  if (!tab) return;
  chatMessages = [...tab.chatMessages]; // Copy — don't share reference with tab state
  currentChatId = tab.currentChatId;
  isSending = tab.isSending;
  activeChatController = tab.activeChatController;
  if (typeof sessionUsage !== 'undefined') Object.assign(sessionUsage, tab.sessionUsage);
  const area = document.getElementById('chatArea');
  if (tab.htmlSnapshot !== null) {
    area.innerHTML = tab.htmlSnapshot;
  } else {
    area.innerHTML = welcomeMarkup();
  }
  // Restore per-tab model selection
  const modelSel = document.getElementById('modelSelect');
  if (modelSel && tab.model) modelSel.value = tab.model;
  // Update send button state
  const btn = document.getElementById('sendBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = isSending ? '■' : '➤';
    btn.title = isSending ? 'Stop' : 'Send';
  }
  activeTabId = tabId;
}

function createSessionTab(switchTo) {
  const id = _nextTabId();
  sessionTabs.set(id, _defaultSessionState('New chat'));
  if (switchTo !== false) {
    // Snapshot the current tab before switching
    _snapshotActiveTab();
    // Force-clear global state for the new empty tab
    chatMessages = [];
    currentChatId = null;
    isSending = false;
    activeChatController = null;
    document.getElementById('chatArea').innerHTML = welcomeMarkup();
    activeTabId = id;
    const btn = document.getElementById('sendBtn');
    if (btn) { btn.disabled = false; btn.textContent = '➤'; btn.title = 'Send'; }
  }
  renderSessionTabs();
  return id;
}

function switchToTab(tabId) {
  if (tabId === activeTabId) return;
  _snapshotActiveTab();
  _restoreTab(tabId);
  // Safety: re-render DOM from chatMessages if htmlSnapshot might be stale
  // (e.g. background tab was still streaming when we last left it)
  const tab = sessionTabs.get(tabId);
  if (tab && tab.status === 'done' && tab.htmlSnapshot === null) {
    const area = document.getElementById('chatArea');
    area.innerHTML = '';
    for (const m of chatMessages) addMsg(m.role, m.content);
  }
  renderSessionTabs();
  saveChatSession();
  loadHistory();
}

function closeSessionTab(tabId) {
  const tab = sessionTabs.get(tabId);
  if (!tab) return;
  // Abort any active stream
  if (tab.activeChatController) {
    try { tab.activeChatController.abort(); } catch(e){}
  }
  sessionTabs.delete(tabId);
  // If we closed the active tab, switch to another
  if (tabId === activeTabId) {
    const remaining = [...sessionTabs.keys()];
    if (remaining.length > 0) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      // Last tab — create a fresh one
      createSessionTab();
    }
  }
  renderSessionTabs();
}

function renderSessionTabs() {
  const bar = document.getElementById('sessionTabs');
  if (!bar) return;
  const tabs = [...sessionTabs.entries()];
  bar.innerHTML = '';
  // Always show tab labels when 2+ tabs exist; show only the "+" button when just 1
  for (const [id, tab] of tabs) {
    if (tabs.length < 2) continue; // Hide individual tab chips when only one session
    const el = document.createElement('div');
    el.className = 'session-tab' + (id === activeTabId ? ' active' : '');
    const badgeClass = tab.status === 'streaming' ? 'streaming' : tab.status === 'done' ? 'done' : 'idle';
    const title = tab.title || 'New chat';
    const modelTag = tab.model ? ' · ' + tab.model.split(':')[0] : '';
    el.innerHTML = '<span class="tab-badge ' + badgeClass + '"></span>'
      + '<span class="tab-title">' + esc(title) + '<span style="opacity:.5;font-weight:400">' + esc(modelTag) + '</span></span>'
      + '<button class="tab-close" onclick="event.stopPropagation();closeSessionTab(\'' + id + '\')" title="Close">&times;</button>';
    el.onclick = () => switchToTab(id);
    bar.appendChild(el);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'session-tab-add';
  addBtn.innerHTML = tabs.length < 2 ? '+ New parallel session' : '+';
  addBtn.title = 'New parallel session — run another chat while this one streams';
  addBtn.onclick = () => createSessionTab();
  bar.appendChild(addBtn);
}

function _markTabStatus(tabId, status) {
  const tab = sessionTabs.get(tabId);
  if (tab) {
    tab.status = status;
    if (status === 'streaming') tab.isSending = true;
    if (status === 'done' || status === 'idle') tab.isSending = false;
  }
  renderSessionTabs();
}

window.addEventListener('DOMContentLoaded', async () => {
  await ensureApiAuthReady();
  restoreTheme();
  ensurePermissionPanel();
  refreshQuickStartChips();
  loadModels();
  loadHistory();
  loadFiles();
  loadSettings();
  loadSkills();
  loadPromiseWidget();
  loadOutputValidationTemplates();
  loadDiscovery();
  loadAbout();
  loadTraceExports();
  loadRuntimeStorage();
  loadRecovery();
  loadReadiness();
  loadAutonomyPlanPreview();
  loadDocuments();
  startPermissionPolling();
  startAutonomyPolling();
  loadInbox();
  setInterval(() => { loadInbox().catch(() => {}); }, 60_000);
  startTopbarPet();
  if (Notification.permission === 'default') Notification.requestPermission();
  window.addEventListener('focus', () => { document.title = document.title.replace(/^🔔 /, ''); });
  setupSettingsCollapse();
  restoreRightPanelState();
  loadApiKeys();
  loadEmailList();
  loadEmailTemplates();
  loadFileRedirects();
  loadAgentOutputDir();
  loadTelegramStatus();
  loadConnectorStatuses();
  loadDesktopInputEvidence();
  jarvisAutoRegisterBrowserVoice();
  refreshJarvisLive();
  setInterval(() => { refreshJarvisLive().catch(() => {}); }, 30_000);
  // Initialize the first session tab
  const firstTabId = createSessionTab(false);
  activeTabId = firstTabId;
  renderSessionTabs();
  document.getElementById('chatInput').focus();
});

function setHarnessStatus(state, label, title) {
  const dot = document.getElementById('statusDot');
  const pill = document.getElementById('statusPill');
  const pillLabel = document.getElementById('statusLabel');
  statusCenterConnectionState = state || 'loading';
  if (dot) dot.className = 'status-dot' + (state === 'ok' ? ' ok' : state === 'loading' ? ' loading' : '');
  if (pill) {
    pill.classList.remove('ok', 'loading', 'error');
    if (state) pill.classList.add(state);
    if (title) pill.title = title;
  }
  if (pillLabel) pillLabel.textContent = label;
  refreshStatusCenter();
}

function runStatusCenterAction() {
  if (typeof statusCenterActionHandler === 'function') {
    try { statusCenterActionHandler(); } catch (error) { console.warn('status center action failed', error); }
  }
}

function setStatusCenterReadiness(next) {
  statusCenterReadiness = {
    blocked: Number(next?.blocked || 0),
    warn: Number(next?.warn || 0),
    message: String(next?.message || ''),
    actionLabel: String(next?.actionLabel || ''),
    actionHandler: typeof next?.actionHandler === 'function' ? next.actionHandler : null,
  };
  refreshStatusCenter();
}

function resolveReadinessAction(check) {
  if (!check) return { actionLabel: 'Refresh checks', actionHandler: () => loadReadiness() };
  if (check.action === 'Open Settings') return { actionLabel: 'Open settings', actionHandler: () => toggleRight() };
  if (check.action === 'Open Tools') return { actionLabel: 'Open tools', actionHandler: () => openLeftTabByName('tools') };
  if (check.action === 'Open Promises') return { actionLabel: 'Open promises', actionHandler: () => openLeftTabByName('promises') };
  if (check.id === 'permission.mode') return { actionLabel: 'Set safe mode', actionHandler: () => toggleRight() };
  if (check.id === 'model.toolCalling') return { actionLabel: 'Probe model', actionHandler: () => probeModelTools() };
  if (check.id && check.id.startsWith('tool.')) return { actionLabel: 'Fix blockers', actionHandler: () => fixReadinessBlockers() };
  return { actionLabel: 'Refresh checks', actionHandler: () => loadReadiness() };
}

function refreshStatusCenter() {
  const center = document.getElementById('statusCenter');
  const stateEl = document.getElementById('statusCenterState');
  const detailEl = document.getElementById('statusCenterDetail');
  const actionBtn = document.getElementById('statusCenterAction');
  if (!center || !stateEl || !detailEl || !actionBtn) return;

  let tone = 'ready';
  let headline = 'Ready';
  let detail = 'Core checks are passing.';
  let actionLabel = 'Refresh';
  let actionHandler = () => loadReadiness();

  if (statusCenterConnectionState === 'error') {
    tone = 'error';
    headline = 'Needs setup';
    detail = 'Server connection is offline.';
    actionLabel = 'Open settings';
    actionHandler = () => toggleRight();
  } else if (statusCenterConnectionState === 'loading') {
    tone = 'working';
    headline = 'Connecting';
    detail = 'Checking model and service health…';
    actionLabel = 'Refresh';
    actionHandler = () => loadModels();
  } else if (statusCenterPendingPermissions > 0) {
    tone = 'warn';
    headline = 'Action needed';
    detail = statusCenterPendingPermissions + ' permission request(s) waiting.';
    actionLabel = 'Review';
    actionHandler = () => {
      const panel = document.getElementById('permissionPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  } else if (statusCenterAutonomyState === 'running') {
    tone = 'working';
    headline = 'Working';
    detail = 'Autonomy run is active.';
    actionLabel = 'View log';
    actionHandler = () => toggleAutonomyLog();
  } else if (statusCenterReadiness.blocked > 0) {
    tone = 'warn';
    headline = 'Needs attention';
    detail = statusCenterReadiness.message || (statusCenterReadiness.blocked + ' blocker(s) in mission checks.');
    actionLabel = statusCenterReadiness.actionLabel || 'Review';
    actionHandler = statusCenterReadiness.actionHandler || (() => loadReadiness());
  } else if (statusCenterReadiness.warn > 0) {
    tone = 'warn';
    headline = 'Almost ready';
    detail = statusCenterReadiness.message || (statusCenterReadiness.warn + ' warning(s) remain.');
    actionLabel = statusCenterReadiness.actionLabel || 'Review';
    actionHandler = statusCenterReadiness.actionHandler || (() => loadReadiness());
  }

  center.classList.remove('hidden-by-default', 'ready', 'warn', 'error', 'working');
  center.classList.add(tone);
  stateEl.innerHTML = '<strong>' + esc(headline) + '</strong>';
  detailEl.textContent = detail;
  actionBtn.textContent = actionLabel;
  statusCenterActionHandler = actionHandler;
}

async function loadModels() {
  const sel = document.getElementById('modelSelect');
  const setStatus = setHarnessStatus;
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    if (d.error) {
      const friendly = String(d.error || '');
      const isConn = /ECONNREFUSED|fetch failed|connect|refused|getaddrinfo|ENOTFOUND/i.test(friendly);
      setStatus('error', 'Offline', isConn ? 'Ollama is not running' : friendly);
      sel.innerHTML = '<option>' + esc(friendly) + '</option>';
      const banner = document.getElementById('noModelBanner');
      if (banner) {
        banner.classList.remove('hidden-by-default');
        if (isConn) {
          banner.innerHTML = '<div class="no-model-icon">⚠️</div><div><strong>Can\'t reach Ollama.</strong><div class="no-model-hint">Open a terminal and run: <code>ollama serve</code><br>If Ollama isn\'t installed, get it from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>. Then click Refresh.</div><div style="margin-top:8px"><button class="btn-sm primary" onclick="loadModels()">🔄 Refresh</button></div></div>';
        } else {
          banner.innerHTML = '<div class="no-model-icon">⚠️</div><div><strong>Could not list models.</strong><div class="no-model-hint">' + esc(friendly) + '</div><div style="margin-top:8px"><button class="btn-sm primary" onclick="loadModels()">🔄 Refresh</button></div></div>';
        }
      }
      return;
    }
    setStatus('ok', 'Connected', 'Connected to Ollama');
    const models = d.models || [];
    availableModels = models;
    if (!models.length) {
      sel.innerHTML = '<option value="">No models installed</option>';
      updateNoModelEmptyState();
      // Banner with concrete fix instructions for non-developers.
      const banner = document.getElementById('noModelBanner');
      if (banner) {
        banner.classList.remove('hidden-by-default');
        banner.innerHTML = '<div class="no-model-icon">⬇</div><div><strong>No AI models installed yet.</strong><div class="no-model-hint">Open a terminal and run: <code>ollama pull llama3.2</code> (downloads about 2 GB). When it finishes, click Refresh below.</div><div style="margin-top:8px"><button class="btn-sm primary" onclick="loadModels()">🔄 Refresh models</button></div></div>';
      }
      return;
    }
    sel.innerHTML = '<option value="">— Select model —</option>' + models.map((m) => {
      const size = m.parameterSize ? ' (' + m.parameterSize + ')' : '';
      const backendBadge = m.backend && m.backend !== 'ollama' ? ' [' + m.backend + ']' : '';
      return '<option value="' + escAttr(m.name) + '">' + esc(m.name + size + backendBadge) + '</option>';
    }).join('');
    sel.disabled = false;
    sel.onchange = () => {
      renderModelCapabilityHint();
      if (sel.value) {
        updateSetting('model', sel.value);
        document.getElementById('sendBtn').disabled = false;
        updateNoModelEmptyState();
        setStatus('ok', 'Connected', 'Connected · model: ' + sel.value);
      }
    };
    // Pick a default model so users don't stare at "— Select model —" on first
    // run. Priority: saved setting that still matches an installed model →
    // first model in the list. Either way, fire change so the send button
    // enables and the capability hint updates.
    let defaultModel = '';
    try {
      const settings = await fetch('/api/settings').then((r) => r.json());
      const saved = settings && typeof settings.model === 'string' ? settings.model : '';
      if (saved && models.some((m) => m.name === saved)) defaultModel = saved;
      else if (saved) console.warn('[loadModels] saved model "' + saved + '" not in installed list — falling back to first model');
    } catch (error) {
      // Settings endpoint failed — let users know why their saved model didn't stick.
      console.warn('[loadModels] /api/settings failed (' + (error && error.message ? error.message : error) + ') — falling back to first model');
    }
    if (!defaultModel && models.length > 0) defaultModel = models[0].name;
    if (defaultModel) {
      sel.value = defaultModel;
      sel.dispatchEvent(new Event('change'));
      // Surface the active model in the status pill tooltip so users can
      // verify which one is wired up without opening the dropdown.
      setStatus('ok', 'Connected', 'Connected · model: ' + defaultModel);
    }
    renderModelCapabilityHint();
    // Compare-with selector mirrors the primary model list.
    const cmp = document.getElementById('compareModelSelect');
    if (cmp) {
      cmp.innerHTML = '<option value="">Compare with...</option>' + models.map((m) => {
        const size = m.parameterSize ? ' (' + m.parameterSize + ')' : '';
        const backendBadge = m.backend && m.backend !== 'ollama' ? ' [' + m.backend + ']' : '';
        return '<option value="' + escAttr(m.name) + '">' + esc(m.name + size + backendBadge) + '</option>';
      }).join('');
    }
    updateNoModelEmptyState();
    // Once the model is settled, drop the cursor in the chat composer so the
    // user can just start typing. Only when no other element is focused (to
    // avoid stealing focus while the user is mid-edit elsewhere).
    if (sel.value && document.activeElement === document.body) {
      const input = document.getElementById('chatInput');
      if (input) input.focus();
    }
  } catch(e){
    setStatus('error', 'Offline', 'Ollama is not running. Start it with `ollama serve`.');
    sel.innerHTML = '<option>Ollama not running</option>';
    availableModels = [];
    updateNoModelEmptyState();
    const banner = document.getElementById('noModelBanner');
    if (banner) {
      banner.classList.remove('hidden-by-default');
      banner.innerHTML = '<div class="no-model-icon">⚠️</div><div><strong>Can\'t reach Ollama.</strong><div class="no-model-hint">Open a terminal and run: <code>ollama serve</code><br>If Ollama isn\'t installed, download it from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>. Then click Refresh.</div><div style="margin-top:8px"><button class="btn-sm primary" onclick="loadModels()">🔄 Refresh</button></div></div>';
    }
  }
}

// When no model is selected, show a focused message instead of the busy
// welcome. Called on load and on every model-select change.
function updateNoModelEmptyState() {
  const sel = document.getElementById('modelSelect');
  const banner = document.getElementById('noModelBanner');
  if (!banner) return;
  if (!sel || !sel.value) banner.classList.remove('hidden-by-default');
  else banner.classList.add('hidden-by-default');
  updateQuickStartCtaState();
  applyModelGate();
}

// Generic "this action needs a model" gate. Any element with
// data-requires-model="1" is disabled while the model dropdown is empty.
// Saves the original title so we can restore it later. The hint title
// helps a novice understand WHY the button is greyed out instead of
// clicking and getting nothing.
function applyModelGate() {
  const sel = document.getElementById('modelSelect');
  const hasModel = Boolean(sel && sel.value);
  const nodes = document.querySelectorAll('[data-requires-model="1"]');
  nodes.forEach((node) => {
    if (!node.dataset.originalTitle) node.dataset.originalTitle = node.title || '';
    if (hasModel) {
      node.disabled = false;
      node.title = node.dataset.originalTitle;
    } else {
      node.disabled = true;
      node.title = 'Pick a model in the top bar first';
    }
  });
}

function updateQuickStartCtaState() {
  const sel = document.getElementById('modelSelect');
  const btn = document.getElementById('quickStartBtn');
  const hint = document.getElementById('quickStartHint');
  if (!btn || !hint) return;
  const hasModel = Boolean(sel && sel.value);
  const noInstalledModels = sel && !sel.value && availableModels.length === 0 && /no models installed/i.test(sel.textContent || '');
  const offline = sel && /server not running|offline/i.test(sel.textContent || '');
  btn.disabled = !hasModel;
  btn.title = hasModel ? 'Send a starter prompt' : 'Pick a model first';
  if (hasModel) {
    hint.textContent = 'Ready. Click Start quick test to send a guided first prompt.';
    setBeginnerReadiness('ready', 'Ready for first chat', 'A model is selected. Click Start quick test or type your own message.', 'Ready');
  } else if (offline) {
    hint.textContent = 'Start Ollama, then refresh this page.';
    setBeginnerReadiness('blocked', 'Start Ollama first', 'Harness cannot reach the local Ollama service yet. Start Ollama, then refresh models.', 'Blocked');
  } else if (noInstalledModels) {
    hint.textContent = 'Ollama is connected, but it needs at least one model.';
    setBeginnerReadiness('warn', 'Install one model', 'Ollama is running, but no chat model is installed. Run ollama pull llama3.2, then refresh models.', 'Needs model');
  } else {
    hint.textContent = 'Step 1: Pick a model above to unlock quick start.';
    setBeginnerReadiness('warn', 'Pick a model', 'Choose a model from the dropdown. Harness will unlock the first guided prompt.', 'Needs model');
  }
}

function setBeginnerReadiness(state, title, message, badge) {
  const panel = document.getElementById('beginnerReadiness');
  const titleEl = document.getElementById('beginnerReadinessTitle');
  const messageEl = document.getElementById('beginnerReadinessMessage');
  const badgeEl = document.getElementById('beginnerReadinessBadge');
  if (!panel || !titleEl || !messageEl || !badgeEl) return;
  panel.classList.remove('ready', 'warn', 'blocked');
  panel.classList.add(state || 'warn');
  titleEl.textContent = title || 'Check first-chat readiness';
  messageEl.textContent = message || 'Harness is checking local setup before your first message.';
  badgeEl.textContent = badge || 'Checking';
}

function openFirstRunGuide() {
  const guide = document.getElementById('welcomeFirstRun');
  if (guide) {
    guide.open = true;
    guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function startQuickTest() {
  const sel = document.getElementById('modelSelect');
  if (!sel || !sel.value) {
    updateNoModelEmptyState();
    sel?.focus();
    openFirstRunGuide();
    return;
  }
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = 'List files in this project and suggest the best first task for a beginner.';
  sendMessage();
}

async function readApiJson(response, endpointLabel) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const preview = (await response.text()).replace(/\s+/g, ' ').slice(0, 120);
    const htmlHint = preview.startsWith('<') || preview.toLowerCase().includes('<!doctype');
    if (htmlHint) {
      throw new Error(endpointLabel + ' returned HTML instead of JSON. Restart Harness server and refresh this page.');
    }
    throw new Error(endpointLabel + ' returned non-JSON content (' + (contentType || 'unknown content-type') + ').');
  }
  let data;
  try {
    data = await response.json();
  } catch(e){
    throw new Error(endpointLabel + ' returned invalid JSON.');
  }
  if (!response.ok) {
    const err = data && typeof data.error === 'string' && data.error
      ? data.error
      : response.status + ' ' + response.statusText;
    throw new Error(endpointLabel + ' failed: ' + err);
  }
  if (data && typeof data.error === 'string' && data.error) {
    throw new Error(data.error);
  }
  return data;
}

async function loadReadiness() {
  const panel = document.getElementById('missionControlPanel');
  const compact = document.getElementById('readinessSummary');
  if (!panel && !compact) return;
  try {
    const response = await fetch('/api/readiness');
    const data = await readApiJson(response, 'Readiness API');
    renderReadiness(data);
  } catch (error) {
    const html = '<div class="readiness-empty">Readiness unavailable: ' + esc(error.message || error) + '</div>';
    if (panel) panel.innerHTML = html;
    if (compact) compact.innerHTML = html;
  }
}

async function loadDailyBrief() {
  const body = document.getElementById('dailyBriefBody');
  const stamp = document.getElementById('dailyBriefStamp');
  const suggestions = document.getElementById('dailyBriefSuggestions');
  if (!body) return;
  body.textContent = 'Loading...';
  if (suggestions) suggestions.innerHTML = '';
  try {
    const response = await fetch('/api/jarvis/brief');
    const data = await readApiJson(response, 'Jarvis brief');
    if (stamp) stamp.textContent = new Date(data.generatedAt).toLocaleString();
    if (window.marked && data.markdown) {
      body.innerHTML = window.marked.parse(data.markdown);
    } else {
      body.textContent = data.markdown || '(empty)';
    }
    renderJarvisSuggestions(data.predictiveSuggestions || []);
    await renderJarvisTrustLadder();
    await refreshJarvisAmbientTile();
    await refreshJarvisRuntime();
    await refreshJarvisGhostHint();
  } catch (error) {
    body.innerHTML = '<div class="readiness-empty">Daily brief unavailable: ' + esc(error.message || error) + '</div>';
  }
}

function renderJarvisSuggestions(suggestions) {
  const host = document.getElementById('dailyBriefSuggestions');
  if (!host) return;
  if (!suggestions.length) { host.innerHTML = ''; return; }
  const items = suggestions.slice(0, 5).map((s) => {
    const pct = Math.round((s.confidence || 0) * 100);
    return '<li><strong>' + esc(s.predicted) + '</strong> after ' + esc(s.trigger) + ' <em style="color:var(--muted)">(' + pct + '% × ' + (s.sampleSize || 0) + ')</em></li>';
  }).join('');
  host.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Suggested next moves</div><ul style="margin:0 0 0 18px;padding:0">' + items + '</ul>';
}

async function renderJarvisTrustLadder() {
  const host = document.getElementById('dailyBriefTrustLadder');
  if (!host) return;
  try {
    const response = await fetch('/api/jarvis/status');
    const data = await readApiJson(response, 'Jarvis status');
    const caps = (data.trustLadder && data.trustLadder.capabilities) || [];
    if (!caps.length) { host.innerHTML = '<div style="color:var(--muted)">Trust ladder: all capabilities at default rung 2 (ask).</div>'; return; }
    const rows = caps.map((c) => {
      return '<tr><td style="padding:2px 8px"><code>' + esc(c.capability) + '</code></td>'
        + '<td style="padding:2px 8px">rung ' + c.rung + '</td>'
        + '<td style="padding:2px 8px">'
        + '<button class="btn-sm" onclick="jarvisLadderAction(\'' + esc(c.capability) + '\',\'promote\')">Promote</button> '
        + '<button class="btn-sm" onclick="jarvisLadderAction(\'' + esc(c.capability) + '\',\'demote\')">Demote</button>'
        + '</td></tr>';
    }).join('');
    host.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Trust ladder</div><table style="font-size:12px;border-collapse:collapse">' + rows + '</table>';
  } catch (error) {
    host.innerHTML = '<div class="readiness-empty">Trust ladder unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function jarvisLadderAction(capability, action) {
  try {
    const response = await fetch('/api/jarvis/trust-ladder/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
    });
    await readApiJson(response, 'Jarvis trust-ladder ' + action);
    await renderJarvisTrustLadder();
  } catch (error) {
    showToast('Trust ladder ' + action + ' failed: ' + (error.message || error));
  }
}

async function saveDailyBrief() {
  try {
    const response = await fetch('/api/jarvis/brief/save', { method: 'POST' });
    const data = await readApiJson(response, 'Jarvis brief save');
    showToast('Saved to: ' + data.savedTo);
  } catch (error) {
    showToast('Save failed: ' + (error.message || error));
  }
}

async function refreshJarvisGhostHint() {
  const host = document.getElementById('jarvisGhostHint');
  if (!host) return;
  try {
    const response = await fetch('/api/jarvis/next-suggestion');
    const data = await response.json();
    if (!data.suggestion) { host.textContent = ''; host.dataset.predicted = ''; return; }
    const s = data.suggestion;
    host.textContent = '💡 After ' + s.trigger + ', often: ' + s.predicted + ' (' + Math.round(s.confidence * 100) + '%) — click to insert';
    host.dataset.predicted = s.predicted || '';
    host.onclick = () => {
      const input = document.getElementById('chatInput');
      if (input && host.dataset.predicted) {
        input.value = (input.value ? input.value + ' ' : '') + host.dataset.predicted;
        input.focus();
        if (typeof autoSize === 'function') autoSize(input);
      }
    };
  } catch { /* silent */ }
}

async function loadJarvisGraph() {
  const host = document.getElementById('dailyBriefGraph');
  if (!host) return;
  try {
    const response = await fetch('/api/jarvis/graph/mermaid');
    const data = await readApiJson(response, 'Jarvis graph');
    const mermaidTheme = localStorage.getItem('harness-theme') === 'light' ? 'default' : 'dark';
    const mermaidBg = mermaidTheme === 'default' ? '#fff' : '#1e1e2e';
    const iframeHtml = '<!doctype html><html><head><meta charset=utf-8><script src=https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js></script><style>body{margin:8px;font-family:system-ui,sans-serif;background:' + mermaidBg + ';overflow:auto}svg{max-width:100%;height:auto}</style></head><body><div class=mermaid>' + esc(data.mermaid) + '</div><script>mermaid.initialize({startOnLoad:true,theme:\'' + mermaidTheme + '\',securityLevel:"loose",fontFamily:"system-ui,sans-serif",fontSize:13,flowchart:{htmlLabels:true,curve:"basis",nodeSpacing:40,rankSpacing:60}})</script></body></html>';
    const mmdBlob = JSON.stringify(data.mermaid);
    host.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Knowledge graph</div>'
      + '<iframe sandbox="allow-scripts" style="width:100%;height:420px;border:1px solid var(--border,#333);border-radius:6px;background:' + mermaidBg + '" srcdoc="' + escAttr(iframeHtml) + '"></iframe>'
      + '<div class="document-actions" style="margin-top:4px"><button class="btn-sm" onclick="downloadMmd(' + mmdBlob + ',\'knowledge-graph.mmd\')">📥 Download .mmd</button>'
      + '<button class="btn-sm" onclick="navigator.clipboard.writeText(' + mmdBlob + ')">📋 Copy Mermaid</button></div>';
  } catch (error) {
    host.innerHTML = '<div class="readiness-empty">Graph unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function refreshJarvisRuntime() {
  const host = document.getElementById('dailyBriefRuntime');
  if (!host) return;
  try {
    const response = await fetch('/api/jarvis/status');
    const data = await readApiJson(response, 'Jarvis status');
    const runtime = data.runtime || { voice: {}, inbound: {} };
    const features = [
      { key: 'voice_stt', label: 'Voice STT', ready: runtime.voice.stt, adapter: runtime.voice.sttAdapter },
      { key: 'voice_tts', label: 'Voice TTS', ready: runtime.voice.tts, adapter: runtime.voice.ttsAdapter },
      { key: 'voice_wake', label: 'Voice wake', ready: runtime.voice.wake, adapter: runtime.voice.wakeAdapter },
      { key: 'inbound_slack', label: 'Inbound Slack', ready: runtime.inbound.slack },
      { key: 'inbound_telegram', label: 'Inbound Telegram', ready: runtime.inbound.telegram },
      { key: 'inbound_email', label: 'Inbound email', ready: runtime.inbound.email },
    ];
    const rows = features.map((f) => {
      const state = f.ready ? '<span style="color:var(--success,#0a0)">ready</span>' + (f.adapter ? ' (' + esc(f.adapter) + ')' : '') : '<span style="color:var(--muted)">not installed</span>';
      const action = f.ready
        ? ''
        : ' <button class="btn-sm" onclick="jarvisRuntimeRegister(\'' + f.key + '\')">Mark installed</button>';
      return '<tr><td style="padding:2px 8px">' + esc(f.label) + '</td><td style="padding:2px 8px">' + state + action + '</td></tr>';
    }).join('');
    // Whisper transcribe path is a separate signal from the SDK adapter
    // bookkeeping in `runtime.voice.*` — it reflects the actual server
    // env vars. Surface it inline so users can self-diagnose without
    // opening DevTools (the silent-failure mode that ate 2026-05-12).
    const whisper = (data.voice && data.voice.whisper) || null;
    let whisperRow = '';
    if (whisper) {
      const state = whisper.ok
        ? '<span style="color:var(--success,#0a0)">ready</span> (' + esc(whisper.mode) + ')'
        : '<span style="color:var(--danger,#e55)">not configured</span>';
      whisperRow = '<tr><td style="padding:2px 8px">Whisper transcribe</td>'
        + '<td style="padding:2px 8px">' + state
        + (whisper.hint ? ' <span style="color:var(--muted);font-size:11px">' + esc(whisper.hint) + '</span>' : '')
        + '</td></tr>';
    }
    host.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Voice / inbound runtime</div><table style="font-size:12px;border-collapse:collapse">' + rows + whisperRow + '</table>';
  } catch (error) {
    host.innerHTML = '<div class="readiness-empty">Runtime status unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function jarvisRuntimeRegister(feature) {
  const adapterName = await promptToast('Adapter name for ' + feature + ' (e.g. whisper-cpp):');
  if (!adapterName) return;
  try {
    await fetch('/api/jarvis/runtime/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, adapterName }),
    });
    await refreshJarvisRuntime();
  } catch (error) {
    showToast('Register failed: ' + (error.message || error));
  }
}

async function refreshJarvisAmbientTile() {
  const host = document.getElementById('dailyBriefAmbient');
  if (!host) return;
  try {
    const response = await fetch('/api/jarvis/ambient');
    const data = await response.json();
    const watchers = (data.watchers || []).join(', ') || 'none';
    const button = data.running
      ? '<button class="btn-sm" onclick="jarvisAmbientControl(\'stop\')">Stop ambient</button>'
      : '<button class="btn-sm" onclick="jarvisAmbientControl(\'start\')">Start ambient</button>';
    host.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Ambient daemon</div>'
      + '<div style="font-size:12px;color:var(--muted)">running: ' + (data.running ? 'yes' : 'no')
      + ' · watchers: ' + esc(watchers)
      + ' · recent signals: ' + (data.recentSignalCount || 0) + '</div>'
      + '<div style="margin-top:4px">' + button + '</div>';
  } catch { /* silent */ }
}

async function jarvisAmbientControl(action) {
  try {
    await fetch('/api/jarvis/ambient/' + action, { method: 'POST' });
    await refreshJarvisAmbientTile();
  } catch (error) {
    showToast('Ambient ' + action + ' failed: ' + (error.message || error));
  }
}

let _readinessAutoRefreshTimer = null;

function renderReadiness(data) {
  if (_readinessAutoRefreshTimer) { clearTimeout(_readinessAutoRefreshTimer); _readinessAutoRefreshTimer = null; }
  const sections = data.sections || [];
  const ready = sections.filter((section) => section.status === 'ready').length;
  const blocked = sections.filter((section) => section.status === 'blocked').length;
  const warn = sections.filter((section) => section.status === 'warn').length;
  const avg = sections.length ? Math.round(sections.reduce((sum, section) => sum + (section.score || 0), 0) / sections.length) : 0;
  const summary = '<div class="readiness-kpi"><strong>' + avg + '%</strong><span>overall</span></div>'
    + '<div class="readiness-kpi"><strong>' + ready + '/' + sections.length + '</strong><span>ready modes</span></div>'
    + '<div class="readiness-kpi ' + (blocked ? 'blocked' : '') + '"><strong>' + blocked + '</strong><span>blocked</span></div>';
  const compact = document.getElementById('readinessSummary');
  if (compact) compact.innerHTML = summary;
  const panel = document.getElementById('missionControlPanel');
  if (!panel) return;
  const allChecks = sections.flatMap((s) => s.checks || []);
  const permCheck = allChecks.find((c) => c.id === 'permission.mode');
  const firstAttentionCheck = allChecks.find((c) => c.status === 'blocked') || allChecks.find((c) => c.status === 'warn');
  const readinessAction = resolveReadinessAction(firstAttentionCheck);
  const attentionMessage = firstAttentionCheck ? ((firstAttentionCheck.label || 'Check') + ': ' + (firstAttentionCheck.message || 'Needs review')) : '';
  setStatusCenterReadiness({
    blocked,
    warn,
    message: attentionMessage,
    actionLabel: readinessAction.actionLabel,
    actionHandler: readinessAction.actionHandler,
  });
  // Identify fixable blockers for the fix-all button
  const fixableChecks = allChecks.filter((c) => c.status === 'blocked' || c.status === 'warn').filter((c) => {
    if (c.id && c.id.startsWith('tool.')) return true;
    if (c.id === 'permission.mode') return true;
    if (c.id && c.id.includes('.grant')) return true;
    return false;
  });
  window._readinessFixableChecks = fixableChecks;
  const fixBtn = fixableChecks.length > 0 ? ' <button class="btn-sm btn-success-soft" onclick="fixReadinessBlockers()">Fix ' + fixableChecks.length + '</button>'
    + ' <button class="btn-sm btn-warning-soft" onclick="fixReadinessBlockersTimed()">Fix ' + fixableChecks.length + ' (timed)</button>' : '';
  const undoBtn = window._fixAllUndoSnapshot ? ' <button class="btn-sm btn-info-soft" onclick="undoFixAll()">Undo fix-all</button>' : '';
  const headerActions = '<button class="btn-sm" onclick="loadReadiness()">Refresh</button>' + fixBtn + undoBtn;
  panel.innerHTML = renderTaskFirstPanel(data, { avg, ready, total: sections.length, blocked, warn, firstAttentionCheck, headerActions })
    + '<details class="readiness-details" id="readinessDetailsPanel"><summary>Readiness details</summary><div class="readiness-details-body">'
    + '<div class="readiness-summary">' + summary + '</div>'
    + '<div class="mission-grid">' + sections.map(renderReadinessSection).join('') + '</div>'
    + '<div class="mission-prompt-actions"><button class="btn-sm btn-xxs-muted" onclick="exportMissionPrompts()">Export prompts</button> <button class="btn-sm btn-xxs-muted" onclick="importMissionPrompts()">Import</button></div>'
    + '</div></details>'
    + '<details class="advanced-diagnostics" id="advancedDiagnosticsPanel"><summary>Advanced diagnostics <span>Context, safety, and capability details</span></summary><div class="advanced-diagnostics-body">'
    + '<div class="nervous-panel" id="nervousPanel"><div class="readiness-empty">Loading safety details...</div></div>'
    + '<div class="subsystem-health" id="capabilityTemplatePanel"><div class="readiness-empty">Loading capability templates...</div></div>'
    + '<div class="subsystem-health" id="subsystemHealthPanel"><div class="readiness-empty">Loading system health...</div></div>'
    + '</div></details>'
    + '<details class="work-tools-details" id="workToolsPanel"><summary>Work tools</summary><div class="work-tools-body">'
    + '<div class="autonomy-builder" id="autonomyBuilderPanel"><div class="readiness-empty">Loading autonomy plan...</div></div>'
    + '<div class="document-studio" id="documentStudioPanel">' + renderDocumentStudioShell() + '</div>'
    + '</div></details>';
  loadNervousStatus();
  loadCapabilityTemplates();
  loadSubsystemHealth();
  loadAutonomyPlanPreview();
  loadDocuments();
  applyDataWidths(panel);
  // Auto-refresh readiness every 60s when timed autonomy is active
  if (permCheck && permCheck.message && permCheck.message.includes('timed')) {
    _readinessAutoRefreshTimer = setTimeout(() => {
      if (document.getElementById('missionControlPanel')) loadReadiness();
    }, 60_000);
  }
}

function renderTaskFirstPanel(data, summary) {
  const workspace = data.workspace || data.projectDir || 'Current workspace';
  const workspaceParts = String(workspace).split(/[\\/]+/).filter(Boolean);
  const workspaceLabel = workspaceParts.slice(-2).join('/') || workspace;
  const modelLabel = data.model || 'No model selected';
  const readinessClass = summary.blocked ? 'blocked' : summary.warn ? 'warn' : 'ready';
  const readinessLabel = summary.blocked
    ? summary.blocked + ' blocker' + (summary.blocked === 1 ? '' : 's')
    : summary.warn
      ? summary.warn + ' warning' + (summary.warn === 1 ? '' : 's')
      : 'Ready';
  const attention = summary.firstAttentionCheck ? summary.firstAttentionCheck.message : 'Ready to start from a plain-English task.';
  const presets = [
    ['Code', 'Inspect this repo, pick the safest next coding task, make the change, and show me the diff and validation result.'],
    ['Debug', 'Find the most likely cause of the current failure, patch it narrowly, and run the smallest useful validation.'],
    ['Review', 'Review the current changes for bugs, regressions, and missing tests. Lead with findings.'],
    ['Research', 'Research this workspace and summarize the clearest next decision with sources or file references.'],
  ];
  return '<div class="task-first-panel" id="taskFirstPanel">'
    + '<div class="task-first-top"><div><div class="task-first-title">Tell Harness the job</div><div class="task-first-subtitle">' + esc(attention) + '</div></div>'
    + '<div class="task-first-status-col"><div class="task-first-status"><span class="task-first-pill" title="' + escAttr(workspace) + '">' + esc(workspaceLabel) + '</span><span class="task-first-pill">' + esc(modelLabel) + '</span><span class="task-first-pill ' + readinessClass + '">' + esc(readinessLabel) + '</span></div>' + (summary.headerActions ? '<div class="inline-actions">' + summary.headerActions + '</div>' : '') + '</div></div>'
    + '<div class="task-first-input-row"><textarea id="missionTaskInput" placeholder="Example: Fix the failing test, update the report, or review the current changes."></textarea>'
    + '<div class="task-first-actions"><button class="btn-sm primary" id="codexRunTaskBtn" onclick="startCodexTaskFromMission()">Run task</button><button class="btn-sm" onclick="sendTaskFirstPrompt()">Draft chat</button><button class="btn-sm" onclick="openLeftTabByName(\'runs\')">Runs</button></div></div>'
    + '<div class="codex-run-panel hidden-by-default" id="codexRunPanel"><div class="codex-run-top"><strong id="codexRunTitle">Codex task</strong><span id="codexRunStatus">Idle</span></div><div class="codex-run-progress"><div id="codexRunProgressBar"></div></div><div class="codex-run-log" id="codexRunLog"></div><details class="codex-run-diff hidden-by-default" id="codexRunDiffWrap"><summary>Diff preview</summary><pre id="codexRunDiff"></pre></details></div>'
    + renderCodingLoopRail()
    + '<div class="task-first-presets">' + presets.map(([label, prompt]) => '<button class="task-first-preset" onclick="useTaskFirstPreset(\'' + escAttr(prompt) + '\')">' + esc(label) + '</button>').join('') + '</div>'
    + '</div>';
}

function renderCodingLoopRail() {
  const steps = [
    ['Task', 'Plain-English goal'],
    ['Plan', 'Small steps'],
    ['Edit', 'Focused changes'],
    ['Validate', 'Run checks'],
    ['Review', 'Diff and evidence'],
  ];
  return '<details class="readiness-details coding-loop-details"><summary>How a task runs</summary><div class="readiness-details-body">'
    + '<div class="coding-loop-rail" id="codingLoopRail">'
    + steps.map(([title, note]) => '<div class="coding-loop-step"><strong>' + esc(title) + '</strong><span>' + esc(note) + '</span></div>').join('')
    + '</div><div class="coding-loop-action"><button class="btn-sm btn-xxs-muted" onclick="startCodingLoopPrompt()">Use coding loop</button></div>'
    + '</div></details>';
}

function sendTaskFirstPrompt() {
  const taskInput = document.getElementById('missionTaskInput');
  const chatInput = document.getElementById('chatInput');
  if (!chatInput) return;
  const task = String(taskInput?.value || '').trim() || 'Inspect this workspace and recommend the best next useful action.';
  chatInput.value = task;
  autoSize(chatInput);
  chatInput.focus();
}

function useTaskFirstPreset(promptText) {
  const taskInput = document.getElementById('missionTaskInput');
  if (taskInput) taskInput.value = promptText;
  sendTaskFirstPrompt();
}

function startCodingLoopPrompt() {
  const taskInput = document.getElementById('missionTaskInput');
  const currentTask = String(taskInput?.value || '').trim();
  const task = currentTask || 'Pick the safest useful coding task in this repo.';
  useTaskFirstPreset(task + ' Work in this loop: restate the task, make a short plan, edit only the needed files, run the smallest useful validation, then show the diff, evidence, and what needs accepting.');
}

async function startCodexTaskFromMission() {
  if (activeCodexTaskRun) {
    showToast('A Codex task is already running.', 3000, 'info');
    return;
  }
  const taskInput = document.getElementById('missionTaskInput');
  const task = String(taskInput?.value || '').trim() || 'Inspect this workspace and complete the safest useful coding task.';
  const button = document.getElementById('codexRunTaskBtn');
  const panel = ensureCodexRunPanel();
  if (!panel) return;
  const controller = new AbortController();
  activeCodexTaskRun = controller;
  if (button) button.disabled = true;
  updateCodexRunPanel({ title: 'Creating task', status: 'Starting', progressPercent: 2, reset: true });
  try {
    const createResponse = await fetch('/api/codex/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: task }),
      signal: controller.signal,
    });
    const created = await readApiJson(createResponse, 'Codex task create API');
    const taskId = created?.task?.id;
    if (!taskId) throw new Error('Codex task create API did not return a task id.');
    updateCodexRunPanel({ title: created.task.title || task, status: 'Task ' + taskId + ' running', progressPercent: 5 });
    const runResponse = await fetch('/api/codex/tasks/' + encodeURIComponent(taskId) + '/run', { method: 'POST', signal: controller.signal });
    if (!runResponse.ok) {
      if ((runResponse.headers.get('content-type') || '').includes('application/json')) await readApiJson(runResponse, 'Codex task run API');
      throw new Error('Codex task run API failed: ' + runResponse.status + ' ' + runResponse.statusText);
    }
    await readCodexRunStream(runResponse, (event) => handleCodexRunEvent(event));
    await refreshCodexTaskStatus(taskId);
    showToast('Codex task ready for review.', 3000, 'success');
  } catch (error) {
    if (error && error.name === 'AbortError') {
      updateCodexRunPanel({ status: 'Cancelled', log: 'Run cancelled.' });
    } else {
      updateCodexRunPanel({ status: 'Failed', progressPercent: 100, log: error.message || String(error) });
      showToast(error.message || String(error), 6000, 'error');
    }
  } finally {
    activeCodexTaskRun = null;
    if (button) button.disabled = false;
  }
}

function ensureCodexRunPanel() {
  const panel = document.getElementById('codexRunPanel');
  if (panel) panel.classList.remove('hidden-by-default');
  return panel;
}

function updateCodexRunPanel(update) {
  const panel = ensureCodexRunPanel();
  if (!panel) return;
  const title = document.getElementById('codexRunTitle');
  const status = document.getElementById('codexRunStatus');
  const progressBar = document.getElementById('codexRunProgressBar');
  const log = document.getElementById('codexRunLog');
  const diffWrap = document.getElementById('codexRunDiffWrap');
  const diff = document.getElementById('codexRunDiff');
  if (update.reset && log) log.innerHTML = '';
  if (update.reset && diff) diff.textContent = '';
  if (update.reset && diffWrap) diffWrap.classList.add('hidden-by-default');
  if (update.title && title) title.textContent = update.title;
  if (update.status && status) status.textContent = update.status;
  if (typeof update.progressPercent === 'number' && progressBar) progressBar.style.width = Math.max(0, Math.min(100, update.progressPercent)) + '%';
  if (update.log && log) {
    const row = document.createElement('div');
    row.textContent = update.log;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  if (typeof update.diff === 'string' && diff && diffWrap) {
    diff.textContent = update.diff || 'No diff reported.';
    diffWrap.classList.remove('hidden-by-default');
  }
}

async function readCodexRunStream(response, onEvent) {
  const reader = response.body?.getReader ? response.body.getReader() : null;
  if (!reader) throw new Error('Codex task run API did not return a readable stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let splitAt;
    while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const dataLines = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') return;
      try { onEvent(JSON.parse(data)); } catch { onEvent({ type: 'log', message: data }); }
    }
    if (done) break;
  }
}

function handleCodexRunEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'task_status') {
    updateCodexRunPanel({ status: String(event.status || 'Running'), progressPercent: Number(event.progressPercent || 10) });
  } else if (event.type === 'model') {
    updateCodexRunPanel({ log: 'Model: ' + event.model });
  } else if (event.type === 'plan') {
    const steps = Array.isArray(event.plan?.steps) ? event.plan.steps.length : 0;
    updateCodexRunPanel({ status: 'Plan ready', progressPercent: 15, log: steps ? 'Plan ready: ' + steps + ' step(s).' : 'Plan ready.' });
  } else if (event.type === 'step_start') {
    const index = Number(event.index || 0) + 1;
    const total = Number(event.total || index);
    const pct = Math.min(85, 15 + Math.round((index / Math.max(total, 1)) * 60));
    updateCodexRunPanel({ status: 'Step ' + index + ' of ' + total, progressPercent: pct, log: event.step?.intent || 'Running step ' + index + '.' });
  } else if (event.type === 'verify') {
    updateCodexRunPanel({ status: 'Validating', progressPercent: 86, log: 'Validation: ' + (event.result?.overall || 'complete') });
  } else if (event.type === 'capability_gap') {
    updateCodexRunPanel({ log: 'Capability needed: ' + (event.gap?.need || 'unknown') });
  } else if (event.type === 'run_result') {
    const diffText = event.diff?.patchPreview || event.diff?.stat || '';
    updateCodexRunPanel({ status: 'Review ready', progressPercent: 95, log: 'Run ended: ' + (event.result?.status || 'done'), diff: diffText });
  } else if (event.type === 'error') {
    updateCodexRunPanel({ status: 'Failed', progressPercent: 100, log: event.message || 'Run failed.' });
  } else if (event.type === 'done') {
    updateCodexRunPanel({ status: 'Done', progressPercent: 100 });
  }
}

async function refreshCodexTaskStatus(taskId) {
  const response = await fetch('/api/codex/tasks/' + encodeURIComponent(taskId) + '/status');
  const data = await readApiJson(response, 'Codex task status API');
  const status = data?.task?.status || 'unknown';
  const progressPercent = typeof data?.task?.progressPercent === 'number' ? data.task.progressPercent : undefined;
  const diffText = data?.diff?.patchPreview || data?.diff?.stat || '';
  updateCodexRunPanel({ status: 'Task status: ' + status, progressPercent, diff: diffText });
  loadReadiness();
}

function renderReadinessSection(section) {
  const checks = section.checks || [];
  const firstBlocked = checks.find((check) => check.status === 'blocked') || checks.find((check) => check.status === 'warn');
  const noteAction = firstBlocked && firstBlocked.action === 'Open Settings' ? ' onclick="toggleRight()"' : firstBlocked && firstBlocked.action === 'Open Tools' ? ' onclick="openLeftTabByName(\'tools\')"' : firstBlocked && firstBlocked.action === 'Open Promises' ? ' onclick="openLeftTabByName(\'promises\')"' : '';
  const noteClass = noteAction ? 'mission-note clickable-dotted' : 'mission-note';
  const readyCount = checks.filter((c) => c.status === 'ready').length;
  const checkCountClass = readyCount === checks.length ? 'readiness-ready' : readyCount === 0 ? 'readiness-none' : 'readiness-some';
  const checkRows = checks.length > 1 ? '<details class="details-mt4"><summary class="trace-meta trace-summary-xs"><span class="' + checkCountClass + '">' + readyCount + '/' + checks.length + ' ready</span></summary>'
    + checks.map((c) => {
      const icon = c.status === 'ready' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
      const actionAttr = c.action === 'Open Settings' ? ' onclick="toggleRight()"' : c.action === 'Open Tools' ? ' onclick="openLeftTabByName(\'tools\')"' : '';
      const rowClass = actionAttr ? 'trace-meta trace-meta-xs-row clickable-dotted' : 'trace-meta trace-meta-xs-row';
      let actionBtn = '';
      if (c.status !== 'ready') {
        if (c.id && c.id.startsWith('tool.') && c.status === 'blocked') {
          const toolName = c.id.replace('tool.', '');
          actionBtn = ' <button class="btn-sm btn-xxs" onclick="event.stopPropagation();toggleTool(\'' + escAttr(toolName) + '\',true).then(function(){loadReadiness()})">Enable</button>'
            + ' <button class="btn-sm btn-xxs-warning" onclick="event.stopPropagation();readinessTimedFix(\'tool\',\'' + escAttr(toolName) + '\')">⏱</button>';
        } else if (c.id === 'model.toolCalling') {
          actionBtn = ' <button class="btn-sm btn-xxs" onclick="event.stopPropagation();probeModelTools()">Probe</button>';
        } else if (c.id === 'permission.mode') {
          actionBtn = ' <button class="btn-sm btn-xxs" onclick="event.stopPropagation();setMode(\'dontAsk\',document.querySelectorAll(\'.permission-mode-option\')[0]);setTimeout(loadReadiness,500)">Set dontAsk</button>'
            + ' <button class="btn-sm btn-xxs-warning" onclick="event.stopPropagation();readinessTimedFix(\'mode\')">⏱</button>';
        } else if (c.id && c.id.includes('.grant') && c.status !== 'ready') {
          const capId = c.id === 'shell.grant' ? 'arbitrary-shell' : c.id === 'background.autonomy.grant' || c.id === 'background.grant' ? 'background-autonomous-jobs' : c.id === 'self.modify.grant' ? 'self-modifying-code' : '';
          if (capId) actionBtn = ' <button class="btn-sm btn-xxs" onclick="event.stopPropagation();grantCapability(\'' + escAttr(capId) + '\').then(function(){loadReadiness()})">Grant</button>';
        }
      }
      return '<div class="' + rowClass + '"' + actionAttr + '><span>' + icon + ' ' + esc(c.label) + ': ' + esc(c.message) + '</span>' + actionBtn + '</div>';
    }).join('') + '</details>' : '';
  return '<div class="mission-card ' + escAttr(section.status) + '">'
    + '<div class="mission-card-top"><strong>' + esc(section.label) + '</strong><span>' + esc(section.score) + '%</span></div>'
    + '<div class="mission-meter"><span data-width-pct="' + Math.max(0, Math.min(100, section.score || 0)) + '"></span></div>'
    + '<div class="' + noteClass + '"' + noteAction + '>' + esc(firstBlocked ? firstBlocked.message : 'Ready for this mode.') + '</div>'
    + checkRows
    + '<div class="inline-actions top-spaced"><button class="btn-sm" onclick="sendMissionPrompt(\'' + escAttr(section.id) + '\')">Start</button> <button class="btn-sm btn-xxs-subtle" onclick="editMissionPrompt(\'' + escAttr(section.id) + '\')">✏️</button></div>'
    + '</div>';
}

function applyDataWidths(root) {
  (root || document).querySelectorAll('[data-width-pct]').forEach((element) => {
    element.style.width = Math.max(0, Math.min(100, Number(element.getAttribute('data-width-pct')) || 0)) + '%';
  });
}

function applyDataIndents(root) {
  (root || document).querySelectorAll('[data-indent-depth]').forEach((element) => {
    element.style.paddingLeft = Math.max(0, Number(element.getAttribute('data-indent-depth')) || 0) * 14 + 'px';
  });
}

const DEFAULT_MISSION_PROMPTS = {
  chat: 'Start a clean chat and ask one clarifying question before acting.',
  coding: 'Inspect the current repo and suggest the safest next code-hardening task.',
  research: 'Research the current project docs and summarize the most important next decision.',
  automation: 'Review configured automations and report which ones are due or risky.',
  autonomy: 'Inspect IMPLEMENTATION_PLAN.md and propose the next autonomous run plan without starting it.',
};
let customMissionPrompts = {};

function sendMissionPrompt(mode) {
  const prompts = { ...DEFAULT_MISSION_PROMPTS, ...customMissionPrompts };
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = prompts[mode] || 'Help me choose the best Harness mode for this task.';
  autoSize(input);
  input.focus();
}

// Wrap localStorage writes so a single quota-exceeded failure surfaces a
// user-visible toast instead of silently dropping changes.
function safeLocalStorageSet(key, value, label) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    try { showToast('⚠️ Could not save ' + (label || key) + ': ' + (e && e.message ? e.message : 'storage error'), 4000, 'warning'); } catch(_){}
    return false;
  }
}
if (typeof window !== 'undefined') {
  window.safeLocalStorageSet = safeLocalStorageSet;
}

async function editMissionPrompt(mode) {
  const prompts = { ...DEFAULT_MISSION_PROMPTS, ...customMissionPrompts };
  const current = prompts[mode] || '';
  const updated = await promptToast('Edit ' + mode + ' prompt:', current);
  if (updated === null) return;
  if (updated.trim() === '' || updated === DEFAULT_MISSION_PROMPTS[mode]) {
    delete customMissionPrompts[mode];
  } else {
    customMissionPrompts[mode] = updated;
  }
  try { localStorage.setItem('harness_mission_prompts', JSON.stringify(customMissionPrompts)); } catch(e){ try { showToast('⚠️ Mission prompt save failed: ' + (e && e.message ? e.message : 'storage error'), 4000, 'warning'); } catch(_){} }
  showToast('Mission prompt updated for ' + mode, 2000, 'success');
}

// Load custom prompts from localStorage on init
try { customMissionPrompts = JSON.parse(localStorage.getItem('harness_mission_prompts') || '{}'); } catch(e){ customMissionPrompts = {}; }

function exportMissionPrompts() {
  const prompts = { ...DEFAULT_MISSION_PROMPTS, ...customMissionPrompts };
  navigator.clipboard.writeText(JSON.stringify(prompts, null, 2))
    .then(() => showToast('Mission prompts copied to clipboard', 2000, 'success'))
    .catch(() => showToast('Export failed', 2000, 'error'));
}

async function importMissionPrompts() {
  const raw = await promptToast('Paste mission prompts JSON:');
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Must be an object');
    customMissionPrompts = {};
    for (const [mode, text] of Object.entries(parsed)) {
      if (typeof text === 'string' && text.trim() && text !== DEFAULT_MISSION_PROMPTS[mode]) {
        customMissionPrompts[mode] = text;
      }
    }
    localStorage.setItem('harness_mission_prompts', JSON.stringify(customMissionPrompts));
    showToast('Imported ' + Object.keys(customMissionPrompts).length + ' custom prompt(s)', 2000, 'success');
    loadReadiness();
  } catch (e) { showToast('Import failed: ' + (e.message || e), 3000, 'error'); }
}

window._readinessFixableChecks = [];
// Actively verify whether the selected model can call tools, then refresh
// readiness so the measured verdict replaces the static heuristic. Explicit
// user action — never auto-run — so cloud models are not probed unprompted.
async function probeModelTools() {
  showToast('Probing model tool-calling…', 2500, 'info');
  try {
    const response = await fetch('/api/model/probe-tools', { method: 'POST' });
    const data = await readApiJson(response, 'Tool-calling probe');
    const tone = data.verdict === 'verified' ? 'success' : data.verdict === 'failed' ? 'warning' : 'info';
    showToast(data.message || ('Probe ' + (data.verdict || 'finished') + '.'), 6000, tone);
  } catch (error) {
    showToast('Probe failed: ' + (error.message || error), 5000, 'warning');
  }
  await loadReadiness();
}

async function fixReadinessBlockers(timedMinutes) {
  const checks = window._readinessFixableChecks || [];
  if (checks.length === 0) return;
  const label = timedMinutes ? 'Auto-fix ' + checks.length + ' blocker(s) for ' + timedMinutes + ' minutes?' : 'Auto-fix ' + checks.length + ' blocker(s)?';
  if (!await confirmToast(label + '\n\nThis will enable disabled tools, set dontAsk mode, and grant missing capabilities.')) return;
  // Snapshot pre-fix state for undo
  window._fixAllUndoSnapshot = await snapshotPreFixState();
  try { sessionStorage.setItem('harness_fixall_undo', JSON.stringify(window._fixAllUndoSnapshot)); } catch(e){}
  for (const c of checks) {
    if (c.id && c.id.startsWith('tool.')) {
      const toolName = c.id.replace('tool.', '');
      const body = timedMinutes ? { enabled: true, expiresInMinutes: timedMinutes } : { enabled: true };
      await fetch('/api/tools/' + encodeURIComponent(toolName) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    } else if (c.id === 'permission.mode') {
      if (timedMinutes) {
        await fetch('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInMinutes: timedMinutes, reason: 'Readiness fix-all escalation to dontAsk mode' }) }).catch(() => {});
      } else {
        await updateSetting('permissionMode', 'dontAsk', { reason: 'Readiness fix-all escalation to dontAsk mode' });
      }
      document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
      const dontAskOpt = document.querySelectorAll('.permission-mode-option')[0];
      if (dontAskOpt) dontAskOpt.classList.add('active');
    } else if (c.id && c.id.includes('.grant')) {
      const capMap = { 'shell.grant': 'arbitrary-shell', 'background.autonomy.grant': 'background-autonomous-jobs', 'background.grant': 'background-autonomous-jobs', 'self.modify.grant': 'self-modifying-code' };
      const capId = capMap[c.id];
      if (capId) {
        const caps = await fetch('/api/capabilities').then((r) => r.json()).catch(() => null);
        const item = caps && (caps.capabilities || []).find((cap) => cap.id === capId);
        if (item && item.posture === 'gated') {
          await fetch('/api/capabilities/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilityId: capId, controls: item.requiredControls || [], reason: timedMinutes ? 'Auto-granted (timed) from readiness fix-all' : 'Auto-granted from readiness fix-all', expiresInMinutes: timedMinutes || 480 }) }).catch(() => {});
        }
      }
    }
  }
  showToast('Fixed ' + checks.length + ' blocker(s)' + (timedMinutes ? ' for ' + timedMinutes + 'm' : '') + '. Refreshing...', 3000, 'success');
  await loadReadiness();
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
  refreshAutonomyBanner();
}

async function fixReadinessBlockersTimed() {
  const minutesRaw = await promptToast('Fix blockers for how many minutes? (1-1440)', '120');
  if (minutesRaw === null) return;
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) { showToast('Enter a number between 1 and 1440.'); return; }
  await fixReadinessBlockers(minutes);
}

async function readinessTimedFix(type, name) {
  const minutesRaw = await promptToast('Enable for how many minutes? (1-1440)', '60');
  if (minutesRaw === null) return;
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) { showToast('Enter a number between 1 and 1440.'); return; }
  if (type === 'tool') {
    await toggleTool(name, true, minutes);
  } else if (type === 'mode') {
    await fetch('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInMinutes: minutes, reason: 'Readiness timed fix escalation to dontAsk mode' }) }).catch(() => {});
    document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
    const dontAskOpt = document.querySelectorAll('.permission-mode-option')[0];
    if (dontAskOpt) dontAskOpt.classList.add('active');
    refreshAutonomyBanner();
  }
  await loadReadiness();
}

// Restore undo snapshot from sessionStorage
try { window._fixAllUndoSnapshot = JSON.parse(sessionStorage.getItem('harness_fixall_undo') || 'null'); } catch(e){ window._fixAllUndoSnapshot = null; }
async function snapshotPreFixState() {
  try {
    const [toolsR, settingsR, grantsR] = await Promise.all([
      fetch('/api/tools').then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/capabilities').then((r) => r.json()),
    ]);
    return {
      disabledTools: toolsR.disabled || [],
      permissionMode: settingsR.permissionMode || 'default',
      grantIds: ((grantsR.capabilities || []).flatMap((c) => c.id ? [c.id] : [])),
      activeGrantIds: ((grantsR.grants || []).map((g) => g.id)),
      ts: Date.now(),
    };
  } catch(e){ return null; }
}

async function undoFixAll() {
  const snap = window._fixAllUndoSnapshot;
  if (!snap) { showToast('No fix-all to undo', 2000); return; }
  if (!await confirmToast('Undo last fix-all?\n\nThis will re-disable tools and revert permission mode to ' + snap.permissionMode + '.')) return;
  // Re-disable tools
  for (const name of snap.disabledTools) {
    await fetch('/api/tools/' + encodeURIComponent(name) + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
  }
  // Revert permission mode
  await updateSetting(
    'permissionMode',
    snap.permissionMode,
    snap.permissionMode === 'dontAsk' ? { reason: 'Undo fix-all restored previous dontAsk mode' } : undefined,
  );
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  const mi = snap.permissionMode === 'dontAsk' ? 0 : snap.permissionMode === 'acceptEdits' ? 1 : 2;
  const mo = document.querySelectorAll('.permission-mode-option')[mi];
  if (mo) mo.classList.add('active');
  // Clear timed autonomy if it was set by fix-all
  await fetch('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
  window._fixAllUndoSnapshot = null;
  try { sessionStorage.removeItem('harness_fixall_undo'); } catch(e){}
  showToast('Reverted fix-all. Mode: ' + snap.permissionMode + ', ' + snap.disabledTools.length + ' tool(s) re-disabled.', 4000, 'info');
  await loadReadiness();
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
  refreshAutonomyBanner();
}

async function loadNervousStatus() {
  const panel = document.getElementById('nervousPanel');
  if (!panel) return;
  try {
    const response = await fetch('/api/nervous');
    const data = await readApiJson(response, 'Nervous system API');
    const summary = data.summary || {};
    const signals = data.signals || [];
    const recentHigh = signals.filter((s) => s.severity === 'high' || s.severity === 'critical');
    const reflexes = summary.activeReflexes || [];
    const risk = summary.riskLevel || 'low';
    const riskClass = risk === 'critical' ? 'risk-critical' : risk === 'high' ? 'risk-high' : risk === 'medium' ? 'risk-medium' : 'risk-low';
    const bypassNote = data.verificationBypassActive ? '<div class="trace-meta trace-meta-sm-top trace-meta-success">Keep going is active: verifier/recovery gates will not block writes.</div>' : '';
    panel.innerHTML = '<div class="autonomy-head"><div><strong>🧠 Nervous System</strong>'
      + '<span class="' + riskClass + '">' + esc(risk) + ' risk · ' + esc(signals.length) + ' signals · ' + esc(reflexes.length) + ' reflexes</span></div>'
      + '<button class="btn-sm" onclick="loadNervousStatus()">Refresh</button></div>'
      + bypassNote
      + (reflexes.length > 0 ? '<div class="autonomy-task-list">' + reflexes.map((r) => '<div class="autonomy-task"><strong>⚡ ' + esc(r) + '</strong></div>').join('') + '</div>' : '')
      + (recentHigh.length > 0 ? '<details class="details-mt4"><summary class="trace-meta trace-summary-sm">⚠️ Recent high-severity signals (' + recentHigh.length + ')</summary>'
        + recentHigh.slice(-5).map((s) => '<div class="trace-meta trace-meta-sm ' + (s.severity === 'critical' ? 'trace-meta-error' : 'trace-meta-warning') + '">' + esc(s.type) + ': ' + esc(s.message) + '</div>').join('')
        + '</details>' : '')
      + (summary.safetyNotes && summary.safetyNotes.length > 0 ? '<div class="trace-meta trace-meta-sm-top">' + summary.safetyNotes.map((n) => '🛡 ' + esc(n)).join('<br>') + '</div>' : '')
      + (data.recovery ? '<div class="trace-meta trace-meta-sm-top trace-meta-error">⚠️ Recovery: ' + esc(data.recovery.reason) + ' → ' + esc(data.recovery.safeNextAction) + '</div>' : '');
  } catch (error) {
    panel.innerHTML = '<div class="readiness-empty">Nervous system: ' + esc(error.message || error) + '</div>';
  }
}

async function loadAutonomyPlanPreview() {
  const panel = document.getElementById('autonomyBuilderPanel');
  if (!panel) return;
  try {
    const response = await fetch('/api/autonomy/plan-preview');
    const data = await readApiJson(response, 'Autonomy plan preview API');
    panel.innerHTML = renderAutonomyBuilder(data);
  } catch (error) {
    panel.innerHTML = '<div class="readiness-empty">Autonomy plan unavailable: ' + esc(error.message || error) + '</div>';
  }
}

// Unified inbox strip: aggregates pending permission prompts, queued plan
// tasks, and recent automation runs into one glanceable summary above the
// chat. Hidden when empty so it never nags. Fetches /api/inbox; failure
// logs to console but does not surface — the inbox is enrichment, not
// primary functionality.
const INBOX_KIND_META = {
  permission:     { icon: '🔔', tone: 'high' },
  plan_task:      { icon: '📋', tone: 'med' },
  automation_run: { icon: '⚙', tone: 'med' },
};

// Topbar pet — small expressive avatar that mirrors the system's actual
// state. Reads existing UI signals (isSending, last tool call time, the
// inbox strip, idle time) so it stays honest and adds zero new backend
// surface. The state machine runs on a 2s interval and only mutates the
// avatar when the resolved state changes, so it's free in the common
// "nothing happening" case. Signals live on a window-scoped object so
// smoke tests can override them deterministically.
window._petSignals = window._petSignals || { lastUserActivityAt: Date.now(), lastToolCallAt: 0, lastErrorAt: 0 };
window._petLastState = window._petLastState || '';

function noteUserActivity() { window._petSignals.lastUserActivityAt = Date.now(); }
function notePetToolCall() { window._petSignals.lastToolCallAt = Date.now(); }
function notePetError() { window._petSignals.lastErrorAt = Date.now(); }

const PET_FACES = {
  working:   { emoji: '🛠',  cls: 'pet-working',   title: 'Running tools…' },
  thinking:  { emoji: '🤔', cls: 'pet-thinking',  title: 'Thinking…' },
  concerned: { emoji: '😟', cls: 'pet-concerned', title: 'Last turn hit an error.' },
  alert:     { emoji: '👀', cls: 'pet-alert',     title: 'Inbox has things waiting on you.' },
  sleepy:    { emoji: '😴', cls: 'pet-sleepy',    title: 'Idle. Send a message any time.' },
  happy:     { emoji: '😊', cls: 'pet-happy',     title: 'Welcome back!' },
  idle:      { emoji: '🤖', cls: 'pet-idle',      title: 'Ready when you are.' },
};

function resolvePetState() {
  const sig = window._petSignals;
  const now = Date.now();
  // isSending lives in module scope; mirror it onto the signal object
  // each tick so smoke tests can also force "working" via window.
  const sending = (typeof window.isSending === 'boolean') ? window.isSending
    : (typeof isSending !== 'undefined' && isSending);
  if (sending) {
    return now - sig.lastToolCallAt < 8_000 ? 'working' : 'thinking';
  }
  if (now - sig.lastErrorAt < 6_000) return 'concerned';
  const inbox = document.getElementById('inboxStrip');
  if (inbox && !inbox.classList.contains('initial-hidden') && inbox.querySelector('.inbox-item')) {
    return 'alert';
  }
  const idleMs = now - sig.lastUserActivityAt;
  if (idleMs > 120_000) return 'sleepy';
  if (idleMs < 1_500 && window._petLastState === 'sleepy') return 'happy';
  return 'idle';
}

function updateTopbarPet() {
  const el = document.getElementById('topbarPet');
  if (!el) return;
  const state = resolvePetState();
  if (state === window._petLastState) return;
  const face = PET_FACES[state] || PET_FACES.idle;
  // Reset any prior pet-* classes without clobbering siblings.
  el.classList.remove('pet-idle', 'pet-thinking', 'pet-working', 'pet-alert', 'pet-sleepy', 'pet-happy', 'pet-concerned');
  el.classList.add(face.cls);
  el.textContent = face.emoji;
  el.title = 'Harness mood: ' + face.title;
  window._petLastState = state;
}

let _topbarPetTimer = null;
function startTopbarPet() {
  // Activity hooks: any keystroke or mouse movement counts as a sign of
  // life so the pet wakes up promptly when the user comes back.
  document.addEventListener('keydown', noteUserActivity, { passive: true });
  document.addEventListener('mousemove', noteUserActivity, { passive: true });
  document.addEventListener('click', noteUserActivity, { passive: true });
  if (_topbarPetTimer) { clearInterval(_topbarPetTimer); }
  _topbarPetTimer = setInterval(updateTopbarPet, 2_000);
  updateTopbarPet();
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try {
      if (_topbarPetTimer) { clearInterval(_topbarPetTimer); _topbarPetTimer = null; }
      document.removeEventListener('keydown', noteUserActivity);
      document.removeEventListener('mousemove', noteUserActivity);
      document.removeEventListener('click', noteUserActivity);
    } catch(_) {}
  });
}

async function loadInbox() {
  const host = document.getElementById('inboxStrip');
  if (!host) return;
  let payload;
  try {
    const res = await fetch('/api/inbox');
    if (!res.ok) { hideInboxStrip(host); return; }
    payload = await res.json();
  } catch(e){ hideInboxStrip(host); return; }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) { hideInboxStrip(host); return; }
  renderInboxStrip(host, items, payload.total ?? items.length);
}

function hideInboxStrip(host) {
  host.classList.add('initial-hidden');
  host.innerHTML = '';
}

function renderInboxStrip(host, items, total) {
  host.classList.remove('initial-hidden');
  const collapsed = (() => {
    try { return localStorage.getItem('inboxStripCollapsed') === '1'; } catch(e){ return false; }
  })();
  const tagline = items.length === 1 ? 'thing needs you' : 'things need you';
  const moreNote = total > items.length ? ` (showing ${items.length} of ${total})` : '';
  const cardsHtml = items.map((item) => {
    const meta = INBOX_KIND_META[item.kind] || { icon: '•', tone: 'med' };
    const cls = 'inbox-item' + (meta.tone === 'high' ? ' priority-high' : '');
    return '<div class="' + cls + '" data-id="' + escAttr(item.id) + '" data-kind="' + escAttr(item.kind) + '" title="' + escAttr(item.detail || '') + '">'
      + '<div class="inbox-row"><span class="inbox-kind-icon">' + meta.icon + '</span><span class="inbox-title">' + esc(item.title) + '</span></div>'
      + (item.detail ? '<div class="inbox-detail">' + esc(item.detail) + '</div>' : '')
      + inboxActionsHtml(item)
      + '</div>';
  }).join('');
  host.innerHTML = ''
    + '<div class="inbox-strip-summary">'
    + '<span class="inbox-icon">📥</span>'
    + '<span><span class="inbox-count">' + items.length + '</span> ' + esc(tagline) + esc(moreNote) + '</span>'
    + '<span class="inbox-tagline">Pending decisions, queued tasks, and recent automation runs.</span>'
    + '<button type="button" class="inbox-toggle" id="inboxStripToggle">' + (collapsed ? 'Show' : 'Hide') + '</button>'
    + '</div>'
    + '<div class="inbox-strip-list' + (collapsed ? ' collapsed' : '') + '" id="inboxStripList">' + cardsHtml + '</div>';
  const toggleBtn = document.getElementById('inboxStripToggle');
  if (toggleBtn) toggleBtn.onclick = () => toggleInboxStrip();
  // Wire each card's inline action buttons. Cards are no longer
  // whole-card clickable — every verb is an explicit button so the user
  // never has to guess "what now" after a navigation. Action handlers
  // call the matching server endpoint, toast the outcome, and refresh
  // the inbox so resolved items vanish immediately.
  for (const btn of host.querySelectorAll('.inbox-action-btn[data-action]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const cardId = btn.getAttribute('data-card-id') || '';
      handleInboxAction(action, cardId, btn).catch((err) => {
        try { showToast('⚠️ ' + (err?.message || err), 3500, 'warning'); } catch(_){}
      });
    });
  }
}

// Per-kind action row. Returns HTML for the buttons that should appear
// underneath the card body. Each button carries data-action and the
// card's full id so handleInboxAction can route without re-finding the
// item. Verbs picked for "what would the user actually want to DO with
// this?" rather than "where could we send them to think about it?".
function inboxActionsHtml(item) {
  const cardId = escAttr(item.id);
  if (item.kind === 'permission') {
    return '<div class="inbox-actions">'
      + '<button type="button" class="inbox-action-btn primary" data-action="permission_allow" data-card-id="' + cardId + '">✓ Approve</button>'
      + '<button type="button" class="inbox-action-btn danger" data-action="permission_deny" data-card-id="' + cardId + '">✕ Deny</button>'
      + '<button type="button" class="inbox-action-btn" data-action="open_tools" data-card-id="' + cardId + '">Open Tools</button>'
      + '</div>';
  }
  if (item.kind === 'plan_task') {
    return '<div class="inbox-actions">'
      + '<button type="button" class="inbox-action-btn primary" data-action="task_complete" data-card-id="' + cardId + '">✓ Mark done</button>'
      + '<button type="button" class="inbox-action-btn danger" data-action="task_delete" data-card-id="' + cardId + '">✕ Delete</button>'
      + '<button type="button" class="inbox-action-btn" data-action="open_autonomy" data-card-id="' + cardId + '">Open Plan</button>'
      + '</div>';
  }
  if (item.kind === 'automation_run') {
    return '<div class="inbox-actions">'
      + '<button type="button" class="inbox-action-btn" data-action="open_runs" data-card-id="' + cardId + '">View in Runs</button>'
      + '</div>';
  }
  return '';
}

async function handleInboxAction(action, cardId, btn) {
  // cardId encodes both the kind prefix and the resource id, e.g.
  // "plan_task:abc-123" or "automation_run:job-7:2026-06-06T...".
  // Strip the first segment to get the underlying resource id.
  const colonAt = cardId.indexOf(':');
  const resourceId = colonAt >= 0 ? cardId.slice(colonAt + 1) : cardId;
  const setBusy = (busy) => { try { btn.disabled = busy; } catch(_){} };
  setBusy(true);
  try {
    if (action === 'permission_allow' || action === 'permission_deny') {
      const allowed = action === 'permission_allow';
      const res = await fetch('/api/permissions/' + encodeURIComponent(resourceId) + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed }),
      });
      if (!res.ok) throw new Error((await res.text()) || 'Permission resolve failed');
      showToast(allowed ? '✓ Approved' : '✕ Denied', 2200, 'success');
    } else if (action === 'task_complete') {
      const res = await fetch('/api/autonomy/tasks/' + encodeURIComponent(resourceId) + '/complete', { method: 'POST' });
      if (!res.ok) throw new Error((await res.text()) || 'Mark done failed');
      showToast('✓ Task marked done', 2200, 'success');
    } else if (action === 'task_delete') {
      if (!confirm('Delete this task from IMPLEMENTATION_PLAN.md?')) { setBusy(false); return; }
      const res = await fetch('/api/autonomy/tasks/' + encodeURIComponent(resourceId), { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.text()) || 'Delete failed');
      showToast('✕ Task deleted', 2200, 'success');
    } else if (action === 'open_tools') {
      openLeftTabByName('tools');
    } else if (action === 'open_autonomy') {
      openLeftTabByName('autonomy');
    } else if (action === 'open_runs') {
      openLeftTabByName('runs');
    }
  } finally {
    setBusy(false);
    // Refresh the inbox after any mutation so resolved/completed/deleted
    // items disappear. Cheap because /api/inbox is just an aggregator.
    if (action !== 'open_tools' && action !== 'open_autonomy' && action !== 'open_runs') {
      try { await loadInbox(); } catch(_){}
    }
  }
}

function toggleInboxStrip() {
  const list = document.getElementById('inboxStripList');
  const btn = document.getElementById('inboxStripToggle');
  if (!list || !btn) return;
  const willCollapse = !list.classList.contains('collapsed');
  list.classList.toggle('collapsed', willCollapse);
  btn.textContent = willCollapse ? 'Show' : 'Hide';
  try { localStorage.setItem('inboxStripCollapsed', willCollapse ? '1' : '0'); } catch(e){ try { showToast('⚠️ Could not remember inbox state', 2500, 'warning'); } catch(_){} }
}

async function loadSubsystemHealth() {
  const panel = document.getElementById('subsystemHealthPanel');
  if (!panel) return;
  try {
    const response = await fetch('/api/subsystems/health');
    const data = await response.json();
    const subs = data.subsystems || {};
    const overallIcon = data.overall === 'healthy' ? '💚' : '🟡';
    const rows = Object.entries(subs).map(([name, info]) => {
      const s = info;
      const icon = s.status === 'healthy' ? '✅' : s.status === 'empty' ? '🔲' : s.status === 'not_built' ? '🔲' : s.status === 'warning' ? '⚠️' : '❓';
      const detail = s.message || (s.total !== undefined ? s.total + ' total' : s.count !== undefined ? s.count + ' configured' : s.files !== undefined ? s.files + ' files' : s.status);
      return '<div class="trace-meta trace-meta-xs-row"><span>' + icon + ' ' + esc(name.replace(/_/g, ' ')) + '</span><span style="opacity:0.6">' + esc(String(detail).slice(0, 60)) + '</span></div>';
    }).join('');
    panel.innerHTML = '<div class="autonomy-head"><div><strong>' + overallIcon + ' Subsystem Health</strong>'
      + '<span style="opacity:0.6">' + esc(data.overall || 'unknown') + '</span></div>'
      + '<button class="btn-sm" onclick="loadSubsystemHealth()">Refresh</button></div>'
      + rows;
  } catch (error) {
    panel.innerHTML = '<div class="readiness-empty">Subsystem health unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function loadCapabilityTemplates() {
  const panel = document.getElementById('capabilityTemplatePanel');
  if (!panel) return;
  try {
    const response = await fetch('/api/capability-templates');
    const data = await readApiJson(response, 'Capability templates API');
    const templates = (data.templates || []).slice(0, 6);
    const rows = templates.map((template) => {
      const icon = template.status === 'ready' ? '✅' : template.status === 'partial' ? '⚠️' : '❌';
      const missing = (template.missingCapabilities || []).concat(template.missingConnectors || []).slice(0, 3).join(', ');
      const starters = (template.starterKinds || []).length ? 'starter: ' + template.starterKinds.join(', ') : '';
      const action = (template.hasStarter || (template.starterKinds || []).length > 0) ? '<button class="btn-xs" onclick="loadCapabilityTemplateStarterDetail(\'' + escAttr(template.id) + '\')">Details</button>' : '';
      return '<div class="trace-meta trace-meta-xs-row"><span>' + icon + ' ' + esc(template.title) + ' <span style="opacity:0.55">' + esc(template.readinessScore) + '%</span></span><span style="opacity:0.68">' + esc(starters || missing || template.nextAction || 'ready') + ' ' + action + '</span></div>';
    }).join('');
    const ready = templates.filter((template) => template.status === 'ready').length;
    panel.innerHTML = '<div class="autonomy-head"><div><strong>Capability Templates</strong><span>' + esc(ready) + '/' + esc(templates.length) + ' ready · OpenClaw-style closure map</span></div><button class="btn-sm" onclick="loadCapabilityTemplates()">Refresh</button></div>'
      + (rows || '<div class="readiness-empty">No templates available.</div>')
      + '<div id="capabilityTemplateDetail" class="first-run-status">Select Details to preview a starter before creating it.</div>';
  } catch (error) {
    panel.innerHTML = '<div class="readiness-empty">Capability templates unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function loadCapabilityTemplateStarterDetail(templateId) {
  const detail = document.getElementById('capabilityTemplateDetail');
  if (!detail) return;
  detail.textContent = 'Loading starter preview...';
  try {
    const response = await fetch('/api/capability-templates/' + encodeURIComponent(templateId) + '/starter');
    const data = await readApiJson(response, 'Capability starter API');
    const starter = data.starter || {};
    const artifactHtml = (starter.artifacts || []).map((artifact) => '<li><strong>' + esc(artifact.label || artifact.type || 'Artifact') + '</strong>: ' + esc(artifact.path || '') + '</li>').join('');
    const triggerHtml = (starter.triggerContracts || []).map((trigger) => '<li><strong>' + esc(trigger.mode || 'trigger') + '</strong>: ' + esc(trigger.source || '') + ' <span style="opacity:0.65">' + esc(trigger.status || '') + '</span></li>').join('');
    const payload = starter.document || starter.automationJob || {};
    detail.innerHTML = '<div><strong>' + esc(starter.title || templateId) + '</strong> <span style="opacity:0.65">' + esc(starter.kind || '') + '</span></div>'
      + '<div>' + esc(starter.summary || '') + '</div>'
      + (payload.name ? '<div><strong>Creates:</strong> ' + esc(payload.name) + '</div>' : '')
      + (payload.format ? '<div><strong>Format:</strong> ' + esc(payload.format) + '</div>' : '')
      + (payload.scriptCommand ? '<div><strong>Command:</strong> <code>' + esc(payload.scriptCommand) + '</code></div>' : '')
      + (artifactHtml ? '<ul>' + artifactHtml + '</ul>' : '')
      + (triggerHtml ? '<div><strong>Triggers:</strong><ul>' + triggerHtml + '</ul></div>' : '')
      + '<div class="autonomy-actions"><button class="btn-sm" onclick="runCapabilityTemplateStarterAction(\'' + escAttr(templateId) + '\', \'preview\')">Preview</button><button class="btn-sm primary" onclick="runCapabilityTemplateStarterAction(\'' + escAttr(templateId) + '\', \'create\')">Create</button></div>'
      + '<div id="capabilityTemplateActionStatus" class="trace-meta">Preview before create. Automation starters still require normal grants when they run.</div>';
  } catch (error) {
    detail.innerHTML = '<div class="settings-warning-line">Starter unavailable: ' + esc(error.message || error) + '</div>';
  }
}

async function runCapabilityTemplateStarterAction(templateId, action) {
  const status = document.getElementById('capabilityTemplateActionStatus') || document.getElementById('capabilityTemplateDetail');
  if (status) status.textContent = action === 'create' ? 'Creating starter...' : 'Previewing starter...';
  try {
    const response = await fetch('/api/capability-templates/' + encodeURIComponent(templateId) + '/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await readApiJson(response, 'Capability starter action API');
    if (status) {
      if (data.job) status.textContent = 'Created automation job: ' + data.job.name;
      else if (data.document) status.textContent = 'Created document: ' + data.document.filename;
      else status.textContent = 'Preview ready: ' + (data.preview?.kind || data.starter?.kind || 'starter');
    }
  } catch (error) {
    if (status) status.textContent = 'Starter action failed: ' + (error.message || error);
  }
}

const AUTONOMY_UI_SETTINGS_KEY = 'harness.autonomy.runSettings.v1';

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getAutonomyRunSettings() {
  const defaults = { maxIterations: 1, maxTurns: 30, timeBudgetHours: 0, unproductiveTurnLimit: 6 };
  try {
    const raw = localStorage.getItem(AUTONOMY_UI_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      maxIterations: clampInt(parsed?.maxIterations, defaults.maxIterations, 1, 5000),
      maxTurns: clampInt(parsed?.maxTurns, defaults.maxTurns, 1, 500),
      timeBudgetHours: clampFloat(parsed?.timeBudgetHours, defaults.timeBudgetHours, 0, 48),
      unproductiveTurnLimit: clampInt(parsed?.unproductiveTurnLimit, defaults.unproductiveTurnLimit, 1, 100),
    };
  } catch(e){
    return defaults;
  }
}

function saveAutonomyRunSettings(settings) {
  try {
    localStorage.setItem(AUTONOMY_UI_SETTINGS_KEY, JSON.stringify(settings));
  } catch(e){}
}

function readAutonomyRunSettingsFromUi() {
  const defaults = getAutonomyRunSettings();
  const maxIterations = clampInt(document.getElementById('autonomyMaxIterations')?.value, defaults.maxIterations, 1, 5000);
  const maxTurns = clampInt(document.getElementById('autonomyMaxTurns')?.value, defaults.maxTurns, 1, 500);
  const timeBudgetHours = clampFloat(document.getElementById('autonomyTimeBudgetHours')?.value, defaults.timeBudgetHours, 0, 48);
  const unproductiveTurnLimit = clampInt(document.getElementById('autonomyUnproductiveTurnLimit')?.value, defaults.unproductiveTurnLimit, 1, 100);
  const settings = { maxIterations, maxTurns, timeBudgetHours, unproductiveTurnLimit };
  saveAutonomyRunSettings(settings);
  return {
    ...settings,
    timeBudgetMs: timeBudgetHours > 0 ? Math.round(timeBudgetHours * 60 * 60 * 1000) : undefined,
  };
}

function applyAutonomyPreset(preset) {
  const next = preset === 'overnight'
    ? { maxIterations: 300, maxTurns: 100, timeBudgetHours: 8, unproductiveTurnLimit: 15 }
    : preset === 'work'
      ? { maxIterations: 25, maxTurns: 75, timeBudgetHours: 2, unproductiveTurnLimit: 12 }
      : { maxIterations: 1, maxTurns: 30, timeBudgetHours: 0, unproductiveTurnLimit: 6 };
  const maxEl = document.getElementById('autonomyMaxIterations');
  const turnsEl = document.getElementById('autonomyMaxTurns');
  const budgetEl = document.getElementById('autonomyTimeBudgetHours');
  const stallEl = document.getElementById('autonomyUnproductiveTurnLimit');
  if (maxEl) maxEl.value = String(next.maxIterations);
  if (turnsEl) turnsEl.value = String(next.maxTurns);
  if (budgetEl) budgetEl.value = String(next.timeBudgetHours);
  if (stallEl) stallEl.value = String(next.unproductiveTurnLimit);
  saveAutonomyRunSettings(next);
  const status = document.getElementById('autonomyBuilderStatus');
  if (status) {
    status.textContent = preset === 'overnight'
      ? 'Overnight preset loaded: 300 tasks, 100 turns/task, 8h budget.'
      : preset === 'work'
        ? 'Work session preset loaded: 25 tasks, 75 turns/task, 2h budget.'
      : 'Single-task preset loaded.';
  }
}

function describeAutonomyStatus(status) {
  if (status === 'running') return 'Running';
  if (status === 'done') return 'Completed';
  if (status === 'failed') return 'Needs attention';
  return 'Idle';
}

function renderAutonomyBudgetField(id, label, value, min, max, step, title) {
  return '<label class="autonomy-budget-field" style="display:flex;flex-direction:column;gap:4px;min-width:130px;flex:1;font-size:11px;color:var(--text-dim)">'
    + '<span>' + esc(label) + '</span>'
    + '<input id="' + escAttr(id) + '" type="number" min="' + escAttr(String(min)) + '" max="' + escAttr(String(max)) + '" step="' + escAttr(String(step)) + '" value="' + escAttr(String(value)) + '" title="' + escAttr(title) + '" aria-label="' + escAttr(label) + '">'
    + '</label>';
}

// --- BUILD MODE (non-technical "describe it and I'll build it") ---
// A friendly front-end over the existing autonomy loop: the user types a
// plain-English goal, the server decomposes it into plan steps, the user
// reviews them and picks how long to work, then presses Build it — which
// reuses applyAutonomyPreset + startAutonomyRun under the hood.

const BUILD_TIME_LABELS = {
  single: 'Quick try (one step, quick check)',
  work: 'About an hour',
  overnight: "Until it's done (overnight)",
};

function renderBuildModeCard() {
  const chosen = window.__buildTimeChoice || null;
  const timeBtn = (preset, label) =>
    '<button class="btn-sm build-time-btn' + (chosen === preset ? ' selected' : '')
    + '" onclick="chooseBuildTime(\'' + preset + '\')">' + esc(label) + '</button>';
  return '<div class="build-mode-card">'
    + '<div class="build-mode-head"><strong>🚀 Build something</strong>'
    + '<span>Describe what you want in plain English — I\'ll turn it into steps and build it for you.</span></div>'
    + '<textarea id="buildGoalInput" class="build-goal-input" rows="3" '
    + 'placeholder="e.g. A simple to-do list web app where I can add, complete, and delete tasks."></textarea>'
    + '<div class="build-examples">Try: '
    + '<button class="btn-xs" onclick="fillBuildExample(\'A personal expense tracker with a chart of spending by category.\')">expense tracker</button> '
    + '<button class="btn-xs" onclick="fillBuildExample(\'A landing page for a coffee shop with a menu and a contact form.\')">coffee shop site</button> '
    + '<button class="btn-xs" onclick="fillBuildExample(\'A command-line tool that renames photo files by the date they were taken.\')">photo renamer</button>'
    + '</div>'
    + '<div class="build-mode-actions"><button class="btn-sm build-plan-btn" onclick="planFromGoal()">📝 Plan it</button></div>'
    + '<div class="build-mode-status" id="buildModeStatus"></div>'
    + '<div class="build-review" id="buildReview"></div>'
    + '<div class="build-time-choice"><div class="build-time-label">When the steps look right, choose how long I should work:</div>'
    + '<div class="build-time-buttons">'
    + timeBtn('single', 'Quick try')
    + timeBtn('work', 'About an hour')
    + timeBtn('overnight', "Until it's done")
    + '</div></div>'
    + '<button class="btn build-it-btn" onclick="buildIt()">▶ Build it</button>'
    + '</div>';
}

function fillBuildExample(text) {
  const input = document.getElementById('buildGoalInput');
  if (input) { input.value = text; input.focus(); }
}

function setBuildStatus(text, tone) {
  const el = document.getElementById('buildModeStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'build-mode-status' + (tone ? ' ' + tone : '');
}

async function planFromGoal() {
  const input = document.getElementById('buildGoalInput');
  const goal = (input?.value || '').trim();
  if (!goal) { setBuildStatus('Type what you want to build first, then press Plan it.', 'warn'); return; }
  const model = document.getElementById('modelSelect')?.value || '';
  setBuildStatus('Thinking… breaking your idea into clear steps…');
  const review = document.getElementById('buildReview');
  if (review) review.innerHTML = '';
  try {
    const response = await fetch('/api/autonomy/plan-from-goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, model }),
    });
    const data = await readApiJson(response, 'Plan from goal API');
    if (data.error) throw new Error(data.error);
    const added = data.added || [];
    if (review) {
      review.innerHTML = '<div class="build-review-title">Here\'s my plan — ' + esc(added.length) + ' step'
        + (added.length === 1 ? '' : 's') + ':</div>'
        + '<ol class="build-review-list">'
        + added.map((t) => '<li>' + esc(t.title) + '</li>').join('')
        + '</ol>';
    }
    setBuildStatus('Done. Review the steps, choose how long I should work, then press Build it.', 'ok');
  } catch (error) {
    setBuildStatus(error.message || String(error), 'warn');
  }
}

function chooseBuildTime(preset) {
  window.__buildTimeChoice = preset;
  applyAutonomyPreset(preset);
  const labels = { single: 'Quick try', work: 'About an hour', overnight: "Until it's done" };
  document.querySelectorAll('.build-time-btn').forEach((btn) => {
    btn.classList.toggle('selected', (btn.textContent || '').trim() === labels[preset]);
  });
  setBuildStatus('Set to: ' + (BUILD_TIME_LABELS[preset] || preset) + '. Press Build it when ready.', 'ok');
}

async function buildIt() {
  if (!window.__buildTimeChoice) {
    window.__buildTimeChoice = 'work';
    applyAutonomyPreset('work');
  }
  // The autonomy run executes as a background process with no UI to answer
  // permission prompts, so the server's preflight requires supervised-
  // autonomous (dontAsk) mode plus the shell + background-job grants. Build
  // Mode never engaged these, so every Build it press was rejected with a 409
  // that surfaced only in a hidden element — making it look like nothing
  // happened. Engage a TIMED autonomy window (auto-reverts) sized to the
  // chosen work length, behind one plain-language consent that covers all
  // presets, then surface any start failure in the build card itself.
  const timedMinutes = window.__buildTimeChoice === 'overnight' ? 600
    : window.__buildTimeChoice === 'work' ? 150
      : 30;
  const timeWord = window.__buildTimeChoice === 'overnight' ? 'several hours'
    : window.__buildTimeChoice === 'work' ? 'up to about 2 hours'
      : 'a short test run';
  const consent = window.confirm(
    'To build this I need permission to create and edit files and run commands on your behalf for ' + timeWord + '.\n\n'
    + 'I\'ll stop automatically when the work is done or the time is up, and you can press Stop anytime. Continue?');
  if (!consent) { setBuildStatus('Cancelled — nothing started.', 'warn'); return; }
  setBuildStatus('Setting up permissions for the build…', 'ok');
  try {
    await ensureBuildPermissions(timedMinutes);
  } catch (error) {
    setBuildStatus('Could not enable build permissions: ' + (error.message || String(error)), 'warn');
    return;
  }
  setBuildStatus('Starting your build… watch progress in the banner at the top.', 'ok');
  const result = await startAutonomyRun();
  if (result && result.ok === false) {
    setBuildStatus('Could not start the build: ' + (result.error || 'unknown error'), 'warn');
  }
}

// Engage a timed supervised-autonomous (dontAsk) window so the background
// build can create/edit files and run commands without a UI prompt. The
// window auto-reverts after timedMinutes, mirroring the readiness fix-all
// escalation. Throws (via readApiJson) if the server rejects the request.
async function ensureBuildPermissions(timedMinutes) {
  const response = await fetch('/api/permissions/timed-autonomy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInMinutes: timedMinutes, reason: 'Build Mode one-click supervised autonomous build' }),
  });
  await readApiJson(response, 'Timed autonomy API');
}

function renderAutonomyBuilder(data) {
  const runSettings = getAutonomyRunSettings();
  const nextTasks = (data.tasks || []).filter((task) => task.status === 'pending').slice(0, 5);
  const doneTasks = (data.tasks || []).filter((task) => task.status === 'done').slice(-3);
  return renderBuildModeCard()
    + '<div class="autonomy-head"><div><strong>Autonomy Run Builder</strong><span>' + esc(data.pending || 0) + ' pending · ' + esc(data.done || 0) + ' done · ' + esc(data.failed || 0) + ' failed</span></div><button class="btn-sm danger" onclick="stopAutonomyRun()">Stop</button></div>'
    + '<div class="autonomy-actions"><button class="btn-sm" onclick="dryRunAutonomy()">Dry run next</button><button class="btn-sm" onclick="startAutonomyRun()">Start run</button><button class="btn-sm" onclick="toggleAutonomyLog()">View live log</button><button class="btn-sm" onclick="resetAutonomyRunState()">Reset run state</button><button class="btn-sm" onclick="openLeftTabByName(\'runs\')">Open runs</button></div>'
    + '<div class="trace-meta" style="margin-bottom:6px">1) Pick a preset or set values · 2) Start run · 3) Watch live log</div>'
    + '<div class="autonomy-actions"><button class="btn-sm" onclick="applyAutonomyPreset(\'single\')">Quick test</button><button class="btn-sm" onclick="applyAutonomyPreset(\'work\')">Work session</button><button class="btn-sm" onclick="applyAutonomyPreset(\'overnight\')">Overnight</button></div>'
    + '<div class="task-add-form autonomy-budget-grid">'
    + renderAutonomyBudgetField('autonomyMaxIterations', 'Tasks this run', runSettings.maxIterations, 1, 5000, 1, 'How many plan tasks Ralph may attempt after you press Start')
    + renderAutonomyBudgetField('autonomyMaxTurns', 'Turns per task', runSettings.maxTurns, 1, 500, 1, 'Maximum model/tool turns allowed inside each task. Put 150 here when you want 150 turns.')
    + renderAutonomyBudgetField('autonomyTimeBudgetHours', 'Time budget (hours)', runSettings.timeBudgetHours, 0, 48, 0.5, 'Wall-clock budget in hours. 0 means unlimited.')
    + renderAutonomyBudgetField('autonomyUnproductiveTurnLimit', 'Stall limit', runSettings.unproductiveTurnLimit, 1, 100, 1, 'Stop after this many unproductive turns. This is not the same as turns per task.')
    + '</div>'
    + '<div class="trace-meta" id="autonomyAcceptedSettings">Configured: ' + esc(runSettings.maxIterations) + ' task(s) this run · ' + esc(runSettings.maxTurns) + ' turns/task · stall limit ' + esc(runSettings.unproductiveTurnLimit) + '</div>'
    + '<div class="task-add-form"><input id="newTaskInput" type="text" placeholder="Describe a task for the agent..." onkeydown="if(event.key===\'Enter\')addPlanTask()"><button class="btn-sm" onclick="addPlanTask()">+ Add task</button></div>'
    + '<div class="autonomy-task-list">' + (nextTasks.length ? nextTasks.map(renderTaskRow).join('') : '<div class="readiness-empty">No pending tasks. Add one above.</div>') + '</div>'
    + (doneTasks.length ? '<details class="details-mt4"><summary class="trace-meta trace-summary-sm">Recent completed (' + esc(data.done) + ')</summary><div class="autonomy-task-list">' + doneTasks.map((t) => '<div class="autonomy-task done"><strong>' + esc(t.id) + '</strong><span>' + esc(t.title) + '</span></div>').join('') + '</div></details>' : '')
    + '<div class="first-run-status" id="autonomyBuilderStatus">Previewing ' + esc(data.planPath || 'IMPLEMENTATION_PLAN.md') + '</div>';
}

function renderTaskRow(task) {
  return '<div class="autonomy-task"><strong>' + esc(task.id) + '</strong><span>' + esc(task.title) + '</span>'
    + '<div class="task-actions"><button class="btn-xs" onclick="completePlanTask(\'' + escAttr(task.id) + '\')" title="Mark done">✓</button>'
    + '<button class="btn-xs danger" onclick="deletePlanTask(\'' + escAttr(task.id) + '\')" title="Remove">✕</button></div></div>';
}

async function addPlanTask() {
  const input = document.getElementById('newTaskInput');
  const title = input?.value?.trim();
  if (!title) return;
  const status = document.getElementById('autonomyBuilderStatus');
  if (status) status.textContent = 'Adding task...';
  try {
    const response = await fetch('/api/autonomy/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description: title }) });
    await readApiJson(response, 'Add task API');
    input.value = '';
    // Reset the textarea height so it shrinks back to one line after a
    // long task is added. Mirrors the chat composer's behavior.
    if (input.tagName === 'TEXTAREA') input.style.height = 'auto';
    if (status) status.textContent = 'Task added.';
    loadAutonomyPlanPreview();
    loadReadiness();
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
  }
}

async function completePlanTask(id) {
  try {
    await fetch('/api/autonomy/tasks/' + encodeURIComponent(id) + '/complete', { method: 'POST' });
    loadAutonomyPlanPreview();
    loadReadiness();
  } catch(e){}
}

async function deletePlanTask(id) {
  if (!await confirmToast('Remove task "' + id + '" from the plan?')) return;
  try {
    await fetch('/api/autonomy/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
    loadAutonomyPlanPreview();
    loadReadiness();
  } catch(e){}
}

async function dryRunAutonomy() {
  const status = document.getElementById('autonomyBuilderStatus');
  if (status) status.textContent = 'Checking next pending task...';
  try {
    const response = await fetch('/api/autonomy/dry-run', { method: 'POST' });
    const data = await readApiJson(response, 'Autonomy dry-run API');
    if (status) status.textContent = data.nextTask ? 'Next: ' + data.nextTask.id + ' — ' + data.nextTask.title : 'No pending tasks.';
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
  }
}

async function startAutonomyRun() {
  const status = document.getElementById('autonomyBuilderStatus');
  const runSettings = readAutonomyRunSettingsFromUi();
  if (status) {
    const budgetText = runSettings.timeBudgetHours > 0 ? ` · ${runSettings.timeBudgetHours}h budget` : '';
    status.textContent = `Starting autonomy run: ${runSettings.maxIterations} task(s) · ${runSettings.maxTurns} turns/task${budgetText}...`;
  }
  try {
    const model = document.getElementById('modelSelect')?.value || '';
    const response = await fetch('/api/autonomy/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        maxIterations: runSettings.maxIterations,
        maxTurns: runSettings.maxTurns,
        timeBudgetMs: runSettings.timeBudgetMs,
        unproductiveTurnLimit: runSettings.unproductiveTurnLimit,
      }),
    });
    const data = await readApiJson(response, 'Autonomy start API');
    if (data.error) {
      const blocked = data.preflight?.blocked || [];
      const detail = blocked.length ? ': ' + blocked.map((check) => check.label).join(', ') : '';
      throw new Error(data.error + detail);
    }
    if (status) {
      const requested = data.requestedMaxIterations ?? runSettings.maxIterations;
      const requestedTurns = data.requestedMaxTurns ?? runSettings.maxTurns;
      const budgetText = runSettings.timeBudgetHours > 0 ? ` · ${runSettings.timeBudgetHours}h budget` : '';
      status.textContent = `Started PID ${data.pid} · requested ${requested} task(s) · ${requestedTurns} turns/task${budgetText} · streaming live updates`;
    }
    const accepted = document.getElementById('autonomyAcceptedSettings');
    if (accepted) {
      const requested = data.requestedMaxIterations ?? runSettings.maxIterations;
      const requestedTurns = data.requestedMaxTurns ?? runSettings.maxTurns;
      const acceptedStall = data.requestedUnproductiveTurnLimit ?? runSettings.unproductiveTurnLimit;
      accepted.textContent = `Server accepted: ${requested} task(s) this run · ${requestedTurns} turns/task · stall limit ${acceptedStall}`;
    }
    const logModal = document.getElementById('autonomyLogModal');
    if (logModal && logModal.classList.contains('hidden-by-default')) toggleAutonomyLog();
    startAutonomyPolling();
    return { ok: true };
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
    return { ok: false, error: error.message || String(error) };
  }
}

async function stopAutonomyRun() {
  const status = document.getElementById('autonomyBuilderStatus');
  if (status) status.textContent = 'Writing .forge-stop...';
  try {
    const response = await fetch('/api/autonomy/stop', { method: 'POST' });
    await readApiJson(response, 'Autonomy stop API');
    if (status) status.textContent = 'Stop requested.';
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
  }
}

async function resetAutonomyRunState() {
  const status = document.getElementById('autonomyBuilderStatus');
  if (!await confirmToast('Reset autonomy checkpoint and stop files? This is useful if a run is stuck at an old iteration.')) return;
  if (status) status.textContent = 'Resetting run state...';
  try {
    const response = await fetch('/api/autonomy/reset', { method: 'POST' });
    const data = await readApiJson(response, 'Autonomy reset API');
    const cleared = Array.isArray(data.cleared) ? data.cleared.join(', ') : '';
    if (status) status.textContent = cleared ? 'Run state reset: ' + cleared : 'Run state reset. Nothing needed clearing.';
    renderAutonomyState(null);
    loadAutonomyPlanPreview();
    loadReadiness();
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
  }
}

function renderDocumentStudioShell() {
  return '<div class="document-head"><div><strong>Document Studio</strong><span>Generate documents from the current chat, evidence, or pasted source.</span></div><button class="btn-sm" onclick="loadDocuments()">Refresh</button></div>'
    + '<div class="document-form">'
    + '<input id="documentTitle" type="text" placeholder="Document title" value="Harness Work Summary">'
    + '<select id="documentTemplate"><option value="brief">Brief</option><option value="report">Report</option><option value="runbook">Runbook</option><option value="spec">Spec</option><option value="adr">ADR</option><option value="release-notes">Release notes</option><option value="handoff">Handoff</option></select>'
    + '<select id="documentFormat"><option value="markdown">Markdown</option><option value="html">HTML</option><option value="pdf">PDF</option><option value="docx">DOCX</option></select>'
    + '</div>'
    + '<textarea id="documentSource" placeholder="Optional source text. Leave empty to use this chat transcript."></textarea>'
    + '<div class="document-actions"><button class="btn-sm" onclick="generateDocument()">Generate document</button><button class="btn-sm" onclick="fillDocumentFromEvidence()">Use latest evidence</button><button class="btn-sm" onclick="exportChat()">Quick chat export</button></div>'
    + '<div class="first-run-status" id="documentStudioStatus">Documents are saved under .harness/documents.</div>'
    + '<div class="document-list" id="documentList"><div class="readiness-empty">Loading documents...</div></div>';
}

function latestEvidenceCard() {
  const cards = Array.from(document.querySelectorAll('.evidence-card'));
  if (cards.length === 0) return null;
  return cards[cards.length - 1].textContent || '';
}

function fillDocumentFromEvidence() {
  const source = document.getElementById('documentSource');
  if (!source) return;
  source.value = latestEvidenceCard() || 'No evidence card is available yet. Generate a chat turn first, then retry.';
}

function chatTranscriptMarkdown() {
  if (!chatMessages.length) return '';
  return chatMessages.map((message) => '## ' + (message.role === 'user' ? 'User' : 'Assistant') + '\n\n' + message.content).join('\n\n');
}

async function generateDocument() {
  const status = document.getElementById('documentStudioStatus');
  if (status) status.textContent = 'Generating document...';
  try {
    const title = document.getElementById('documentTitle')?.value || 'Harness Work Summary';
    const template = document.getElementById('documentTemplate')?.value || 'brief';
    const format = document.getElementById('documentFormat')?.value || 'markdown';
    const source = document.getElementById('documentSource')?.value.trim() || chatTranscriptMarkdown() || 'No chat transcript is available yet.';
    const response = await fetch('/api/documents/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, template, format, sourceLabel: 'Harness UI', content: source, evidence: latestEvidenceObject }) });
    const data = await readApiJson(response, 'Document generation API');
    if (status) status.innerHTML = 'Generated <a href="/api/documents/' + encodeURIComponent(data.document.id) + '/download">' + esc(data.document.filename) + '</a>';
    await loadDocuments();
  } catch (error) {
    if (status) status.textContent = error.message || String(error);
  }
}

async function loadDocuments() {
  const list = document.getElementById('documentList');
  if (!list) return;
  try {
    const response = await fetch('/api/documents');
    const data = await readApiJson(response, 'Documents API');
    const documents = data.documents || [];
    list.innerHTML = documents.length ? documents.slice(0, 8).map((doc) => '<div class="document-item"><div><strong>' + esc(doc.title) + '</strong><span>' + esc(doc.template) + ' · ' + esc(doc.format) + ' · ' + esc(new Date(doc.createdAt).toLocaleString()) + '</span></div><a class="btn-sm" href="/api/documents/' + encodeURIComponent(doc.id) + '/download">Download</a></div>').join('') : '<div class="readiness-empty">No generated documents yet.</div>';
  } catch (error) {
    list.innerHTML = '<div class="readiness-empty">Document list unavailable: ' + esc(error.message || error) + '</div>';
  }
}

function selectedModelDetails() {
  const selected = document.getElementById('modelSelect')?.value;
  return availableModels.find((model) => model.name === selected) || null;
}

function renderModelCapabilityHint() {
  const hint = document.getElementById('modelCapabilityHint');
  // The hint element was removed in the v0.5.10 welcome trim. Callers
  // still invoke this on model change for its renderAttachmentHint()
  // side effect, so refresh that and bail before touching the missing
  // node.
  if (!hint) { renderAttachmentHint(); return; }
  const model = selectedModelDetails();
  if (!model) {
    hint.textContent = 'Choose a model to see whether Harness detects text, image, or audio support.';
    renderAttachmentHint();
    return;
  }
  const capabilities = model.capabilities || { text: true, image: false, audio: false, toolUse: 'unknown', notes: [] };
  const toolUsePill = capabilities.toolUse === 'weak' ? '<span class="capability-pill" style="color:var(--warning,orange)">⚠ Tools</span>'
    : capabilities.toolUse === 'strong' ? '<span class="capability-pill">✓ Tools</span>'
    : '';
  const pills = [
    capabilityPill('Text', true),
    capabilityPill('Images', capabilities.image),
    capabilityPill('Audio', capabilities.audio),
    toolUsePill,
  ].filter(Boolean).join('');
  const notes = (capabilities.notes || []).slice(0, 3).map(esc).join(' ');
  hint.innerHTML = '<strong>' + esc(model.name) + '</strong><div>' + pills + '</div><div>' + esc(notes || 'Harness detected a text chat model. Attachments are still available as local file paths for tools and analysis.') + '</div>' + getModelProfileSuggestion(model.name);

  // When the selected model has weak tool support, suggest an alternative
  // from the available models that is known to handle tools well.
  if (capabilities.toolUse === 'weak') {
    const sel = document.getElementById('modelSelect');
    if (sel) {
      const strongPattern = /kimi|qwen.*coder.*(14|32|72)b|deepseek.*(v3|coder)|mistral.*(medium|large)|command-r|llama.*70b/i;
      const options = Array.from(sel.options).map(o => o.value).filter(v => v && v !== model.name && strongPattern.test(v));
      if (options.length > 0) {
        const rec = document.createElement('div');
        rec.className = 'model-adaptive-badge';
        rec.innerHTML = '💡 For web search and tool tasks, try <a href="#" class="model-inline-link" onclick="document.getElementById(\'modelSelect\').value=\'' + escAttr(options[0]) + '\';updateSetting(\'model\',\'' + escAttr(options[0]) + '\');renderModelCapabilityHint();event.preventDefault();">' + esc(options[0]) + '</a>' + (options.length > 1 ? ' or ' + (options.length - 1) + ' other model(s)' : '');
        hint.appendChild(rec);
      }
    }
  }

  // Fetch synthesis stats and show adaptive turns badge if different from default.
  (async () => {
    let data;
    try {
      const r = await fetch('/api/synthesis-stats');
      if (!r.ok) return;
      data = await r.json();
    } catch (err) { console.warn('synthesis-stats fetch failed', err); return; }
    if (!hint.isConnected || !data || !data.stats) return;
    const record = data.stats[model.name];
    if (!record) return;
    const adaptive = record.adaptiveMaxTurns || data.defaultMaxTurns;
    const def = data.defaultMaxTurns || 25;
    const adaptiveBudgetSec = record.adaptiveTimeBudgetMs ? Math.round(record.adaptiveTimeBudgetMs / 1000) : null;
    const avgTurnSec = record.avgTurnMs ? (record.avgTurnMs / 1000).toFixed(1) : null;
    if (adaptive > def || adaptiveBudgetSec) {
      const badge = document.createElement('div');
      badge.className = 'model-adaptive-badge';
      const parts = [];
      if (adaptive > def) parts.push('🔄 Adaptive: ' + adaptive + ' turns (default ' + def + ')');
      if (adaptiveBudgetSec) parts.push('⏱️ ' + adaptiveBudgetSec + 's budget');
      if (avgTurnSec) parts.push('~' + avgTurnSec + 's/turn');
      parts.push('synthesis ' + (record.fired || 0) + '/' + (record.total || 0) + ' sessions');
      badge.textContent = parts.join(' · ') + ' ';
      const resetBtn = document.createElement('a');
      resetBtn.href = '#';
      resetBtn.className = 'model-inline-link';
      resetBtn.textContent = '(reset)';
      resetBtn.onclick = async (e) => {
        e.preventDefault();
        try {
          await fetch('/api/synthesis-stats?model=' + encodeURIComponent(model.name), { method: 'DELETE' });
          renderModelCapabilityHint();
        } catch (err) { console.warn('synthesis-stats reset failed', err); }
      };
      badge.appendChild(resetBtn);
      hint.appendChild(badge);
    }
  })();
  renderAttachmentHint();
}

function capabilityPill(label, enabled) {
  return '<span class="capability-pill">' + (enabled ? '✓ ' : '○ ') + esc(label) + '</span>';
}

function loadModelStats() {
  const panel = document.getElementById('modelStatsPanel');
  if (!panel) return;
  panel.textContent = 'Loading…';
  fetch('/api/synthesis-stats').then(r => r.json()).then(data => {
    if (!data.stats || Object.keys(data.stats).length === 0) {
      panel.textContent = 'No model stats yet — run a few chat sessions first.';
      return;
    }
    const rows = Object.entries(data.stats).sort((a, b) => (b[1].total || 0) - (a[1].total || 0)).map(([model, rec]) => {
      const avg = rec.avgTurnMs ? (rec.avgTurnMs / 1000).toFixed(1) + 's' : '—';
      const budget = rec.adaptiveTimeBudgetMs ? Math.round(rec.adaptiveTimeBudgetMs / 1000) + 's' : '—';
      const turns = rec.adaptiveMaxTurns || data.defaultMaxTurns || 25;
      const synthRate = rec.total > 0 ? Math.round((rec.fired / rec.total) * 100) + '%' : '—';
      const toolRate = rec.toolCalls > 0 ? Math.round(((rec.toolSuccesses || 0) / rec.toolCalls) * 100) + '%' : '—';
      const finalRate = rec.total > 0 ? Math.round(((rec.finalTextResponses || 0) / rec.total) * 100) + '%' : '—';
      return '<tr><td>' + esc(model) + '</td><td>' + rec.total + '</td><td>' + avg + '</td><td>' + budget + '</td><td>' + turns + '</td><td>' + synthRate + '</td><td>' + (rec.toolCalls || 0) + '</td><td>' + toolRate + '</td><td>' + finalRate + '</td></tr>';
    }).join('');
    panel.innerHTML = '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px">'
      + '<thead><tr style="text-align:left;color:var(--text-dim)"><th>Model</th><th>Sessions</th><th>Avg turn</th><th>Budget</th><th>Max turns</th><th>Synth rate</th><th>Tool calls</th><th>Tool success</th><th>Final text</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<button class="btn-sm" style="margin-top:6px" onclick="exportModelStatsCsv()">Download CSV</button>';
  }).catch(() => { panel.textContent = 'Failed to load stats.'; });
}

function exportModelStatsCsv() {
  fetch('/api/synthesis-stats').then(r => r.json()).then(data => {
    if (!data.stats) return;
    const header = 'Model,Sessions,Fired,Avg Turn (ms),Adaptive Budget (ms),Max Turns,Synth Rate (%),Tool Calls,Tool Successes,Tool Success Rate (%),Final Text Responses,Final Text Rate (%),Parser Lifted Tool Calls';
    const rows = Object.entries(data.stats).sort((a, b) => (b[1].total || 0) - (a[1].total || 0)).map(([model, rec]) => {
      const synthRate = rec.total > 0 ? Math.round((rec.fired / rec.total) * 100) : 0;
      const toolRate = rec.toolCalls > 0 ? Math.round(((rec.toolSuccesses || 0) / rec.toolCalls) * 100) : 0;
      const finalRate = rec.total > 0 ? Math.round(((rec.finalTextResponses || 0) / rec.total) * 100) : 0;
      return [model, rec.total || 0, rec.fired || 0, rec.avgTurnMs || 0, rec.adaptiveTimeBudgetMs || 0, rec.adaptiveMaxTurns || 25, synthRate, rec.toolCalls || 0, rec.toolSuccesses || 0, toolRate, rec.finalTextResponses || 0, finalRate, rec.parserLiftedToolCalls || 0].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'model-stats-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }).catch(() => { showToast('Failed to export stats.'); });
}

function getModelProfileSuggestion(modelName) {
  if (!modelName) return '';
  const modelLower = modelName.toLowerCase();
  // Check if any saved profile uses this model
  for (const [name, profile] of Object.entries(agentProfiles)) {
    if (profile.model && modelLower.includes(profile.model.toLowerCase().split(':')[0])) {
      return '<div class="model-profile-suggestion"><a href="#" class="model-inline-link" onclick="loadAgentProfile(\'' + escAttr(name) + '\'); event.preventDefault();">' + esc((profile.avatar || '🤖') + ' Load "' + name + '" profile for this model') + '</a></div>';
    }
  }
  // Suggest personality presets based on model type
  const MODEL_PERSONALITY_HINTS = {
    'codellama': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'deepseek-coder': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'qwen2.5-coder': { preset: 'concise', hint: 'Code-focused model — try the Concise personality' },
    'llava': { preset: 'friendly', hint: 'Vision model — try the Friendly personality for image conversations' },
    'gemma': { preset: 'friendly', hint: 'Conversational model — try the Friendly personality' },
    'mistral': { preset: 'professional', hint: 'Balanced model — try the Professional personality' },
    'llama': { preset: 'mentor', hint: 'General model — try the Mentor personality for learning' },
  };
  for (const [prefix, config] of Object.entries(MODEL_PERSONALITY_HINTS)) {
    if (modelLower.includes(prefix) && !currentAgentName) {
      return '<div class="model-personality-hint">' + esc(config.hint) + ' <a href="#" class="accent-link" onclick="applyPersonalityPreset(\'' + config.preset + '\'); event.preventDefault();">Apply</a></div>';
    }
  }
  return '';
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
  if (pendingFiles.length > 3) {
    hint.innerHTML = esc(pendingFiles.length + ' files attached.') + ' <a href="#" class="accent-link" onclick="suggestScanAllAttachments(event)">Ask the model to scan all attachments</a> using <code>list_uploads</code>.';
    return;
  }
  hint.textContent = 'Attach text, data, image, or audio files. Harness shows the media type and passes the local file path into your message.';
}

function suggestScanAllAttachments(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const inp = document.getElementById('chatInput');
  if (!inp) return;
  const suggestion = 'Call list_uploads first to enumerate every attached file, then read and summarize each one in turn. Use the exact path returned by list_uploads when you call file_read, pdf_read, image_analyze, or audio_transcribe.';
  inp.value = inp.value ? inp.value.trim() + '\n\n' + suggestion : suggestion;
  autoSize(inp);
  inp.focus();
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    if (s.temperature !== undefined) { document.getElementById('tempSlider').value = s.temperature; document.getElementById('tempVal').textContent = s.temperature; }
    if (s.topP !== undefined) { document.getElementById('topPSlider').value = s.topP; document.getElementById('topPVal').textContent = s.topP; }
    if (s.systemPrompt) document.getElementById('sysPrompt').value = s.systemPrompt;
    hydratePersonality(s.agentPersonality || '');
    hydrateAgentName(s.agentName || '');
    hydrateAgentAvatar(s.agentAvatar || '');
    hydrateAgentProfiles(s.agentProfiles || {});
    hydrateAllowedPaths(s.allowedExternalPaths || []);
    window._currentAllowedPaths = s.allowedExternalPaths || [];
    if (s.ollamaHost) document.getElementById('ollamaHost').value = s.ollamaHost;
    if (s.summarizerModel) document.getElementById('summarizerModel').value = s.summarizerModel;
    if (s.contextMaxTokens !== undefined) document.getElementById('contextMaxTokens').value = s.contextMaxTokens;
    if (s.webReadMaxChars) document.getElementById('webReadMaxChars').value = s.webReadMaxChars;
    renderContextDetails(s.context || { configuredMaxTokens: s.contextMaxTokens, detectedMaxTokens: null, effectiveMaxTokens: s.contextMaxTokens });
    const tbInput = document.getElementById('timeBudgetSec');
    if (tbInput) {
      const tbMs = s.timeBudgetMs || 0;
      tbInput.value = tbMs > 0 ? Math.round(tbMs / 1000) : 180;
      const hint = document.getElementById('timeBudgetHint');
      if (hint) {
        // Fetch synthesis stats to show the adaptive budget for the current model.
        const modelName = s.model || '';
        fetch('/api/synthesis-stats').then(r => r.json()).then(data => {
          const rec = data.stats?.[modelName];
          if (rec?.adaptiveTimeBudgetMs && tbMs <= 0) {
            hint.textContent = 'Adaptive: ' + Math.round(rec.adaptiveTimeBudgetMs / 1000) + 's (~' + (rec.avgTurnMs / 1000).toFixed(1) + 's/turn × 10)';
          } else if (tbMs > 0) {
            hint.textContent = 'Custom: ' + Math.round(tbMs / 1000) + 's';
          } else {
            hint.textContent = 'Auto-detect: local 180s · cloud 600s';
          }
        }).catch(() => {
          hint.textContent = tbMs > 0 ? 'Custom: ' + Math.round(tbMs / 1000) + 's' : 'Auto-detect: local 180s · cloud 600s';
        });
      }
    }
    currentModelRouting = s.modelRouting || {};
    currentMediaTools = s.mediaTools || {};
    currentOutputValidation = s.outputValidation || { enabled: false, profile: 'oracle-prime', autoSelect: true, skipOnLowSignal: true };
    currentOutputValidationProfiles = s.outputValidationProfiles || [];
    currentModelCatalog = s.modelCatalog || { url: '', ttlHours: 24 };
    currentExtensionActivation = s.extensionActivation || { executablePlugins: false, allowedPluginNames: [], requirePermissionReview: true };
    currentModelDebugLog = s.modelDebugLog || { enabled: false, path: '.harness/model-debug.jsonl' };
    currentWalkthrough = s.walkthrough || { completed: [] };
    const small = document.getElementById('smallHelperModel');
    const def = document.getElementById('defaultHelperModel');
    const strong = document.getElementById('strongHelperModel');
    const fallback = document.getElementById('fallbackHelperModel');
    const confidence = document.getElementById('helperConfidenceThreshold');
    const vision = document.getElementById('visionModel');
    const audio = document.getElementById('audioTranscribeCommand');
    const pdfOcr = document.getElementById('pdfOcrCommand');
    const outputProfile = document.getElementById('outputValidationProfile');
    const outputToggle = document.getElementById('outputValidationToggle');
    const outputAutoToggle = document.getElementById('outputValidationAutoSelectToggle');
    const outputSkipLowSignalToggle = document.getElementById('outputValidationSkipLowSignalToggle');
    const catalogUrl = document.getElementById('modelCatalogUrl');
    const catalogTtl = document.getElementById('modelCatalogTtlHours');
    const extensionExecutableToggle = document.getElementById('extensionExecutableToggle');
    const extensionPermissionReviewToggle = document.getElementById('extensionPermissionReviewToggle');
    const extensionAllowedPluginNames = document.getElementById('extensionAllowedPluginNames');
    const modelDebugToggle = document.getElementById('modelDebugLogToggle');
    const modelDebugPath = document.getElementById('modelDebugLogPath');
    const firstRunHost = document.getElementById('firstRunOllamaHost');
    const firstRunVision = document.getElementById('firstRunVisionModel');
    const firstRunAudio = document.getElementById('firstRunAudioCommand');
    if (small) small.value = currentModelRouting.smallModel || '';
    if (def) def.value = currentModelRouting.defaultModel || '';
    if (strong) strong.value = currentModelRouting.strongModel || '';
    if (fallback) fallback.value = currentModelRouting.fallbackModel || '';
    if (confidence && currentModelRouting.confidenceEscalationThreshold !== undefined) confidence.value = currentModelRouting.confidenceEscalationThreshold;
    if (vision) vision.value = currentMediaTools.visionModel || '';
    if (audio) audio.value = currentMediaTools.audioTranscribeCommand || '';
    if (pdfOcr) pdfOcr.value = currentMediaTools.pdfOcrCommand || '';
    if (catalogUrl) catalogUrl.value = currentModelCatalog.url || '';
    if (catalogTtl) catalogTtl.value = currentModelCatalog.ttlHours || 24;
    if (extensionExecutableToggle) extensionExecutableToggle.classList.toggle('active', currentExtensionActivation.executablePlugins === true);
    if (extensionPermissionReviewToggle) extensionPermissionReviewToggle.classList.toggle('active', currentExtensionActivation.requirePermissionReview !== false);
    if (extensionAllowedPluginNames) extensionAllowedPluginNames.value = (currentExtensionActivation.allowedPluginNames || []).join(', ');
    if (modelDebugToggle) modelDebugToggle.classList.toggle('active', currentModelDebugLog.enabled === true);
    if (modelDebugPath) modelDebugPath.value = currentModelDebugLog.path || '.harness/model-debug.jsonl';
    const uploadsDirInput = document.getElementById('uploadsDir');
    if (uploadsDirInput) uploadsDirInput.value = currentMediaTools.uploadsDir || '';
    const autoPruneInput = document.getElementById('uploadsAutoPruneDays');
    if (autoPruneInput) autoPruneInput.value = currentMediaTools.uploadsAutoPruneDays || 0;
    const lastPrunedEl = document.getElementById('uploadsLastPrunedAt');
    if (lastPrunedEl) lastPrunedEl.textContent = currentMediaTools.uploadsLastPrunedAt ? 'Last pruned ' + new Date(currentMediaTools.uploadsLastPrunedAt).toLocaleString() : 'Never pruned';
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
    if (outputSkipLowSignalToggle) outputSkipLowSignalToggle.classList.toggle('active', currentOutputValidation.skipOnLowSignal === true);
    if (firstRunHost) firstRunHost.value = s.ollamaHost || 'http://localhost:11434';
    if (firstRunVision) firstRunVision.value = currentMediaTools.visionModel || '';
    if (firstRunAudio) firstRunAudio.value = currentMediaTools.audioTranscribeCommand || '';
    hydrateCuratorSettings(s.curator || {});
    hydrateAutomationSchedulerSettings(s.automationScheduler || {});
    hydrateBrowserRedaction(s.browserRedaction || {});
    document.querySelectorAll('.permission-mode-option').forEach((option) => option.classList.remove('active'));
    const modeIndex = s.permissionMode === 'dontAsk' ? 0 : s.permissionMode === 'acceptEdits' ? 1 : 2;
    const mode = document.querySelectorAll('.permission-mode-option')[modeIndex];
    if (mode) mode.classList.add('active');
    refreshAutonomyBanner();
    refreshVisionReadinessStatus();
    // Harness controls hydration
    hydrateInjectionMode(s.injectionDefence ? s.injectionDefence.mode : 'off');
    hydrateRbwMode(s.readBeforeWrite ? s.readBeforeWrite.mode : 'off');
    if (s.taskContract) renderTaskContract(s.taskContract);
  } catch(e){}
}

const _toastStack = [];
const _toastStyles = {
  success: { icon: '✅', border: '#50c878' },
  warning: { icon: '⚠️', border: '#ffb050' },
  error: { icon: '❌', border: '#ff5050' },
  info: { icon: 'ℹ️', border: '#8ab4f8' },
};
function showToast(message, durationMs, type) {
  const style = _toastStyles[type] || null;
  const borderColor = style ? style.border : 'var(--border,#444)';
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:10000;background:var(--surface2,#2a2a2a);color:var(--text,#e0e0e0);border:1px solid ' + borderColor + ';border-radius:8px;padding:10px 18px;font-size:13px;font-family:inherit;box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .3s,bottom .3s;cursor:pointer';
  toast.textContent = (style ? style.icon + ' ' : '') + message;
  toast.title = 'Click to dismiss';
  document.body.appendChild(toast);
  _toastStack.push(toast);
  _repositionToasts();
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  function dismiss() {
    if (toast._dismissed) return;
    toast._dismissed = true;
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
      const idx = _toastStack.indexOf(toast);
      if (idx >= 0) _toastStack.splice(idx, 1);
      _repositionToasts();
    }, 300);
  }
  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, durationMs || 3000);
}
function _repositionToasts() {
  let bottom = 20;
  for (let i = _toastStack.length - 1; i >= 0; i--) {
    _toastStack[i].style.bottom = bottom + 'px';
    bottom += _toastStack[i].offsetHeight + 8;
  }
}

function copyAuditJson(btn) {
  const pre = btn.parentElement?.querySelector('.audit-json-pre');
  if (pre) navigator.clipboard.writeText(pre.textContent).then(() => showToast('Copied to clipboard', 1500, 'success')).catch(() => showToast('Copy failed', 1500, 'error'));
}

const AUDIT_TYPE_COLORS = { 'grant.created': '#50c878', 'grant.revoked': '#ffb050', 'grant.expired': '#ff5050', 'automation_script.allowed': '#50c878', 'automation_script.denied': '#ff5050', 'autonomy.timed.engaged': '#ffb050', 'autonomy.timed.cleared': '#8ab4f8', 'autonomy.timed.expired': '#ff5050' };
const AUDIT_FILTER_MAP = { grant: ['grant.created', 'grant.revoked', 'grant.expired'], autonomy: ['autonomy.timed.engaged', 'autonomy.timed.cleared', 'autonomy.timed.expired'], automation: ['automation_script.allowed', 'automation_script.denied'] };

function renderAuditRowHtml(ev) {
  const tone = AUDIT_TYPE_COLORS[ev.type] ? 'audit-event-known' : 'audit-event-muted';
  const ts = ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '';
  const detail = ev.capabilityId ? ev.capabilityId : ev.command ? ev.command : '';
  const jsonDetail = JSON.stringify(ev, null, 2);
  return '<details class="audit-row"><summary class="trace-meta audit-summary"><span class="' + tone + '">' + esc(ev.type) + '</span> ' + esc(detail) + (ev.reason ? ' — ' + esc(ev.reason) : '') + (ev.presetId ? ' [' + esc(ev.presetId) + ']' : '') + '<span class="text-dim-inline">' + esc(ts) + '</span></summary>'
    + '<div class="audit-json-wrap"><pre class="audit-json-pre">' + esc(jsonDetail) + '</pre>'
    + '<button class="btn-sm btn-xxs-subtle audit-copy-btn" onclick="copyAuditJson(this)">Copy</button></div></details>';
}

let _autonomyBannerTimer = null;
let _autonomyWasActive = false;
function refreshAutonomyBanner() {
  if (_autonomyBannerTimer) { clearTimeout(_autonomyBannerTimer); _autonomyBannerTimer = null; }
  fetch('/api/permissions/state').then((r) => r.json()).then((state) => {
    const banner = document.getElementById('timedAutonomyBanner');
    // Also manage the global fixed banner visible from any tab
    renderGlobalAutonomyBanner(state);
    const isActive = state.autonomyExpiresAt && (new Date(state.autonomyExpiresAt).getTime() - Date.now()) > 0;
    // Detect expiry transition: was active, now isn't
    if (_autonomyWasActive && !isActive) {
      const prevLabel = state.mode === 'acceptEdits' ? 'Ask for commands' : state.mode === 'default' ? 'Ask for everything' : state.mode;
      showToast('⏱ Timed autonomy expired — reverted to ' + prevLabel, 5000);
    }
    _autonomyWasActive = !!isActive;
    if (!banner) return;
    if (state.autonomyExpiresAt) {
      const ms = new Date(state.autonomyExpiresAt).getTime() - Date.now();
      if (ms > 0) {
        const totalMin = Math.ceil(ms / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        const timeStr = h > 0 ? h + 'h ' + (m > 0 ? m + 'm' : '') : m + 'm';
        const prevLabel = state.autonomyPreviousMode === 'acceptEdits' ? 'Ask for commands' : state.autonomyPreviousMode === 'default' ? 'Ask for everything' : state.autonomyPreviousMode;
        const pct = _autonomyOriginalDurationMs > 0 ? Math.max(0, Math.min(100, (ms / _autonomyOriginalDurationMs) * 100)) : 100;
        banner.innerHTML = '<strong>⏱ Timed autonomy active:</strong> ' + esc(timeStr.trim()) + ' remaining → reverts to <strong>' + esc(prevLabel) + '</strong> <button class="btn-sm btn-inline-cancel" onclick="cancelTimedAutonomy()">Cancel</button>'
          + '<div class="timed-progress-track"><div class="timed-progress-fill" data-width-pct="' + pct.toFixed(1) + '"></div></div>';
        banner.classList.remove('hidden-by-default');
        applyDataWidths(banner);
        // Also sync the mode radio buttons in case it expired server-side
        document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
        const mi = state.mode === 'dontAsk' ? 0 : state.mode === 'acceptEdits' ? 1 : 2;
        const mo = document.querySelectorAll('.permission-mode-option')[mi];
        if (mo) mo.classList.add('active');
        // Schedule next refresh in 60s
        _autonomyBannerTimer = setTimeout(refreshAutonomyBanner, 60_000);
        return;
      }
    }
    banner.classList.add('hidden-by-default');
    banner.innerHTML = '';
    // Sync mode buttons in case autonomy expired
    if (state.mode) {
      document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
      const mi = state.mode === 'dontAsk' ? 0 : state.mode === 'acceptEdits' ? 1 : 2;
      const mo = document.querySelectorAll('.permission-mode-option')[mi];
      if (mo) mo.classList.add('active');
    }
  }).catch(() => {});
}

let _autonomyOriginalDurationMs = 0;
const GAB_COLLAPSED_KEY = 'globalAutonomyBannerCollapsed';

function isGlobalAutonomyBannerCollapsed() {
  try { return localStorage.getItem(GAB_COLLAPSED_KEY) === '1'; } catch(e){ return false; }
}

function setGlobalAutonomyBannerCollapsed(collapsed) {
  try { localStorage.setItem(GAB_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch(e){}
}

function clearGlobalAutonomyBannerLayout() {
  document.body.classList.remove('has-global-autonomy-banner');
  document.body.style.removeProperty('--gab-h');
}

function toggleGlobalAutonomyBanner() {
  setGlobalAutonomyBannerCollapsed(!isGlobalAutonomyBannerCollapsed());
  refreshAutonomyBanner();
}

function renderGlobalAutonomyBanner(state) {
  let banner = document.getElementById('globalAutonomyBanner');
  if (!state.autonomyExpiresAt) {
    if (banner) banner.remove();
    clearGlobalAutonomyBannerLayout();
    _autonomyOriginalDurationMs = 0;
    return;
  }
  const expiresAtMs = new Date(state.autonomyExpiresAt).getTime();
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) {
    if (banner) banner.remove();
    clearGlobalAutonomyBannerLayout();
    _autonomyOriginalDurationMs = 0;
    return;
  }
  // Track original duration on first render so we can compute %
  if (_autonomyOriginalDurationMs === 0) _autonomyOriginalDurationMs = ms;
  const pct = Math.max(0, Math.min(100, (ms / _autonomyOriginalDurationMs) * 100));
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const timeStr = h > 0 ? h + 'h ' + (m > 0 ? m + 'm' : '') : m + 'm';
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'globalAutonomyBanner';
    banner.className = 'global-autonomy-banner';
    banner.style.display = 'flex';
    document.body.appendChild(banner);
  }
  const collapsed = isGlobalAutonomyBannerCollapsed();
  banner.classList.toggle('collapsed', collapsed);
  // When collapsed we dock to the top-right corner instead of stretching
  // across the page, so resetting top to 0 (or kill-switch height) only
  // matters for the expanded layout.
  if (!collapsed) {
    const ksBanner = document.getElementById('killSwitchBanner');
    banner.style.top = ksBanner ? (ksBanner.offsetHeight + 'px') : '0';
  } else {
    banner.style.top = '';
  }
  const toggleIcon = collapsed ? '▾' : '▴';
  const toggleTitle = collapsed ? 'Expand timed-autonomy banner' : 'Collapse to a small pill';
  if (collapsed) {
    banner.innerHTML = '<div class="global-autonomy-row"><strong>⏱</strong> ' + esc(timeStr.trim())
      + '<button class="gab-toggle" type="button" title="' + escAttr(toggleTitle) + '" onclick="toggleGlobalAutonomyBanner()">' + toggleIcon + '</button></div>';
  } else {
    banner.innerHTML = '<div class="global-autonomy-row"><strong>⏱ Timed autonomy:</strong> ' + esc(timeStr.trim()) + ' remaining'
      + '<span class="global-autonomy-note">All tools + dontAsk mode active</span>'
      + '<button class="btn-sm btn-global-cancel" onclick="cancelTimedAutonomy()">Cancel</button>'
      + '<button class="gab-toggle" type="button" title="' + escAttr(toggleTitle) + '" onclick="toggleGlobalAutonomyBanner()">' + toggleIcon + '</button></div>'
      + '<div class="timed-progress-track global"><div class="timed-progress-fill" data-width-pct="' + pct.toFixed(1) + '"></div></div>';
  }
  applyDataWidths(banner);
  // Push the rest of the page down by the banner's actual height when it
  // sits across the top, but not when it's docked as a corner pill.
  if (collapsed) {
    clearGlobalAutonomyBannerLayout();
  } else {
    document.body.classList.add('has-global-autonomy-banner');
    document.body.style.setProperty('--gab-h', banner.offsetHeight + 'px');
  }
}

async function cancelTimedAutonomy() {
  if (!await confirmToast('Cancel timed autonomy and revert permission mode now?')) return;
  const clearTools = await confirmToast('Also clear all timed tool enables?\n\nYes = revert tools to disabled too\nNo = only revert permission mode, tools keep their timers');
  await fetch('/api/permissions/timed-autonomy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearTimedTools: clearTools }) });
  refreshAutonomyBanner();
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
}

async function loadOutputValidationTemplates() {
  try {
    const response = await fetch('/api/output-validation/templates');
    const data = await response.json();
    currentOutputValidationTemplates = data.templates || [];
    renderOutputValidationTemplates();
  } catch(e){}
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
  const validationDoc = '<div class="trace-detail"><strong>Validation profiles:</strong> Auto-select picks <code>oracle-prime</code> / <code>factual-answer</code> / <code>coding-answer</code> / <code>tool-result-summary</code> from prompt keywords. Vague prompts default to <code>oracle-prime</code> and can be skipped via <em>Skip validation on low-signal prompts</em>. See <code>docs/VALIDATION-PROFILES.md</code> for the full rules.</div>';
  panel.innerHTML = '<div class="about-grid">' + rows.map(([label, value]) => '<div><strong>' + esc(label) + '</strong> ' + String(value).replace(/^((?!<a ).)*$/, (text) => esc(text)) + '</div>').join('') + '</div>' + validationDoc;
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

// Single source of truth for the quick-start chips on the welcome card.
// Used by index.html (populated at DOMContentLoaded) and by welcomeMarkup
// (called after /new and /reset). Each entry mirrors what the chip will
// send when clicked: prompt text + a short "what this does" line. The
// onclick handler invokes sendTip() which sets chatInput to the title
// text and sends. Keep prompts beginner-friendly and span the full
// Harness range — files/code, web research, documents, automation,
// telegram, and agent personality — so the first impression is "I can
// just ask for anything", not "this is a code editor".
function quickStartChipsMarkup() {
  const chips = [
    ['📂', 'List files in this project', 'Tour what\'s here. I\'ll group by folder.'],
    ['🔍', 'Search for TODO in my code', 'Find loose ends across the whole tree.'],
    ['🌐', 'Find the latest news on Anthropic', 'Search the web and summarise what changed today.'],
    ['📊', 'Make me a one-page PDF business plan template', 'Generate a polished document I can edit.'],
    ['⏰', 'Every 24h send me a summary of what changed in this folder', 'Schedule a recurring automation job.'],
    ['🎭', 'Give yourself a name and a personality', 'Open Settings → Agent Identity to make it yours.'],
  ];
  return chips.map(([icon, title, desc]) =>
    '<div class="quick-card" onclick="sendTip(this.querySelector(\'.qc-title\'))">'
    + '<div class="qc-icon">' + icon + '</div>'
    + '<div class="qc-body"><div class="qc-title">' + esc(title) + '</div><div class="qc-desc">' + esc(desc) + '</div></div>'
    + '</div>'
  ).join('');
}

function refreshQuickStartChips() {
  const host = document.getElementById('quickSuggestions');
  if (host && !host.dataset.populated) {
    host.innerHTML = quickStartChipsMarkup();
    host.dataset.populated = '1';
  }
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
    { profile: 'oracle-prime', label: 'Oracle Prime', description: 'Full reasoning contract.' },
    { profile: 'factual-answer', label: 'Factual Answer', description: 'Direct factual answers.' },
    { profile: 'coding-answer', label: 'Coding Answer', description: 'Engineering summaries.' },
    { profile: 'tool-result-summary', label: 'Tool Result Summary', description: 'Command/tool summaries.' },
  ];
  select.innerHTML = knownProfiles.map((profile) => '<option value="' + escAttr(profile.profile) + '" title="' + escAttr(profile.description || profile.label || profile.profile) + '">' + esc(profile.label || profile.profile) + '</option>').join('');
  select.value = selected;
}

function currentCustomProfilesFromEditor() {
  const editor = document.getElementById('outputValidationProfilesJson');
  if (!editor) return [];
  try {
    const parsed = JSON.parse(editor.value || '{"profiles":[]}');
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch(e){
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
  const configured = context.configuredMaxTokens ?? context.effectiveMaxTokens ?? 0;
  const detected = context.detectedMaxTokens || 0;
  const effective = context.effectiveMaxTokens ?? configured;
  const configuredLabel = Number(configured) === 0 ? 'auto' : esc(configured) + ' tokens';
  details.innerHTML = '<div><strong>Configured</strong> ' + configuredLabel + '</div><div><strong>Detected</strong> ' + (detected ? esc(detected) + ' tokens' : 'not detected yet') + '</div><div><strong>Effective</strong> ' + esc(effective || 'unknown') + ' tokens</div>';
}

async function applyContextPreset(tokens) {
  const input = document.getElementById('contextMaxTokens');
  if (input) input.value = tokens;
  const response = await updateSetting('contextMaxTokens', tokens);
  try {
    const settings = await response.json();
    renderContextDetails(settings.context || { configuredMaxTokens: tokens, detectedMaxTokens: null, effectiveMaxTokens: tokens });
  } catch(e){}
}

function updateSetting(k, v, extraPayload) {
  const payload = { [k]: v, ...(extraPayload && typeof extraPayload === 'object' ? extraPayload : {}) };
  const request = fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (k === 'ollamaHost') loadModels();
  return request;
}

function updateModelDebugLogSetting(key, value) {
  currentModelDebugLog = { ...currentModelDebugLog, [key]: value };
  updateSetting('modelDebugLog', currentModelDebugLog);
}

function toggleModelDebugLog() {
  currentModelDebugLog = { ...currentModelDebugLog, enabled: !currentModelDebugLog.enabled };
  const toggle = document.getElementById('modelDebugLogToggle');
  if (toggle) toggle.classList.toggle('active', currentModelDebugLog.enabled);
  updateSetting('modelDebugLog', currentModelDebugLog);
}

const PERSONALITY_PRESETS = {
  professional: 'You are a precise, formal professional. Use structured language, clear headers, and avoid casual phrasing. Present information systematically with evidence and reasoning.',
  friendly: 'You are a warm, encouraging assistant who explains things clearly with relatable examples. Use a conversational tone, celebrate wins, and gently guide through challenges.',
  concise: 'You are extremely concise. Minimal prose. Lead with code, commands, or direct answers. Skip pleasantries. Use bullet points over paragraphs.',
  mentor: 'You are a patient mentor who teaches as you work. Explain your reasoning, point out why you chose one approach over another, and help the user learn from each interaction.',
  creative: 'You are imaginative and creative. Explore multiple approaches before settling on one. Use analogies, think outside the box, and suggest novel solutions the user might not have considered.',
  pirate: 'Arr! You be a capable and thorough AI pirate. You do the work properly and completely, but you speak like a seasoned buccaneer. Sprinkle in nautical metaphors. Call bugs "barnacles" and good code "seaworthy."',
};

function hydratePersonality(text) {
  const el = document.getElementById('personalityText');
  const sel = document.getElementById('personalityPreset');
  if (el) el.value = text;
  if (sel) {
    const match = Object.entries(PERSONALITY_PRESETS).find(([, v]) => v === text);
    sel.value = match ? match[0] : text ? 'custom' : '';
  }
}

function applyPersonalityPreset(preset) {
  const text = PERSONALITY_PRESETS[preset] || '';
  const el = document.getElementById('personalityText');
  if (el) el.value = text;
  if (preset !== 'custom') updateSetting('agentPersonality', text);
}

let currentAgentName = '';

function hydrateAgentName(name) {
  currentAgentName = name;
  const el = document.getElementById('agentNameInput');
  if (el) el.value = name;
  updateTopbarName(name);
  document.title = name ? name + ' — Ollama Agent Harness' : 'Ollama Agent Harness';
}

function updateAgentName(name) {
  currentAgentName = name.trim().slice(0, 100);
  updateSetting('agentName', currentAgentName);
  updateTopbarName(currentAgentName);
  document.title = currentAgentName ? currentAgentName + ' — Ollama Agent Harness' : 'Ollama Agent Harness';
}

function updateTopbarName(name) {
  const logo = document.getElementById('topbarLogo');
  if (!logo) return;
  const avatar = currentAgentAvatar || '🤖';
  // Preserve the #topbarPet span and .logo-word span so the mood pet
  // (driven by updateTopbarPet) and the agent name update independently.
  // Setting logo.textContent here would destroy the pet element and break
  // the topbar pet smoke test (and the live mood indicator).
  let pet = document.getElementById('topbarPet');
  let word = logo.querySelector('.logo-word');
  if (!pet || !word) {
    logo.innerHTML = '<span class="pet pet-idle" id="topbarPet" title="Harness mood: idle">' + avatar + '</span><span class="logo-word"> ' + (name || 'Harness') + '</span>';
    return;
  }
  pet.textContent = avatar;
  word.textContent = ' ' + (name || 'Harness');
}

let currentAgentAvatar = '';

function hydrateAgentAvatar(avatar) {
  currentAgentAvatar = avatar;
  highlightAvatarPick(avatar);
  updateTopbarName(currentAgentName);
}

function setAgentAvatar(emoji) {
  currentAgentAvatar = emoji;
  updateSetting('agentAvatar', emoji);
  highlightAvatarPick(emoji);
  updateTopbarName(currentAgentName);
}

function highlightAvatarPick(active) {
  document.querySelectorAll('.avatar-pick').forEach((btn) => {
    btn.style.outline = btn.textContent.trim() === active ? '2px solid var(--accent)' : 'none';
  });
}

function getAgentAvatar() {
  return currentAgentAvatar || '🤖';
}

let agentProfiles = {};

function hydrateAgentProfiles(profiles) {
  agentProfiles = profiles || {};
  const sel = document.getElementById('profileSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Load saved profile...</option>';
  for (const name of Object.keys(agentProfiles).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = (agentProfiles[name].avatar || '🤖') + ' ' + name;
    sel.appendChild(opt);
  }
}

async function saveAgentProfile() {
  const name = currentAgentName || await promptToast('Profile name:');
  if (!name) return;
  const model = document.getElementById('modelSelect')?.value || '';
  agentProfiles[name] = {
    name: currentAgentName,
    avatar: currentAgentAvatar,
    personality: document.getElementById('personalityText')?.value || '',
    model,
    accentColor: localStorage.getItem('harness-accent') || '',
  };
  // Persona bundle: also record the names of the currently-pinned skills and
  // configured MCP servers so the profile captures a whole use-case. Names
  // only — applying a profile never auto-pins or auto-starts anything.
  if (typeof HarnessPersonaBundle !== 'undefined') {
    const skillRows = (skillsState.runtime || []).map((s) => ({
      name: s.name,
      pinned: !!(skillsState.usageMap.get(s.name) || {}).pinned,
    }));
    const mcpRows = Array.from(window._mcpRuntimeServerIds || []).map((id) => ({ id }));
    agentProfiles[name].skills = HarnessPersonaBundle.extractPinnedSkillNames(skillRows);
    agentProfiles[name].mcp = HarnessPersonaBundle.extractMcpServerNames(mcpRows);
  }
  updateSetting('agentProfiles', agentProfiles);
  hydrateAgentProfiles(agentProfiles);
  showToast('Profile "' + name + '" saved.');
}

function loadAgentProfile(profileName) {
  if (!profileName || !agentProfiles[profileName]) return;
  const profile = agentProfiles[profileName];
  if (profile.name) { updateAgentName(profile.name); document.getElementById('agentNameInput').value = profile.name; }
  if (profile.avatar) setAgentAvatar(profile.avatar);
  if (profile.personality !== undefined) {
    const el = document.getElementById('personalityText');
    if (el) el.value = profile.personality;
    updateSetting('agentPersonality', profile.personality);
    hydratePersonality(profile.personality);
  }
  if (profile.model) {
    const sel = document.getElementById('modelSelect');
    if (sel) { sel.value = profile.model; updateSetting('model', profile.model); }
  }
  if (profile.accentColor) setAccentColor(profile.accentColor);
  // Persona bundle: surface (never auto-apply) the skills/MCP servers this
  // profile expects but the current environment lacks. Pinning and starting
  // stay manual so capability grants and the curator are never bypassed.
  if (typeof HarnessPersonaBundle !== 'undefined' && (profile.skills || profile.mcp)) {
    const pinnedSkills = (skillsState.runtime || [])
      .filter((s) => (skillsState.usageMap.get(s.name) || {}).pinned)
      .map((s) => s.name);
    const plan = HarnessPersonaBundle.computeStagingPlan(
      { skills: profile.skills, mcp: profile.mcp },
      { pinnedSkills, mcpServers: Array.from(window._mcpRuntimeServerIds || []) },
    );
    const hint = HarnessPersonaBundle.summarizeStagingPlan(plan);
    if (hint) showToast(hint, 7000);
  }
}

async function deleteAgentProfile() {
  const sel = document.getElementById('profileSelect');
  const name = sel?.value;
  if (!name) { showToast('Select a profile to delete.'); return; }
  if (!await confirmToast('Delete profile "' + name + '"?')) return;
  delete agentProfiles[name];
  updateSetting('agentProfiles', agentProfiles);
  hydrateAgentProfiles(agentProfiles);
}

function exportAgentProfiles() {
  if (Object.keys(agentProfiles).length === 0) { showToast('No profiles to export.'); return; }
  const blob = new Blob([JSON.stringify(agentProfiles, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agent-profiles-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
}

function importAgentProfiles(files) {
  if (!files || files.length === 0) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (typeof imported !== 'object' || imported === null) { showToast('Invalid profiles file.'); return; }
      const count = Object.keys(imported).length;
      if (!await confirmToast('Import ' + count + ' profile(s)? Existing profiles with the same name will be overwritten.')) return;
      Object.assign(agentProfiles, imported);
      updateSetting('agentProfiles', agentProfiles);
      hydrateAgentProfiles(agentProfiles);
      showToast('Imported ' + count + ' profile(s).');
    } catch(e){ showToast('Invalid JSON file.'); }
  };
  reader.readAsText(files[0]);
  document.getElementById('profileImportFile').value = '';
}

function hydrateAllowedPaths(paths) {
  const el = document.getElementById('allowedExternalPaths');
  if (el) el.value = (paths || []).join('\n');
}

function updateAllowedPaths(text) {
  const paths = text.split('\n').map((p) => p.trim()).filter(Boolean);
  window._currentAllowedPaths = paths;
  updateSetting('allowedExternalPaths', paths);
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

function updateModelCatalogSetting(k, v) {
  const next = { ...currentModelCatalog };
  if (k === 'ttlHours') {
    const parsed = Number(v);
    next.ttlHours = Number.isFinite(parsed) ? Math.max(1, Math.min(720, Math.floor(parsed))) : 24;
  } else {
    next[k] = String(v || '').trim();
  }
  currentModelCatalog = next;
  updateSetting('modelCatalog', next).then(loadDiscovery);
}

function toggleExtensionExecutablePlugins(el) {
  currentExtensionActivation = { ...currentExtensionActivation, executablePlugins: !currentExtensionActivation.executablePlugins };
  if (el) el.classList.toggle('active', currentExtensionActivation.executablePlugins === true);
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function toggleExtensionPermissionReview(el) {
  currentExtensionActivation = { ...currentExtensionActivation, requirePermissionReview: currentExtensionActivation.requirePermissionReview === false };
  if (el) el.classList.toggle('active', currentExtensionActivation.requirePermissionReview !== false);
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function updateExtensionAllowedPlugins(value) {
  currentExtensionActivation = { ...currentExtensionActivation, allowedPluginNames: String(value || '').split(',').map((item) => item.trim()).filter(Boolean) };
  updateSetting('extensionActivation', currentExtensionActivation).then(loadDiscovery);
}

function updateMediaToolSetting(k, v) {
  const next = { ...currentMediaTools };
  if (String(v).trim()) next[k] = String(v).trim();
  else delete next[k];
  currentMediaTools = next;
  const saved = updateSetting('mediaTools', next);
  if (k === 'visionModel') {
    setVisionReadinessStatus(null, 'checking');
    saved.then(refreshVisionReadinessStatus).catch(() => refreshVisionReadinessStatus());
  }
}

let currentCuratorSettings = {};
function hydrateCuratorSettings(curator) {
  currentCuratorSettings = curator || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) { if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value; } };
  set('curatorEnabled', currentCuratorSettings.enabled);
  set('curatorIntervalHours', currentCuratorSettings.intervalHours);
  set('curatorIdleMinutes', currentCuratorSettings.idleThresholdMinutes);
  set('curatorStaleDays', currentCuratorSettings.staleDays);
  set('curatorMinViews', currentCuratorSettings.minViewsBeforeArchive);
  set('curatorMaxArchive', currentCuratorSettings.maxArchivePerRun);
  set('curatorEnableLlm', currentCuratorSettings.enableLlmPhase);
}

async function updateCuratorSetting(key, value) {
  const next = { ...currentCuratorSettings, [key]: value };
  currentCuratorSettings = next;
  const status = document.getElementById('curatorSettingsStatus');
  if (status) { status.classList.remove('initial-hidden'); status.textContent = 'Saving…'; }
  try {
    await updateSetting('curator', next);
    if (status) status.textContent = 'Saved.';
    // Refresh the Skills tab Curator panel if it is open.
    if (typeof loadSkills === 'function' && document.getElementById('curatorPanel')) loadSkills();
  } catch (error) {
    if (status) status.textContent = 'Save failed: ' + (error.message || error);
  }
}

let currentAutomationSchedulerSettings = {};
function hydrateAutomationSchedulerSettings(settings) {
  currentAutomationSchedulerSettings = settings || {};
  const set = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) { if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value; } };
  set('automationSchedulerEnabled', currentAutomationSchedulerSettings.enabled !== false);
  set('automationSchedulerIdleMinutes', currentAutomationSchedulerSettings.idleThresholdMinutes || 2);
}

async function updateAutomationSchedulerSetting(key, value) {
  const next = { ...currentAutomationSchedulerSettings, [key]: value };
  currentAutomationSchedulerSettings = next;
  const status = document.getElementById('automationSchedulerSettingsStatus');
  if (status) { status.classList.remove('initial-hidden'); status.textContent = 'Saving…'; }
  try {
    await updateSetting('automationScheduler', next);
    if (status) status.textContent = 'Saved.';
  } catch (error) {
    if (status) status.textContent = 'Save failed: ' + (error.message || error);
  }
}

async function runUploadsCleanup() {
  const status = document.getElementById('uploadsCleanupStatus');
  const daysInput = document.getElementById('uploadsPruneDays');
  const days = Math.max(0, Math.min(3650, parseInt(daysInput?.value || '30', 10) || 0));
  if (status) {
    status.classList.remove('initial-hidden');
    status.textContent = 'Pruning uploads older than ' + days + ' day(s)…';
  }
  try {
    const response = await fetch('/api/uploads/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanDays: days }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Cleanup failed');
    const removed = Array.isArray(data.removed) ? data.removed.length : 0;
    const bytes = data.removedBytes || 0;
    if (status) status.textContent = 'Removed ' + removed + ' file(s), ' + bytes + ' bytes.';
    await loadSettings();
    await loadUploadsList();
  } catch (error) {
    if (status) status.textContent = 'Cleanup failed: ' + (error.message || error);
  }
}

async function loadUploadsList() {
  const el = document.getElementById('uploadsList');
  if (!el) return;
  el.textContent = 'Loading...';
  try {
    const response = await fetch('/api/uploads');
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) {
      el.textContent = '(no uploads in ' + (data.directory || 'uploads directory') + ')';
      return;
    }
    const totalKb = ((data.totalBytes || 0) / 1024).toFixed(1);
    let html = '<div>' + esc(data.directory || '') + ' · ' + files.length + ' file(s) · ' + totalKb + ' KB</div>';
    html += '<table class="uploads-list-table"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>';
    for (const file of files) {
      const sizeKb = (file.size / 1024).toFixed(1);
      html += '<tr><td>' + esc(file.name) + '</td><td>' + sizeKb + ' KB</td><td>' + esc(new Date(file.modified).toLocaleString()) + '</td>' +
        '<td><button class="btn-sm" onclick="deleteUpload(' + JSON.stringify(file.name).replace(/"/g, '&quot;') + ')">Delete</button></td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (error) {
    el.textContent = 'Failed to load uploads: ' + (error.message || error);
  }
}

async function deleteUpload(name) {
  if (!name) return;
  if (!await confirmToast('Delete upload "' + name + '"?')) return;
  try {
    const response = await fetch('/api/uploads/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + response.status));
    }
    await loadUploadsList();
  } catch (error) {
    showToast('Delete failed: ' + (error.message || error));
  }
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

function toggleOutputValidationSkipLowSignal(el) {
  currentOutputValidation = { ...currentOutputValidation, skipOnLowSignal: !currentOutputValidation.skipOnLowSignal };
  if (el) el.classList.toggle('active', currentOutputValidation.skipOnLowSignal === true);
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
    setVisionReadinessStatus(data.vision);
    if (detail) detail.innerHTML = renderSetupHealthRow('Ollama', data.ollama) + renderSetupHealthRow('Vision', data.vision) + renderSetupHealthRow('Audio', data.audio) + (data.pdfOcr ? renderSetupHealthRow('PDF OCR', data.pdfOcr) : '') + (data.ccmem ? renderSetupHealthRow('Long-term memory', data.ccmem) : '') + (data.webhooks ? renderSetupHealthRow('Webhooks', data.webhooks) : '');
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
    refreshVisionReadinessStatus();
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
    setVisionReadinessStatus(data.vision);
    if (detail) {
      detail.classList.remove('initial-hidden');
      detail.innerHTML = renderSetupHealthRow('Ollama', data.ollama) + renderSetupHealthRow('Vision', data.vision) + renderSetupHealthRow('Audio', data.audio) + (data.pdfOcr ? renderSetupHealthRow('PDF OCR', data.pdfOcr) : '');
    }
    if (data.ollama?.ok && Number(data.ollama.modelCount || 0) > 0) {
      setBeginnerReadiness('ready', 'Ready for first chat', data.ollama.message || 'Ollama is connected and at least one model is installed.', 'Ready');
      if (status) status.textContent = 'Setup check finished. You can start a chat.';
    } else if (data.ollama?.ok) {
      setBeginnerReadiness('warn', 'Install one model', data.ollama.message || 'Ollama is connected, but no models are installed.', 'Needs model');
      if (status) status.textContent = 'Setup check found no installed models.';
    } else {
      setBeginnerReadiness('blocked', 'Start Ollama first', data.ollama?.message || 'Harness cannot connect to Ollama yet.', 'Blocked');
      if (status) status.textContent = 'Setup check found an Ollama connection issue.';
    }
    markWalkthroughStep('setup');
  } catch (error) {
    if (detail) {
      detail.classList.remove('initial-hidden');
      detail.innerHTML = '<div><strong>Setup</strong> ' + esc(error.message || error) + '</div>';
    }
    setBeginnerReadiness('blocked', 'Setup check failed', String(error.message || error), 'Blocked');
    if (status) status.textContent = 'Setup check failed.';
  }
}

function renderSetupHealthRow(label, result) {
  const ok = result?.ok ? '✓' : '○';
  return '<div><strong>' + esc(label) + '</strong> ' + ok + ' ' + esc(result?.message || 'not checked') + '</div>';
}

function setVisionReadinessStatus(result, pendingLabel) {
  const el = document.getElementById('visionModelStatus');
  if (!el) return;
  el.classList.remove('ready', 'warn', 'error');
  if (!result) {
    el.textContent = pendingLabel || 'unknown';
    el.title = 'Vision setup has not been checked yet.';
    return;
  }
  el.textContent = result.ok ? 'ready' : 'not ready';
  el.title = result.message || 'Vision setup checked.';
  el.classList.add(result.ok ? 'ready' : 'warn');
}

async function refreshVisionReadinessStatus() {
  const el = document.getElementById('visionModelStatus');
  if (!el) return;
  setVisionReadinessStatus(null, 'checking');
  try {
    const host = document.getElementById('ollamaHost')?.value.trim() || 'http://localhost:11434';
    const visionModel = document.getElementById('visionModel')?.value.trim() || '';
    const params = new URLSearchParams({ ollamaHost: host, visionModel, audioTranscribeCommand: '', audioSamplePath: '' });
    const response = await fetch('/api/setup/health?' + params.toString());
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    setVisionReadinessStatus(data.vision);
  } catch (error) {
    el.textContent = 'error';
    el.title = 'Vision setup check failed: ' + (error.message || error);
    el.classList.remove('ready', 'warn');
    el.classList.add('error');
  }
}

async function setMode(m, el) {
  let escalationReason;
  if (m === 'dontAsk') {
    const reasonInput = await promptToast('Enter reason for enabling dontAsk mode (minimum 8 characters):', 'Temporary escalation for supervised operation');
    if (reasonInput === null) return;
    escalationReason = String(reasonInput).trim();
    if (escalationReason.length < 8) {
      showToast('Reason must be at least 8 characters.');
      return;
    }
  }
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  el.classList.add('active');
  updateSetting('permissionMode', m, escalationReason ? { reason: escalationReason } : undefined);
}

async function enableFullAutonomy() {
  // Set dontAsk mode
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  const dontAskOption = document.querySelectorAll('.permission-mode-option')[0];
  if (dontAskOption) dontAskOption.classList.add('active');
  await updateSetting('permissionMode', 'dontAsk', { reason: 'Enable full autonomy quick action from UI' });

  // Enable all disabled tools
  try {
    const toolsData = await fetch('/api/tools').then((r) => r.json());
    const disabled = toolsData.disabled || [];
    if (disabled.length > 0) {
      await fetch('/api/tools/bulk-toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: disabled, enabled: true }),
      });
    }
  } catch(e){ /* best effort */ }

  // Refresh the tools dashboard if visible
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
  showToast('Full autonomy enabled. All tools unlocked. Kill switch (Ctrl+Shift+K) is your emergency stop.', 4000, 'success');
}

async function enableTimedAutonomy() {
  const minutesRaw = await promptToast('Enable full autonomy for how many minutes? (1-1440)', '120');
  if (minutesRaw === null) return;
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) { showToast('Enter a number between 1 and 1440.'); return; }

  // Set timed autonomy via dedicated endpoint (stores previous mode for revert)
  await fetch('/api/permissions/timed-autonomy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInMinutes: minutes, reason: 'Enable timed autonomy quick action from UI' }),
  });

  // Update the UI to show dontAsk mode
  document.querySelectorAll('.permission-mode-option').forEach((o) => o.classList.remove('active'));
  const dontAskOption = document.querySelectorAll('.permission-mode-option')[0];
  if (dontAskOption) dontAskOption.classList.add('active');

  // Enable all disabled tools with a time limit
  try {
    const toolsData = await fetch('/api/tools').then((r) => r.json());
    const disabled = toolsData.disabled || [];
    if (disabled.length > 0) {
      await fetch('/api/tools/bulk-toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: disabled, enabled: true, expiresInMinutes: minutes }),
      });
    }
  } catch(e){ /* best effort */ }

  // Refresh the tools dashboard if visible
  if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
  const hours = minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60 ? (minutes % 60) + 'm' : '') : minutes + 'm';
  showToast('Timed autonomy enabled for ' + hours.trim() + '. Tools + permission mode auto-revert on expiry.', 4000, 'warning');
}

async function enableUnattendedRunway(minutes = 120) {
  const duration = Math.max(1, Math.min(1440, Number(minutes) || 120));
  const button = document.getElementById('unattendedRunwayBtn');
  if (button) {
    button.disabled = true;
    button.textContent = 'Enabling...';
  }
  try {
    await fetch('/api/permissions/timed-autonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInMinutes: duration, reason: 'One-click unattended runway from chat window' }),
    });

    document.querySelectorAll('.permission-mode-option').forEach((option) => option.classList.remove('active'));
    const dontAskOption = document.querySelectorAll('.permission-mode-option')[0];
    if (dontAskOption) dontAskOption.classList.add('active');

    try {
      const toolsData = await fetch('/api/tools').then((response) => response.json());
      const disabled = toolsData.disabled || [];
      if (disabled.length > 0) {
        await fetch('/api/tools/bulk-toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: disabled, enabled: true, expiresInMinutes: duration }),
        });
      }
    } catch(e){}

    await grantUnattendedCapabilities(duration);

    if (typeof loadToolsDashboard === 'function') loadToolsDashboard();
    if (typeof loadReadiness === 'function') await loadReadiness();
    if (typeof loadNervousStatus === 'function') loadNervousStatus();
    refreshAutonomyBanner();
    setUnattendedRunwayButton(duration);
    const label = duration >= 60 ? Math.floor(duration / 60) + 'h' + (duration % 60 ? ' ' + (duration % 60) + 'm' : '') : duration + 'm';
    showToast('Keep going is on for ' + label + '. Retry the request from this window.', 4500, 'success');
  } catch (error) {
    showToast('Could not enable unattended runway: ' + (error.message || error), 5000, 'error');
    setUnattendedRunwayButton(0);
  }
}

async function grantUnattendedCapabilities(minutes) {
  const commonCapabilityIds = ['arbitrary-shell', 'background-autonomous-jobs', 'self-modifying-code'];
  const capabilities = await fetch('/api/capabilities').then((response) => response.json()).catch(() => null);
  const items = capabilities?.capabilities || [];
  for (const capabilityId of commonCapabilityIds) {
    const item = items.find((capability) => capability.id === capabilityId);
    if (!item || item.posture !== 'gated') continue;
    await fetch('/api/capabilities/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId,
        controls: item.requiredControls || [],
        reason: 'One-click unattended runway from chat window',
        expiresInMinutes: minutes,
      }),
    }).catch(() => {});
  }
}

function setUnattendedRunwayButton(minutes) {
  const button = document.getElementById('unattendedRunwayBtn');
  if (!button) return;
  button.disabled = false;
  if (minutes > 0) {
    button.classList.add('active');
    button.textContent = 'Keep going ' + (minutes >= 60 ? Math.floor(minutes / 60) + 'h' : minutes + 'm');
    button.title = 'Harness can keep working for a limited time.';
    return;
  }
  button.classList.remove('active');
  button.textContent = 'Keep going';
  button.title = 'Let Harness keep working for 2 hours';
}

async function handleFileAttach(fileList) {
  for (const file of fileList) {
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': file.name }, body: file });
      const data = await res.json();
      if (data.error) { showToast('Upload failed: ' + data.error); continue; }
      pendingFiles.push(data);
      showAttached();
    } catch (e) { showToast('Upload failed: ' + e.message); }
  }
  document.getElementById('fileInput').value = '';
}

function showAttached() {
  const el = document.getElementById('attachedFiles');
  if (!pendingFiles.length) { el.style.display = 'none'; renderAttachmentHint(); return; }
  el.style.display = 'flex';
  el.innerHTML = pendingFiles.map((f, i) => {
    const streamBtn = mediaKind(f) === 'pdf'
      ? ' <button class="attachment-icon-btn accent" onclick="streamPdfExtract(' + i + ')" title="Stream PDF extraction">⇩</button>'
      : '';
    return '<span class="attached-file-chip" title="' + escAttr(mediaKind(f)) + ' attachment">' + mediaIcon(f) + ' ' + esc(mediaKind(f)) + ': ' + esc(f.name) + streamBtn + ' <button class="attachment-icon-btn danger" onclick="removeAttached(' + i + ')" title="Remove attachment">✕</button></span>';
  }).join('');
  renderAttachmentHint();
}

async function streamPdfExtract(index) {
  const file = pendingFiles[index];
  if (!file) return;
  const dialog = document.createElement('div');
  dialog.className = 'pdf-stream-modal';
  dialog.innerHTML = '<div class="pdf-stream-dialog"><div class="pdf-stream-header"><strong>Streaming pages from ' + esc(file.name) + '</strong><button id="closePdfStream" class="attachment-icon-btn text" title="Close PDF stream">✕</button></div><div id="pdfStreamLog" class="pdf-stream-log"></div><div id="pdfStreamStatus" class="pdf-stream-status">Connecting…</div></div>';
  document.body.appendChild(dialog);
  const log = dialog.querySelector('#pdfStreamLog');
  const status = dialog.querySelector('#pdfStreamStatus');
  const close = () => { try { source.close(); } catch(e){} dialog.remove(); };
  dialog.querySelector('#closePdfStream').onclick = close;
  // Backdrop click should also close — otherwise the EventSource leaks
  // when the user dismisses by clicking outside the dialog body.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  const source = new EventSource('/api/pdf/extract?path=' + encodeURIComponent(file.path));
  let pages = 0;
  source.addEventListener('page', (e) => {
    try {
      const data = JSON.parse(e.data);
      pages++;
      const block = document.createElement('div');
      block.innerHTML = '<div class="pdf-stream-page-title">--- Page ' + data.pageNum + ' ---</div><div class="prewrap-text">' + esc(data.text || '(empty)') + '</div>';
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
      status.textContent = 'Streamed ' + pages + ' page(s)…';
    } catch(e){}
  });
  source.addEventListener('done', (e) => {
    try { const data = JSON.parse(e.data); status.textContent = 'Done. ' + data.pages + ' pages.'; } catch(e){}
    source.close();
  });
  source.addEventListener('error', (e) => {
    let msg = 'Stream error.';
    try { msg = 'Error: ' + (JSON.parse(e.data).message || msg); } catch(e){}
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

function promptAddWorkspaceFolder() {
  const folder = window.prompt('Enter the full folder path to let the AI read/write:\n(e.g. D:\\Brad\\Downloads\\my-project)', '');
  if (!folder || !folder.trim()) return;
  const path = folder.trim();
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedExternalPaths: [...(window._currentAllowedPaths || []), path] }),
  }).then((r) => r.ok ? r.json() : Promise.reject(r))
    .then(() => {
      window._currentAllowedPaths = [...(window._currentAllowedPaths || []), path];
      const el = document.getElementById('allowedExternalPaths');
      if (el) el.value = (window._currentAllowedPaths || []).join('\n');
      const input = document.getElementById('chatInput');
      if (input) {
        input.value = (input.value ? input.value + '\n' : '') + 'I\'ve allowed access to ' + path + '. Please explore it and tell me what\'s there.';
        input.dispatchEvent(new Event('input'));
        document.getElementById('sendBtn')?.removeAttribute('disabled');
      }
    })
    .catch(() => alert('Failed to add path. Check the console for details.'));
}

function handleChatPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/gif' ? 'gif' : file.type === 'image/webp' ? 'webp' : 'png';
        const named = new File([file], 'pasted-image-' + Date.now() + '.' + ext, { type: file.type });
        imageFiles.push(named);
      }
    }
  }
  if (imageFiles.length > 0) {
    event.preventDefault();
    handleFileAttach(imageFiles);
  }
}

function handleKey(e) {
  // Slash palette intercepts navigation keys when visible.
  if (slashPaletteState.visible) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashSelection(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSlashSelection(-1); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applySelectedSlashCommand(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); hideSlashPalette(); return; }
    if (e.key === 'Tab')       { e.preventDefault(); applySelectedSlashCommand(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  // Ctrl+Enter: alternative send
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
  // Escape: stop streaming if active
  if (e.key === 'Escape' && activeChatController) { e.preventDefault(); activeChatController.abort(); }
  // Ctrl+/: open slash commands
  if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    if (input) { input.value = '/'; input.focus(); autoSize(input); maybeShowSlashPalette('/'); }
  }
}
function autoSize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  // Re-evaluate slash palette every keystroke so it appears as soon as the
  // user types `/` and disappears the moment the prefix becomes invalid.
  maybeShowSlashPalette(el.value);
  // Plain-English requests (no slash) get a one-click feature suggestion.
  maybeShowIntentChip(el.value);
}

// Same auto-grow pattern as the chat composer, but for the Autonomy
// task input. No slash-palette hook (autonomy tasks are plain prose,
// not commands). 240px ceiling matches the CSS max-height.
function autoSizeTaskInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 240) + 'px';
}
function sendTip(el) { document.getElementById('chatInput').value = el.textContent; sendMessage(); }

async function sendMessage(opts) {
  // Mark guided tour as seen on first send
  try { localStorage.setItem('harness_tour_seen', '1'); } catch(e){}
  // Clear any plain-English feature suggestion once the message is sent.
  hideIntentChip();
  // opts.regenerateFromIndex: when set, drop chatMessages from that index
  // onwards (typically a stale assistant reply) and re-run with the
  // existing user prompt that lives at index-1. Used by the per-message
  // 🔁 Regenerate button.
  if (isSending && activeChatController) {
    activeChatController.abort();
    return;
  }
  // Side-by-side compare mode: route to the parallel runner instead.
  // Only triggers for fresh sends (regenerate stays single-model so
  // history slicing stays simple).
  if (compareEnabled && !(opts && typeof opts.regenerateFromIndex === 'number')) {
    const inp = document.getElementById('chatInput');
    const text = inp.value.trim();
    if (!text) return;
    const modelA = document.getElementById('modelSelect').value;
    const modelB = document.getElementById('compareModelSelect').value;
    if (!modelA || !modelB) { showToast('Pick a primary model AND a compare model first.'); return; }
    if (modelA === modelB) { showToast('Pick two different models to compare.'); return; }
    inp.value = '';
    inp.style.height = 'auto';
    runCompareSend(text, modelA, modelB);
    return;
  }
  const inp = document.getElementById('chatInput');
  const isRegenerate = opts && typeof opts.regenerateFromIndex === 'number';
  let text;
  let attachmentsForTurn = [];

  // /task command: intercept and add to the autonomy plan instead of chatting.
  if (!isRegenerate && inp.value.trim().toLowerCase().startsWith('/task ')) {
    const taskText = inp.value.trim().slice(6).trim();
    if (taskText) {
      inp.value = '';
      inp.style.height = 'auto';
      addMsg('user', '/task ' + taskText);
      try {
        const response = await fetch('/api/autonomy/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: taskText, description: taskText }) });
        const data = await readApiJson(response, 'Add task API');
        addMsg('assistant', '✅ Task added to plan: **' + taskText + '**\n\nTask ID: `' + data.id + '` · ' + data.pending + ' pending task(s)\n\nOpen Work tools to start it, or type another `/task`.');
        loadAutonomyPlanPreview();
        loadReadiness();
      } catch (error) {
        addMsg('assistant', '❌ Failed to add task: ' + (error.message || error));
      }
      return;
    }
  }

  // /schedule command: create an automation job that runs on a schedule.
  // Supports: /schedule every 6h Check hotel prices
  //           /schedule every 30m Monitor stock
  //           /schedule Check prices (defaults to every 24h)
  if (!isRegenerate && inp.value.trim().toLowerCase().startsWith('/schedule ')) {
    const scheduleText = inp.value.trim().slice(10).trim();
    if (scheduleText) {
      inp.value = '';
      inp.style.height = 'auto';
      addMsg('user', '/schedule ' + scheduleText);
      try {
        const intervalMatch = scheduleText.match(/^every\s+(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\s+/i);
        let minutes = 1440; // default: 24h
        let prompt = scheduleText;
        let intervalLabel = 'every 24 hours';
        if (intervalMatch) {
          const value = parseInt(intervalMatch[1], 10);
          const unit = intervalMatch[2].charAt(0).toLowerCase();
          minutes = unit === 'h' ? value * 60 : value;
          minutes = Math.max(1, minutes);
          intervalLabel = unit === 'h' ? 'every ' + value + ' hour(s)' : 'every ' + value + ' minute(s)';
          prompt = scheduleText.slice(intervalMatch[0].length).trim();
        }
        const name = prompt.slice(0, 50).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Scheduled job';
        const response = await fetch('/api/automations/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, prompt, schedule: minutes + ' minutes' }) });
        const data = await readApiJson(response, 'Create automation API');
        addMsg('assistant', '✅ Automation job created: **' + name + '**\n\nSchedule: ' + intervalLabel + ' (' + minutes + ' minutes)\n\nThe job will run automatically while the server is running. Open the **Runs** tab to manage it.');
      } catch (error) {
        addMsg('assistant', '❌ Failed to create automation: ' + (error.message || error));
      }
      return;
    }
  }

  // /run <target>: launch the Active Goal primitive end-to-end. Creates the
  // goal via POST /api/goals, then streams iteration SSE events from
  // /api/goals/:id/start into per-iteration cards rendered inline in chat.
  if (!isRegenerate && /^\s*\/run\s+\S/i.test(inp.value)) {
    const target = inp.value.replace(/^\s*\/run\s+/i, '').trim();
    if (target) {
      const userText = inp.value;
      hideSlashPalette();
      inp.value = '';
      autoSize(inp);
      addMsg('user', userText);
      runActiveGoalFromChat(target);
      return;
    }
  }

  // /<skill-name> [args]: rewrite to "Use the skill: name with input: args" so
  // the agent picks it up via existing trigger matching. Only applies when the
  // first token matches a known runtime skill.
  if (!isRegenerate && /^\s*\/[a-z][\w-]*/i.test(inp.value)) {
    const trimmed = inp.value.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const cmdToken = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const skillCmd = dynamicSkillSlashCommands.find((c) => c.cmd.toLowerCase() === cmdToken);
    if (skillCmd) {
      const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
      const skillName = cmdToken.slice(1);
      inp.value = args
        ? 'Use the skill: ' + skillName + ' with input: ' + args
        : 'Use the skill: ' + skillName;
      autoSize(inp);
      hideSlashPalette();
      // Fall through to the normal send path below.
    }
  }

  if (isRegenerate) {
    const userMsg = chatMessages[opts.regenerateFromIndex - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    text = userMsg.content;
    // Drop the stale assistant reply (and any later turns) from history
    // and from the DOM so the regenerated reply takes its place.
    chatMessages = chatMessages.slice(0, opts.regenerateFromIndex);
    const area = document.getElementById('chatArea');
    const allMsgs = Array.from(area.querySelectorAll('.msg, .tool-activity, .followup-chips'));
    // Find the user message DOM index that corresponds to opts.regenerateFromIndex - 1
    // and remove every node that follows it.
    let userMsgCount = 0;
    let truncateAt = -1;
    for (let i = 0; i < allMsgs.length; i++) {
      if (allMsgs[i].classList.contains('msg') && allMsgs[i].classList.contains('user')) {
        if (userMsgCount === opts.regenerateFromIndex - 1) {
          truncateAt = i + 1;
          break;
        }
        userMsgCount++;
      }
    }
    if (truncateAt >= 0) {
      for (let i = allMsgs.length - 1; i >= truncateAt; i--) allMsgs[i].remove();
    }
  } else {
    text = inp.value.trim();
  }
  const model = document.getElementById('modelSelect').value;
  if (!isRegenerate && pendingFiles.length > 0) {
    attachmentsForTurn = pendingFiles.map((f) => ({ name: f.name, path: f.path, mediaKind: mediaKind(f), size: f.size, mimeType: f.mimeType }));
    const fileInfo = pendingFiles.map((f) => '- ' + mediaKind(f) + ': name="' + f.name + '" path="' + f.path + '"').join('\n');
    const mediaConfig = '[Media tools: visionModel=' + (currentMediaTools.visionModel || model || 'not configured') + '; audioTranscribeCommand=' + (currentMediaTools.audioTranscribeCommand ? 'configured' : 'not configured') + '; pdfOcrCommand=' + (currentMediaTools.pdfOcrCommand ? 'configured' : 'not configured') + ']';
    text = (text ? text + '\n\n' : '') + '[Selected model: ' + model + ']\n' + mediaConfig + '\n[Attached files]\n' + fileInfo + '\n\nIMPORTANT: When you call file_read, pdf_read, image_analyze, or audio_transcribe for an attachment, you MUST pass the exact "path" string above (do not strip the .harness/uploads/ prefix and do not pass only the filename). Call list_uploads first if you are unsure which attachments are available. Please analyze the attached file(s). For image attachments, use image_analyze with the configured vision model when available, otherwise use the selected model if it supports vision. For audio attachments, use audio_transcribe first, then analyze the transcript. For PDF attachments, use pdf_read (and pdf_metadata when document properties matter); set ocr=true if the first read returns no extractable text. If a required media tool is not configured, say that clearly.';
    pendingFiles = [];
    showAttached();
  }

  if (!text || isSending) return;
  if (!model) { showToast('Select a model first.'); return; }
  // If the user clicked 💬 Reply on an earlier assistant message, prefix
  // the outbound text with a markdown blockquote of that reply so the
  // model can resolve "this", "that error", etc. unambiguously. The
  // chip clears after one send.
  if (!isRegenerate && pendingReply && pendingReply.snippet) {
    const quoteLines = String(pendingReply.snippet).split('\n').slice(0, 6).map((l) => '> ' + l).join('\n');
    text = quoteLines + '\n\n' + text;
    pendingReply = null;
    renderPendingReplyChip();
  }
  const skipOnceEl = document.getElementById('skipValidationOnce');
  const skipValidationOnce = !!(skipOnceEl && skipOnceEl.checked);
  if (!skipValidationOnce) await maybeSuggestOutputValidationProfile(text);
  lastValidationPrompt = text;
  try { localStorage.setItem(LAST_VALIDATION_PROMPT_KEY, text.slice(0, 500)); } catch(e){}
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
  if (!isRegenerate) {
    addMsg('user', text);
    chatMessages.push({ role: 'user', content: text });
    saveChatSession();
    inp.value = '';
    inp.style.height = 'auto';
  }
  // Strip any prior follow-up chips and context cards so they don't pile up.
  document.querySelectorAll('.followup-chips, .context-cards').forEach((n) => n.remove());
  isSending = true;
  const _sendTabId = activeTabId;
  _markTabStatus(_sendTabId, 'streaming');
  // Per-turn citation collector: every successful web_read becomes a
  // numbered source under the assistant reply. Keeps the model from
  // having to parrot the URL inline.
  const turnCitations = [];
  activeChatController = new AbortController();
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = false;
  sendBtn.textContent = '■';
  sendBtn.title = 'Stop (streaming)';
  sendBtn.classList.add('streaming');
  const badge = document.getElementById('streamingBadge'); if (badge) badge.classList.add('active');
  const thinkEl = addThinking();
  updateThinkingStatus(thinkEl, 'Preparing model...');
  // Live tok/s estimate: count characters streaming in, divide by
  // elapsed seconds, convert to ~tokens (chars/4). Updates the thinking
  // pill on a 250ms interval so the user sees real-time speed.
  const streamStartedAt = Date.now();
  let streamedChars = 0;
  let firstTokenAtMs = 0;
  let tokRateTimer = null;
  let assistantText = '';
  let msgEl = null;
  let toolBox = null;
  let evidenceCard = null;
  let toolOnlyResultCount = 0;
  let toolOnlyFailureCount = 0;
  let toolOnlySummaries = [];
  let doneReason = '';
  const clientEvidenceTools = [];
  const clientEvidenceCommands = [];
  const updateTokRate = () => {
    if (!thinkEl.parentNode) return;
    const elapsedSec = (Date.now() - streamStartedAt) / 1000;
    if (elapsedSec < 0.4 || streamedChars === 0) return;
    const tokPerSec = (streamedChars / 4) / elapsedSec;
    if (tokPerSec >= 0.5) {
      updateThinkingStatus(thinkEl, 'Streaming · ~' + tokPerSec.toFixed(1) + ' tok/s');
    }
  };
  tokRateTimer = setInterval(updateTokRate, 250);
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model, skipValidation: skipValidationOnce, history: outboundChatHistory(), attachments: attachmentsForTurn }), signal: activeChatController.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sawModelEvent = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith(':')) {
          if (!sawModelEvent) updateThinkingStatus(thinkEl, 'Model is loading or evaluating the prompt...');
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch(e){ continue; }
        sawModelEvent = true;
        // First real model event — update the thinking status from
        // "Preparing model..." to something concrete. Without this, runs
        // that go through tool_calls before producing text leave the
        // user staring at "Preparing model..." for the entire tool phase.
        if (thinkEl.parentNode && ev.type !== 'text' && ev.type !== 'error') {
          const toolName = ev.type === 'tool_call' && ev.call?.name ? ev.call.name : null;
          const toolIcon = toolName === 'file_write' ? '📝' : toolName === 'file_edit' ? '✏️' : toolName === 'file_read' ? '📖' : toolName === 'bash' ? '💻' : toolName === 'web_search' ? '🔍' : toolName === 'web_read' ? '🌐' : toolName === 'web_fetch' ? '🌐' : toolName === 'list_files' ? '📂' : toolName === 'grep' ? '🔎' : toolName ? '🔧' : '';
          const label = ev.type === 'tool_call' ? (toolIcon + ' ' + (toolName || 'tool') + '...').trim()
            : ev.type === 'tool_result' ? '⏳ Processing result...'
            : ev.type === 'usage' ? 'Working...'
            : ev.type === 'context' ? 'Compacting context...'
            : 'Working...';
          updateThinkingStatus(thinkEl, label);
        }
        switch (ev.type) {
          case 'text':
            thinkEl.remove();
            if (!firstTokenAtMs && (ev.content || '').length > 0) firstTokenAtMs = Date.now();
            if (!msgEl) msgEl = addMsg('assistant', '');
            assistantText += ev.content;
            streamedChars += (ev.content || '').length;
            renderMd(msgEl.querySelector('.msg-content'), assistantText);
            scrollBottom();
            break;
          case 'goal_appended':
            // Server signal that /goal appended tasks. Render a Start
            // button under the response so a first-time user can run
            // autonomy in one click without hunting for the dashboard.
            if (msgEl) attachGoalStartButton(msgEl, ev.taskCount || 1, ev.planPath || 'IMPLEMENTATION_PLAN.md');
            break;
          case 'tool_call':
            notePetToolCall();
            toolBox = ensureToolBox(toolBox);
            if (ev.call.name === 'file_edit' && ev.call.input && typeof ev.call.input.old_string === 'string' && typeof ev.call.input.new_string === 'string') {
              appendDiffToolItem(toolBox, ev.call.name, String(ev.call.input.path || '?'), ev.call.input.old_string, ev.call.input.new_string);
            } else if (ev.call.name === 'file_write' && ev.call.input && typeof ev.call.input.content === 'string') {
              const len = ev.call.input.content.length;
              const preview = ev.call.input.content.split('\n').slice(0, 3).join('\n');
              appendToolItem(toolBox, '📝', 'file_write', String(ev.call.input.path || '?') + ' (' + len + ' chars) — ' + preview.slice(0, 80), false);
            } else {
              appendToolItem(toolBox, '🔧', ev.call.name, JSON.stringify(ev.call.input).slice(0, 80), false);
            }
            break;
          case 'tool_result':
            toolOnlyResultCount += 1;
            if (!ev.result.success) toolOnlyFailureCount += 1;
            else {
              const summary = summarizeToolOnlyResult(ev.call, ev.result);
              if (summary) toolOnlySummaries.push(summary);
            }
            clientEvidenceTools.push({
              name: ev.call?.name || 'tool',
              success: Boolean(ev.result?.success),
              inputSummary: JSON.stringify(ev.call?.input || {}).slice(0, 220),
              outputSummary: String(ev.result?.output || '').slice(0, 220),
            });
            if (ev.call?.name === 'bash' && typeof ev.call?.input?.command === 'string') {
              clientEvidenceCommands.push({ command: ev.call.input.command, success: Boolean(ev.result?.success), outputSummary: String(ev.result?.output || '').slice(0, 220) });
            }
            if (toolBox) appendToolItem(toolBox, ev.result.success ? '✅' : '❌', '', ev.result.output.slice(0, 120), !ev.result.success);
            if (toolBox && !ev.result.success && isPermissionOrRecoveryFailure(ev.result.output)) appendPermissionRecoveryItem(toolBox, ev.result.output);
            // Capture web_read sources for citation rendering.
            if (ev.result.success && ev.call && ev.call.name === 'web_read' && ev.call.input && typeof ev.call.input.url === 'string') {
              const url = ev.call.input.url;
              if (!turnCitations.find((c) => c.url === url)) {
                turnCitations.push({ url, title: extractCitationTitle(ev.result.output, url) });
              }
            }
            refreshSkillSurfacesAfterToolResult(ev.call, ev.result, toolBox);
            refreshEmailListAfterToolResult(ev.call, ev.result);
            break;
          case 'provider_fallback':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'provider fallback', ev.fromBackend + ' → ' + ev.toBackend + (ev.cooldownSec ? ' · cooldown ' + ev.cooldownSec + 's' : '') + ' · ' + (ev.reason || 'limit reached'), false);
            break;
          case 'model_retry':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🔁', 'model retry', (ev.model || 'model') + ' attempt ' + ev.attempt + '/' + ev.maxAttempts + (ev.delayMs ? ' · waited ' + Math.round(ev.delayMs / 100) / 10 + 's' : '') + ' · ' + (ev.reason || 'transient failure'), false);
            updateThinkingStatus(thinkEl, 'Retrying model call...');
            break;
          case 'model_routed':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🧭', 'model routed', ev.from + ' → ' + ev.to + (ev.reason ? ' · ' + ev.reason : ''), false);
            break;
          case 'mode_classification':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🏷️', 'mode: ' + (ev.mode || 'unknown').toUpperCase(), ev.reason + (ev.suppressedModes && ev.suppressedModes.length ? ' · suppressed: ' + ev.suppressedModes.join(', ') : ''), false);
            break;
          case 'context_warning':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'context warning', ev.message || ('~' + ev.estimatedTokens + ' tokens vs ' + ev.maxTokens + ' limit'), true);
            break;
          case 'context_breakdown':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🧮', 'context budget', formatContextBreakdown(ev), ev.totalTokens > ev.maxTokens);
            break;
          case 'usage':
            // Fold per-LLM-call usage into the running session totals (topbar
            // HUD) and stash the latest values so we can paint the assistant
            // message footer once the turn finishes.
            sessionUsage.calls += 1;
            sessionUsage.promptTokens += ev.promptTokens || 0;
            sessionUsage.completionTokens += ev.completionTokens || 0;
            sessionUsage.totalDurationMs += ev.totalDurationMs || 0;
            sessionUsage.lastModel = ev.model;
            updateSessionHud();
            // Per-message footer reflects the most recent LLM call only —
            // multi-turn sequences accumulate into the topbar instead.
            currentTurnUsage = {
              model: ev.model,
              promptTokens: ev.promptTokens || 0,
              completionTokens: ev.completionTokens || 0,
              totalDurationMs: ev.totalDurationMs || 0,
              loadDurationMs: ev.loadDurationMs || 0,
              promptEvalDurationMs: ev.promptEvalDurationMs || 0,
              evalDurationMs: ev.evalDurationMs || 0,
            };
            break;
          case 'turn_complete':
            // Enrich the current turn usage with wall-clock turn duration
            // so the message footer shows total turn time (model + tools).
            if (currentTurnUsage) currentTurnUsage.turnDurationMs = ev.durationMs;
            sessionUsage.totalTurnMs += ev.durationMs || 0;
            updateSessionHud();
            break;
          case 'run_cost':
            // Honest run-level cost verdict (server-side rollup). Renders a
            // "100% local · $0" badge only when every call was provably local.
            renderRunCost(ev);
            break;
          case 'answer_confidence':
            // Honest answer-confidence verdict (server-side). Renders an
            // abstention or stated-confidence band; stays silent when unstated.
            renderAnswerConfidence(ev);
            break;
          case 'run_provenance':
            // Honest, auditable run provenance (server-side): which model
            // produced the run, when, and from what sources. Stays silent
            // when nothing beyond a timestamp is provable.
            renderRunProvenance(ev);
            break;
          case 'governed_shadow':
            // Opt-in governed pass (HARNESS_GOVERNED_SHADOW). Surfaces HOW the
            // answer knows (confidence mode) plus the self-critique findings
            // inline under the answer, and refreshes the review queue panel so
            // any newly staged items appear without a manual reload.
            renderGovernedShadow(msgEl, ev.governed);
            if (typeof loadReviewQueue === 'function') loadReviewQueue();
            if (typeof loadGovernanceMetrics === 'function') loadGovernanceMetrics();
            break;
          case 'offline':
            // Honest offline guarantee (server-side): a 🔒 Offline badge only
            // when the run was provably local; 🌐 Online when it provably
            // reached the network; silent when offline can't be confirmed.
            renderOffline(ev);
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
          case 'verification':
            toolBox = ensureToolBox(toolBox);
            appendVerificationItem(toolBox, ev);
            break;
          case 'output_validation_profile_promoted':
            // Auto-promotion from oracle-prime to coding-answer when
            // productive tools succeeded. Surface it so the validation
            // result's profile name doesn't look mysterious.
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🧭', 'profile auto-promoted', esc(ev.from) + ' → ' + esc(ev.to) + ' (' + esc(ev.reason) + ')', false);
            break;
          case 'output_validation_profile':
            toolBox = ensureToolBox(toolBox);
            appendOutputValidationProfileItem(toolBox, ev);
            break;
          case 'history_trimmed':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '✂️', 'history trimmed', ev.droppedTurns + ' older turn(s) dropped to fit ~' + ev.historyTokenBudget + '-token budget · ' + ev.keptTurns + ' kept', false);
            break;
          case 'uploads_fallback':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'uploads fallback', (ev.tool ? ev.tool + ' ' : '') + 'requested "' + ev.requested + '" → resolved to ' + ev.resolved, false);
            break;
          case 'uploads_fallback_summary':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '⚠️', 'uploads fallback summary', ev.suppressed + ' duplicate event(s) suppressed across ' + ev.unique + ' unique fallback(s)', false);
            break;
          case 'uploads_fallback_advice':
            toolBox = ensureToolBox(toolBox);
            appendUploadsFallbackAdvice(toolBox, ev);
            break;
          case 'evidence':
            evidenceCard = ev.evidence;
            break;
          case 'readiness':
            if (toolBox || msgEl) {
              const box = toolBox || ensureToolBox(toolBox);
              const scoreColor = ev.score >= 0.80 ? 'var(--success,#50c878)' : ev.score >= 0.60 ? 'var(--warning,orange)' : 'var(--danger,#e55)';
              const icon = ev.decision === 'execute' ? '✅' : ev.decision === 'verify' ? '⚠️' : '🔴';
              appendToolItem(box, icon, 'readiness ' + Math.round(ev.score * 100) + '%',
                ev.decision + ' · ' + (ev.reasons || []).slice(0, 2).join(' · '),
                false);
            }
            break;
          case 'escalation_advisory':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🔴', 'escalation suggested',
              'Readiness ' + Math.round(ev.readinessScore * 100) + '% — try ' + esc(ev.suggestedModel) + ' for better results',
              false);
            break;
          case 'synthesis_fired':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🔄', 'synthesis turn', 'model exhausted ' + ev.maxTurns + ' tool turns (' + ev.toolCallsTotal + ' calls) — forcing text summary', false);
            break;
          case 'time_budget_status': {
            // Update or create the time budget progress bar in the thinking indicator.
            const pct = Math.min(100, Math.round((ev.elapsedMs / ev.budgetMs) * 100));
            const remaining = Math.max(0, Math.round((ev.budgetMs - ev.elapsedMs) / 1000));
            let bar = thinkEl.querySelector('.time-budget-bar');
            if (!bar) {
              bar = document.createElement('div');
              bar.className = 'time-budget-bar';
              bar.style.cssText = 'margin-top:4px;height:4px;border-radius:2px;background:var(--surface2);overflow:hidden;max-width:200px';
              const fill = document.createElement('div');
              fill.className = 'time-budget-fill';
              fill.style.cssText = 'height:100%;border-radius:2px;transition:width .5s,background .3s';
              bar.appendChild(fill);
              const label = document.createElement('div');
              label.className = 'time-budget-label';
              label.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px';
              bar.appendChild(label);
              thinkEl.appendChild(bar);
            }
            const fill = bar.querySelector('.time-budget-fill');
            const label = bar.querySelector('.time-budget-label');
            if (fill) {
              fill.style.width = pct + '%';
              fill.style.background = pct > 80 ? 'var(--danger,#e55)' : pct > 50 ? 'var(--warning,orange)' : 'var(--accent,#6cf)';
            }
            if (label) label.textContent = remaining + 's remaining · turn ' + ev.turn;
            // Also show countdown in the topbar streaming badge so it's
            // visible even when the thinking element scrolls off-screen.
            const badge = document.getElementById('streamingBadge');
            if (badge) {
              const icon = pct > 80 ? '🟡' : '🔴';
              badge.textContent = icon + ' turn ' + ev.turn + ' · ' + remaining + 's left';
            }
            break;
          }
          case 'auto_continue':
            toolBox = ensureToolBox(toolBox);
            appendToolItem(toolBox, '🔁', 'auto-continue #' + ev.continuationCount, ev.reason + ' — continuing autonomously', false);
            break;
          case 'error':
            notePetError();
            thinkEl.remove();
            msgEl = addMsg('assistant', '⚠️ ' + ev.message);
            break;
          case 'done':
            doneReason = ev.reason || '';
            // Surface the completed-but-validation-failed reason so users
            // do not mistake it for an early stop. The 🧪 validation
            // detail already rendered above; this is just a one-line
            // badge under the assistant message.
            if (ev.reason === 'completed_with_validation_failures') {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '⚠️', 'completed with validation failures', 'work finished but the output validator rejected the final reply', true);
            }
            if (ev.reason === 'completed_with_test_failures') {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '❌', 'completed with test failures', 'files were edited but tsc/eslint/tests failed — review the verification card above', true);
            }
            if (ev.reason === 'time_budget_synthesized') {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '⏱️', 'time budget reached', 'wall-clock limit reached — model synthesized a summary of its work', false);
            }
            if (ev.reason === 'repetition_synthesized') {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '🔁', 'repetition detected', 'model was repeating itself — forced synthesis to break the loop', false);
            }
            if (ev.reason === 'empty_after_tools_synthesized') {
              toolBox = ensureToolBox(toolBox);
              appendToolItem(toolBox, '📝', 'empty final turn recovered', 'model ran tools then returned no answer — forced synthesis to write one', false);
            }
            break;
        }
      }
    }
    if (thinkEl.parentNode) thinkEl.remove();
    if (!assistantText && toolOnlyResultCount > 0) {
      if (doneReason === 'max_turns_synthesized' || doneReason === 'time_budget_synthesized' || doneReason === 'repetition_synthesized' || doneReason === 'empty_after_tools_synthesized') {
        // Bonus synthesis turn fired but produced empty text — rare edge case.
        assistantText = buildToolOnlyFallback(toolOnlyFailureCount, toolOnlySummaries, 'The model synthesized a response, but it came back empty.');
      } else {
        assistantText = buildToolOnlyFallback(toolOnlyFailureCount, toolOnlySummaries);
      }
      msgEl = addMsg('assistant', assistantText);
    }
    if (assistantText) chatMessages.push({ role: 'assistant', content: assistantText });
    // Jarvis voice: always dispatch so the hands-free loop can re-arm the
    // mic even when a turn ended in error or yielded no text. The TTS
    // listener already guards on `text` being non-empty before speaking,
    // so an empty payload is safe.
    try { document.dispatchEvent(new CustomEvent('jarvis-assistant-message', { detail: { text: assistantText || '' } })); } catch { /* noop */ }
    if (msgEl && currentTurnUsage) {
      if (firstTokenAtMs) currentTurnUsage.firstTokenLatencyMs = firstTokenAtMs - streamStartedAt;
      currentTurnUsage.toolCallCount = toolOnlyResultCount;
      attachMessageMeta(msgEl, currentTurnUsage);
      currentTurnUsage = null;
    }
    if (msgEl && evidenceCard) attachEvidenceCard(msgEl, evidenceCard);
    // Citations: render numbered source list under the assistant reply
    // and rewrite any URL mentions in the visible text to [n] superscripts.
    if (msgEl && turnCitations.length > 0) {
      attachCitations(msgEl, turnCitations, assistantText);
    }
    // Per-message actions: 🔁 Regenerate + 📋 Copy. Index points at the
    // assistant message we just appended, so regenerate slices history
    // back to right before it.
    if (msgEl && assistantText) {
      attachMessageActions(msgEl, chatMessages.length - 1);
    }
    // Follow-up chips: 3 short suggested next prompts derived from the
    // latest exchange. Computed client-side (no extra round-trip).
    if (assistantText && text) {
      renderFollowUpChips(text, assistantText);
    }
    // Inline context cards: surface the skills / memories / workflows the
    // mycelium router actually selected for this turn, so users do not
    // have to learn the left-rail tabs to discover them.
    renderMyceliumContextCards(text || '').catch(() => {});
    // Inbox refresh: an automation run may have completed mid-chat, or
    // the assistant may have queued a new plan task. Cheap poll keeps
    // the strip honest without waiting for the 60s tick.
    loadInbox().catch(() => {});
    saveChatSession();
    autoSaveChat();
    loadSettings();
  } catch (e) {
    if (thinkEl.parentNode) thinkEl.remove();
    notePetError();
    if (e.name === 'AbortError') {
      msgEl = addMsg('assistant', 'Stopped.');
      evidenceCard = buildClientStoppedEvidence(text, model, clientEvidenceTools, clientEvidenceCommands, 'user_stopped');
      attachEvidenceCard(msgEl, evidenceCard);
    } else {
      msgEl = addMsg('assistant', '⚠️ ' + e.message);
      evidenceCard = buildClientStoppedEvidence(text, model, clientEvidenceTools, clientEvidenceCommands, 'client_error');
      attachEvidenceCard(msgEl, evidenceCard);
    }
  }
  if (tokRateTimer) clearInterval(tokRateTimer);
  isSending = false;
  activeChatController = null;
  _markTabStatus(_sendTabId, 'done');
  // If this tab is still active, also snapshot state to the session
  if (_sendTabId === activeTabId) {
    const tab = sessionTabs.get(_sendTabId);
    if (tab) { tab.chatMessages = [...chatMessages]; tab.currentChatId = currentChatId; tab.isSending = false; tab.activeChatController = null; }
  }
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('sendBtn').textContent = '➤';
  document.getElementById('sendBtn').title = 'Send';
  document.getElementById('sendBtn').classList.remove('streaming');
  const badge2 = document.getElementById('streamingBadge'); if (badge2) { badge2.classList.remove('active'); badge2.textContent = '🔴 streaming'; }
  const skipOnceReset = document.getElementById('skipValidationOnce');
  if (skipOnceReset) skipOnceReset.checked = false;
  document.getElementById('chatInput').focus();
}

function refreshSkillSurfacesAfterToolResult(call, result, toolBox) {
  if (!result || result.success !== true || !call || !call.name) return;
  const skillMutatingTools = ['create_skill', 'promote_pattern', 'improve_skill'];
  const output = String(result.output || '');
  const wroteSkillFile = /(?:^|[\\/.])\.harness[\\/]skills[\\/].*SKILL\.md/i.test(output);
  if (!skillMutatingTools.includes(call.name) && !wroteSkillFile) return;
  loadSkills();
  loadDiscovery();
  appendOpenSkillsAction(toolBox);
}

function appendOpenSkillsAction(toolBox) {
  if (!toolBox) return;
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.innerHTML = '<span>↗</span><span class="tool-name">skill saved</span><span class="tool-detail">Available in the Skills tab.</span><button id="openSkillsAfterSaveBtn" class="btn-sm" onclick="openSkillsTab()">Open Skills</button>';
  toolBox.appendChild(item);
  scrollBottom();
}

function refreshEmailListAfterToolResult(call, result) {
  if (!result || !call || !call.name) return;
  if (call.name === 'email_send' || call.name === 'email_draft') {
    loadEmailList();
  }
}

function openSkillsTab() {
  revealLeftPanel();
  const tab = Array.from(document.querySelectorAll('.tab')).find((element) => element.getAttribute('onclick')?.includes("showLeftTab('skills'"));
  if (tab) showLeftTab('skills', tab);
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
  } catch(e){}
}

function formatOutputValidation(validation) {
  const firstFinding = validation.findings && validation.findings[0] ? ' · ' + validation.findings[0].message : '';
  return validation.profile + ' ' + validation.status + ' · score ' + validation.score + firstFinding;
}

function appendUploadsFallbackAdvice(toolBox, event) {
  const item = document.createElement('div');
  item.className = 'tool-item';
  const tools = Array.isArray(event.tools) && event.tools.length > 0 ? event.tools.join(', ') : 'a tool';
  const findingMsg = (event.message || 'Bare-filename attachment access detected.') + ' Tools affected: ' + tools + '.';
  item.innerHTML = '<span>🧪</span><span class="tool-name">attachment usage</span>' +
    '<span class="validation-groups">' +
    '<strong>uploads-fallback warn · ' + esc(String(event.unique || 0)) + ' unique</strong>' +
    '<div class="validation-group">WARN: bare-filename-attachment - ' + esc(findingMsg) + ' Try: Call list_uploads first or pass the exact .harness/uploads/ path.</div>' +
    '</span>' +
    '<span class="profile-feedback profile-feedback-spaced">' +
    '<button class="btn-sm" data-vote="dismiss" title="Acknowledge and hide this advice for this turn">Dismiss</button>' +
    '</span>';
  const dismissBtn = item.querySelector('button[data-vote="dismiss"]');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => { item.style.display = 'none'; });
  }
  toolBox.appendChild(item);
  scrollBottom();
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

function appendVerificationItem(toolBox, ev) {
  const checks = ev.checks || [];
  const icon = ev.overall === 'pass' ? '✅' : ev.overall === 'fail' ? '❌' : ev.overall === 'warn' ? '⚠️' : '⏭️';
  const label = ev.overall === 'pass' ? 'tests passed' : ev.overall === 'fail' ? 'tests failed' : ev.overall === 'warn' ? 'tests warned' : 'tests skipped';
  const detail = checks.map((c) => {
    const s = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'warn' ? '⚠' : '–';
    return s + ' ' + c.name + (c.duration_ms != null ? ' (' + c.duration_ms + 'ms)' : '') + (c.detail ? ': ' + c.detail : '');
  }).join(' · ') || (ev.overall === 'skip' ? 'no checks ran (no tsconfig / test script found)' : '');
  const item = document.createElement('div');
  item.className = 'tool-item' + (ev.overall === 'fail' ? ' error' : '');
  item.innerHTML = '<span>' + icon + '</span><span class="tool-name">' + label + '</span><span class="tool-detail">' + esc(detail) + '</span>';
  toolBox.appendChild(item);
  HarnessToolActivity.updateToolActivitySummary(toolBox, ev.overall === 'fail');
  scrollBottom();
}

function appendOutputValidationProfileItem(toolBox, event) {
  const item = document.createElement('div');
  item.className = 'tool-item';
  const reason = event.reason || '';
  const label = /no strong signal|validation skipped/i.test(reason) ? 'Defaulted to ' : 'Auto-selected ';
  const profile = event.profile || 'default';
  const source = event.source || 'auto-selected';
  item.innerHTML = '<span>🧭</span><span class="tool-name">validation profile</span>' +
    '<span class="tool-detail">' + label + esc(profile) + '. ' + esc(reason) + '</span>' +
    '<span class="profile-feedback profile-feedback-spaced">' +
    '<button class="btn-sm" data-vote="up" title="This profile fits the prompt">👍</button>' +
    '<button class="btn-sm" data-vote="down" title="This profile does not fit the prompt">👎</button>' +
    '</span>';
  const wrapper = item.querySelector('.profile-feedback');
  if (wrapper) {
    wrapper.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => sendProfileFeedback(button, profile, button.getAttribute('data-vote'), source, reason));
    });
  }
  toolBox.appendChild(item);
  scrollBottom();
}

async function sendProfileFeedback(button, profile, vote, selectionSource, selectionReason) {
  const wrapper = button.parentElement;
  if (wrapper) wrapper.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await fetch('/api/output-validation/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, vote, selectionSource, selectionReason, prompt: lastValidationPrompt }),
    });
    if (wrapper) wrapper.innerHTML = '<span class="tool-detail">' + (vote === 'up' ? 'Thanks — recorded as good.' : 'Thanks — recorded as a miss.') + '</span>';
  } catch(e){
    if (wrapper) wrapper.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

function ensureToolBox(toolBox) {
  if (toolBox) return toolBox;
  return HarnessToolActivity.createToolActivityBox(document, document.getElementById('chatArea'));
}

function appendToolItem(toolBox, icon, name, detail, isError) {
  const item = document.createElement('div');
  item.className = 'tool-item' + (isError ? ' error' : '');
  item.innerHTML = '<span>' + icon + '</span>' + (name ? '<span class="tool-name">' + esc(name) + '</span>' : '') + '<span class="tool-detail">' + esc(detail) + '</span>';
  toolBox.appendChild(item);
  HarnessToolActivity.updateToolActivitySummary(toolBox, isError);
  scrollBottom();
}

function summarizeToolOnlyResult(call, result) {
  const output = String(result?.output || '').replace(/\s+/g, ' ').trim();
  if (!output) return '';
  const name = String(call?.name || 'tool');
  const input = call?.input || {};
  const target = typeof input.query === 'string' ? input.query
    : typeof input.url === 'string' ? input.url
    : typeof input.path === 'string' ? input.path
    : '';
  const label = target ? name + ' for "' + target.slice(0, 90) + '"' : name;
  return label + ': ' + output.slice(0, 260);
}

function buildToolOnlyFallback(failureCount, summaries, lead) {
  const uniqueSummaries = Array.from(new Set((summaries || []).filter(Boolean))).slice(0, 4);
  const intro = lead || (failureCount > 0
    ? 'I used tools, but one or more tool calls failed before the model wrote a final answer.'
    : 'I used tools and got results, but the model did not write a final answer.');
  if (uniqueSummaries.length === 0) {
    return intro + '\n\nOpen Tool activity above to inspect what happened, then use Regenerate to ask for a normal answer.';
  }
  return intro
    + '\n\nWhat I could see from the tool results:\n'
    + uniqueSummaries.map((summary) => '- ' + summary).join('\n')
    + '\n\nUse Regenerate if you want me to turn this into a normal answer.';
}

function isPermissionOrRecoveryFailure(output) {
  return /Permission denied|Nervous System|requires verification|Recovery mode active|requires confirmation/i.test(String(output || ''));
}

function appendPermissionRecoveryItem(toolBox, output) {
  const item = document.createElement('div');
  item.className = 'tool-item tool-item-permission';
  item.innerHTML = '<span>⚠️</span><span class="tool-name">Action blocked</span><span class="tool-detail">' + esc(String(output || '').slice(0, 180)) + '</span><button class="btn-sm primary" type="button">Keep going 2h</button>';
  const button = item.querySelector('button');
  if (button) button.addEventListener('click', async () => {
    await enableUnattendedRunway(120);
  });
  toolBox.appendChild(item);
  HarnessToolActivity.updateToolActivitySummary(toolBox, true);
  scrollBottom();
}

/**
 * Render a unified-diff-style preview of a file_edit tool call. Shows up
 * to 12 lines from old + 12 from new with - / + prefixes, color-coded.
 * Truncated long lines and large blocks are summarized so the trace
 * stays scannable.
 */
function appendDiffToolItem(toolBox, name, filePath, oldStr, newStr) {
  const item = document.createElement('div');
  item.className = 'tool-item tool-item-diff';
  const oldLines = String(oldStr).split(/\r?\n/);
  const newLines = String(newStr).split(/\r?\n/);
  const MAX_LINES = 12;
  const MAX_LINE_LEN = 160;
  const trim = (lines) => {
    const slice = lines.slice(0, MAX_LINES);
    const trimmed = slice.map((line) => line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + ' …' : line);
    return { trimmed, overflow: lines.length - slice.length };
  };
  const oldT = trim(oldLines);
  const newT = trim(newLines);
  const summary = oldLines.length + ' line(s) → ' + newLines.length + ' line(s)';
  const renderBlock = (lines, prefix, cls, overflow) => {
    let html = '';
    for (const line of lines) html += '<div class="diff-line ' + cls + '">' + esc(prefix + line) + '</div>';
    if (overflow > 0) html += '<div class="diff-line diff-overflow">… ' + overflow + ' more line(s)</div>';
    return html;
  };
  item.innerHTML =
    '<span>📝</span>'
    + '<span class="tool-name">' + esc(name) + '</span>'
    + '<span class="tool-detail">' + esc(filePath) + ' · ' + esc(summary) + '</span>'
    + '<div class="diff-block">'
    + renderBlock(oldT.trimmed, '- ', 'diff-del', oldT.overflow)
    + renderBlock(newT.trimmed, '+ ', 'diff-add', newT.overflow)
    + '</div>';
  toolBox.appendChild(item);
  HarnessToolActivity.updateToolActivitySummary(toolBox, false);
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

function formatContextBreakdown(ev) {
  return '~' + ev.totalTokens + '/' + ev.maxTokens + ' tokens · system ' + ev.systemTokens + ' · history ' + ev.historyTokens + ' · tools ' + ev.toolResultTokens + ' · current ' + ev.currentUserTokens;
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

let autonomyPollTimer = null;
let autonomyEventSource = null;
function startAutonomyPolling() {
  if (autonomyPollTimer) clearInterval(autonomyPollTimer);
  if (autonomyEventSource) { autonomyEventSource.close(); autonomyEventSource = null; }

  // Prefer SSE: pushes updates the moment the autonomy loop writes its
  // checkpoint, with zero polling overhead. Fall back to 3s polling if
  // EventSource is unavailable, the stream errors, or the server response
  // is non-event-stream (e.g. running an older server build).
  if (typeof window.EventSource !== 'function') {
    pollAutonomy();
    autonomyPollTimer = setInterval(pollAutonomy, 3000);
    return;
  }

  try {
    autonomyEventSource = new EventSource('/api/autonomy/state/stream');
    autonomyEventSource.onmessage = (evt) => {
      try {
        const data = evt.data === 'null' ? null : JSON.parse(evt.data);
        renderAutonomyState(data);
      } catch(e){ /* ignore malformed frames */ }
    };
    autonomyEventSource.onerror = () => {
      // Browsers auto-reconnect on transient errors; only switch to
      // polling if reconnect is impossible (readyState === CLOSED).
      if (autonomyEventSource && autonomyEventSource.readyState === EventSource.CLOSED) {
        autonomyEventSource = null;
        pollAutonomy();
        autonomyPollTimer = setInterval(pollAutonomy, 3000);
      }
    };
  } catch(e){
    pollAutonomy();
    autonomyPollTimer = setInterval(pollAutonomy, 3000);
  }
}

function renderAutonomyState(s) {
  const hud = document.getElementById('autonomyHud');
  const builderStatus = document.getElementById('autonomyBuilderStatus');
  if (!hud) return;
  if (!s) {
    statusCenterAutonomyState = 'idle';
    refreshStatusCenter();
    hud.classList.add('hidden-by-default');
    if (builderStatus) builderStatus.textContent = 'No active autonomy state yet. Start 1 task to see live movement.';
    return;
  }
  hud.classList.remove('hidden-by-default');
  const taskEl = document.getElementById('autonomyHudTask');
  const countsEl = document.getElementById('autonomyHudCounts');
  const status = s.lastTaskStatus || 'idle';
  statusCenterAutonomyState = status;
  refreshStatusCenter();
  const statusLabel = describeAutonomyStatus(status);
  const icon = status === 'running' ? '⏳' : status === 'done' ? '✅' : status === 'failed' ? '❌' : '•';
  if (taskEl) taskEl.textContent = `${icon} ${s.lastTaskId || 'idle'}`;
  if (countsEl) {
    const done = s.totalDone ?? 0;
    const failed = s.totalFailed ?? 0;
    const pending = s.totalPending ?? 0;
    countsEl.textContent = `${done}✓ ${failed}✗ ${pending}⋯`;
  }
  const elapsed = s.lastTaskElapsedMs ? `${Math.round(s.lastTaskElapsedMs / 1000)}s` : '';
  const files = (s.lastTaskFilesChanged ?? null) !== null ? `${s.lastTaskFilesChanged} files` : '';
  hud.title = [s.lastTaskTitle, elapsed, files].filter(Boolean).join(' · ');
  if (builderStatus) {
    const parts = [
      `Live: ${statusLabel}`,
      s.lastTaskId || 'idle',
      elapsed,
      files,
    ].filter(Boolean);
    builderStatus.textContent = parts.join(' · ');
  }
}

let lastAutonomyStatus = '';

async function pollAutonomy() {
  try {
    const r = await fetch('/api/autonomy/state');
    if (r.status === 204) { renderAutonomyState(null); return; }
    if (!r.ok) { renderAutonomyState(null); return; }
    const s = await r.json();
    renderAutonomyState(s);
    // Notify when autonomy transitions from running to done/failed.
    const status = s?.status || '';
    if (lastAutonomyStatus === 'running' && status !== 'running' && status) {
      notifyUser('Autonomy run ' + status, s?.currentTask || 'Task finished.');
      loadAutonomyPlanPreview();
      loadReadiness();
    }
    lastAutonomyStatus = status;
  } catch(e){
    renderAutonomyState(null);
  }
}

function notifyUser(title, body) {
  // Badge the page title.
  if (!document.title.startsWith('🔔 ')) document.title = '🔔 ' + document.title;
  // Browser notification (if permission granted).
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '🤖' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

let autonomyLogTimer = null;
function _clearAutonomyLogTimer() {
  if (autonomyLogTimer) { clearInterval(autonomyLogTimer); autonomyLogTimer = null; }
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', _clearAutonomyLogTimer);
}
function toggleAutonomyLog() {
  const modal = document.getElementById('autonomyLogModal');
  if (!modal) { _clearAutonomyLogTimer(); return; }
  const isOpen = !modal.classList.contains('hidden-by-default');
  if (isOpen) {
    modal.classList.add('hidden-by-default');
    _clearAutonomyLogTimer();
    return;
  }
  modal.classList.remove('hidden-by-default');
  refreshAutonomyLog();
  _clearAutonomyLogTimer();
  autonomyLogTimer = setInterval(refreshAutonomyLog, 2000);
}

async function refreshAutonomyLog() {
  const body = document.getElementById('autonomyLogBody');
  if (!body) return;
  try {
    const r = await fetch('/api/autonomy/log?lines=200');
    if (r.status === 204) { body.textContent = '(no autonomy run yet — start one with `npm run autonomy`)'; return; }
    if (!r.ok) { body.textContent = `error: HTTP ${r.status}`; return; }
    const d = await r.json();
    body.textContent = (d.lines || []).join('\n');
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.textContent = `error: ${err && err.message ? err.message : String(err)}`;
  }
}

async function pollPermissions() {
  try {
    const r = await fetch('/api/permissions/pending');
    const d = await r.json();
    renderPermissionPrompts(d.prompts || []);
  } catch(e){}
}

function renderPermissionPrompts(prompts) {
  const panel = document.getElementById('permissionPanel');
  statusCenterPendingPermissions = prompts.length;
  refreshStatusCenter();
  if (!prompts.length) { panel.className = 'permission-panel hidden'; panel.innerHTML = ''; return; }
  panel.className = 'permission-panel';
  // data-id on the card so resolvePermission can find this exact card and
  // mark it as resolving immediately on click — without that flag the user
  // has to wait for the next pollPermissions tick (up to 1s) to see any
  // feedback that their Approve / Deny click registered.
  panel.innerHTML = prompts.map((prompt) => '<div class="permission-card" data-prompt-id="' + escAttr(prompt.id) + '"><div><div class="permission-title">Approve tool: ' + esc(prompt.call.name) + '</div><div class="permission-reason">' + esc(prompt.reason || 'Permission required') + '</div><code>' + esc(JSON.stringify(prompt.call.input).slice(0, 180)) + '</code></div><div class="permission-actions"><button class="btn-sm pp-approve" onclick="resolvePermission(\'' + escAttr(prompt.id) + '\',true)">Approve</button><button class="btn-sm danger pp-deny" onclick="resolvePermission(\'' + escAttr(prompt.id) + '\',false)">Deny</button></div></div>').join('');
}

async function resolvePermission(id, allowed) {
  // Immediate visual feedback: mark the card as resolving, disable both
  // buttons, and relabel the chosen one. Without this the click feels
  // dead until the next pollPermissions() tick (~1s) finally re-renders.
  const card = document.querySelector('.permission-card[data-prompt-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  let approveBtn, denyBtn;
  if (card) {
    card.classList.add('resolving');
    approveBtn = card.querySelector('.pp-approve');
    denyBtn = card.querySelector('.pp-deny');
    if (approveBtn) approveBtn.disabled = true;
    if (denyBtn) denyBtn.disabled = true;
    const chosen = allowed ? approveBtn : denyBtn;
    if (chosen) chosen.textContent = allowed ? 'Approving…' : 'Denying…';
  }
  try {
    const res = await fetch('/api/permissions/' + encodeURIComponent(id) + '/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed }) });
    if (res.status === 404) {
      // The prompt is no longer pending on the server — it timed out, was
      // already resolved, or the server restarted since this card was last
      // polled. That's a benign race, not a failure: drop the stale card and
      // re-sync rather than alarming with a red "Could not approve" error.
      if (card) card.remove();
      showToast('That permission request already expired — it is no longer pending.', 3500, 'warning');
      pollPermissions().catch((err) => console.warn('pollPermissions follow-up failed', err));
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail.slice(0, 160) : ''));
    }
    showToast(allowed ? '✅ Tool approved' : '🚫 Tool denied', 2500, allowed ? 'success' : 'warning');
  } catch (error) {
    if (card) card.classList.remove('resolving');
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Approve'; }
    if (denyBtn) { denyBtn.disabled = false; denyBtn.textContent = 'Deny'; }
    const msg = (error && error.message) ? error.message : String(error);
    showToast('⚠️ Could not ' + (allowed ? 'approve' : 'deny') + ': ' + msg, 5000, 'error');
    return;
  }
  pollPermissions().catch((err) => console.warn('pollPermissions follow-up failed', err));
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
    banner.innerHTML = '<span><strong>Unfinished chat available:</strong> ' + esc(s.title || s.sessionId) + ' · ' + esc(s.status || 'running') + '<br>Resume continues it. Fork starts a copy so the original stays unchanged.</span><div class="recovery-actions"><button class="btn-sm" title="Continue this session" onclick="recoverSession(\'' + escAttr(s.sessionId) + '\')">Resume chat</button><button class="btn-sm" title="Start from a copy of this session" onclick="forkSession(\'' + escAttr(s.sessionId) + '\')">Fork copy</button></div>';
    area.prepend(banner);
  } catch(e){}
}

async function recoverSession(id) {
  try {
    const r = await fetch('/api/sessions/' + id);
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    lastSessionId = id;
    chatMessages = [];
    document.getElementById('chatArea').innerHTML = '';
    for (const m of d.messages || []) {
      if (m.role === 'system') addMsg('assistant', m.content);
      else { addMsg(m.role, m.content); chatMessages.push({ role: m.role, content: m.content }); }
    }
    loadHistory();
  } catch (e) { showToast(e.message); }
}

async function forkSession(id) {
  const model = document.getElementById('modelSelect').value;
  if (!model) { showToast('Select a model first.'); return; }
  try {
    const r = await fetch('/api/sessions/' + id + '/fork', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const d = await r.json();
    if (d.error) { showToast(d.error); return; }
    lastSessionId = d.sessionId;
    showToast('Forked session ' + d.sessionId);
  } catch (e) { showToast(e.message); }
}

// ── Active Goal /run: chat-driven launch + inline iteration cards ──────
// /run <target> [-- verify <check>]... creates a goal via POST /api/goals
// then opens a streaming POST /api/goals/:id/start. Browser EventSource is
// GET-only so we parse the SSE frames manually from the fetch ReadableStream.
//
// Verification syntax: the loop treats a goal with zero required checks as
// "already satisfied" and exits after iteration 0, so /run requires at
// least one `-- verify` segment. Two forms are supported per segment:
//   -- verify file:<relative or absolute path>      → file_exists check
//   -- verify <argv>                                 → command check
//                                                     (tokenized, no shell)
// `file:` is cross-platform; the command form goes through Node's execFile
// so the first token must be a real binary (no shell builtins like `test`).
function tokenizeShellWords(s) {
  // Minimal POSIX-ish tokenizer: whitespace splits, single/double quotes
  // group, backslash escapes the next char. Not a full shell parser; good
  // enough to turn `cmd /c "if exist x (exit 0)"` into 3 argv items.
  const out = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  let hasContent = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { cur += c; hasContent = true; escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (quote) {
      if (c === quote) { quote = null; hasContent = true; continue; }
      cur += c; hasContent = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; hasContent = true; continue; }
    if (/\s/.test(c)) {
      if (hasContent) { out.push(cur); cur = ''; hasContent = false; }
      continue;
    }
    cur += c; hasContent = true;
  }
  if (hasContent) out.push(cur);
  return out;
}

function parseRunInvocation(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { target: '', verifications: [] };
  const parts = trimmed.split(/\s+--\s+verify\s+/i);
  const target = (parts[0] || '').trim();
  const verifications = [];
  for (const seg of parts.slice(1)) {
    const s = seg.trim();
    if (!s) continue;
    if (/^file:/i.test(s)) {
      const p = s.slice(5).trim();
      if (p) verifications.push({ kind: 'file_exists', path: p, raw: s });
      continue;
    }
    const tokens = tokenizeShellWords(s);
    if (tokens.length === 0) continue;
    verifications.push({ kind: 'command', command: tokens[0], args: tokens.slice(1), raw: s });
  }
  return { target, verifications };
}

async function runActiveGoalFromChat(rawTarget) {
  const { target, verifications } = parseRunInvocation(rawTarget);
  if (!target) {
    addMsg('assistant', '❌ `/run` needs a goal. Try `/run make all tests pass -- verify npm test`.');
    return;
  }
  if (verifications.length === 0) {
    addMsg('assistant', '❌ `/run` needs at least one `-- verify` check, otherwise the loop exits immediately.\n\n'
      + 'Two forms:\n'
      + '• `-- verify file:<path>` — passes when the file exists (cross-platform, recommended for research/output goals).\n'
      + '• `-- verify <argv>` — passes when the command exits 0. Tokenized as argv, no shell, so the first token must be a real binary (not `test` or `if`).\n\n'
      + 'Examples:\n'
      + '• `/run gather aircon notes -- verify file:agent-outputs/aircons.md`\n'
      + '• `/run make all tests pass -- verify npm test`');
    return;
  }

  const goalBody = {
    target,
    verification: verifications.map((v, i) => {
      const baseId = 'v' + (i + 1);
      if (v.kind === 'file_exists') {
        return { id: baseId, description: v.raw, required: true, spec: { kind: 'file_exists', path: v.path } };
      }
      return { id: baseId, description: v.raw, required: true, spec: { kind: 'command', command: v.command, args: v.args, expectExitCode: 0 } };
    }),
  };

  let goal;
  try {
    const createResp = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goalBody),
    });
    if (!createResp.ok) {
      const errTxt = await createResp.text().catch(() => '');
      addMsg('assistant', '❌ Failed to create goal (HTTP ' + createResp.status + '): ' + (errTxt || ''));
      return;
    }
    const body = await createResp.json();
    goal = body.goal;
  } catch (err) {
    addMsg('assistant', '❌ Failed to create goal: ' + ((err && err.message) || err));
    return;
  }

  const container = appendGoalRunContainer(goal);

  let startResp;
  try {
    startResp = await fetch('/api/goals/' + encodeURIComponent(goal.id) + '/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runner: 'queryloop' }),
    });
  } catch (err) {
    container.querySelector('.goal-run-status').textContent = 'Failed to start: ' + ((err && err.message) || err);
    finalizeGoalRunControls(container);
    return;
  }
  if (!startResp.ok || !startResp.body) {
    let errTxt = '';
    try { errTxt = await startResp.text(); } catch (_) { /* ignore */ }
    container.querySelector('.goal-run-status').textContent = 'Failed to start (HTTP ' + startResp.status + '): ' + errTxt;
    finalizeGoalRunControls(container);
    return;
  }

  const reader = startResp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let evType = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        let parsed;
        try { parsed = JSON.parse(dataLines.join('\n')); } catch (_) { parsed = { raw: dataLines.join('\n') }; }
        handleGoalRunEvent(container, evType, parsed);
      }
    }
  } catch (err) {
    container.querySelector('.goal-run-status').textContent = 'Stream error: ' + ((err && err.message) || err);
  } finally {
    finalizeGoalRunControls(container);
  }
}

function appendGoalRunContainer(goal) {
  const area = document.getElementById('chatArea');
  const el = document.createElement('div');
  el.className = 'msg assistant goal-run';
  el.dataset.goalId = goal.id;
  const checksSummary = (goal.verification && goal.verification.length)
    ? goal.verification.length + ' check(s)'
    : 'no checks';
  el.innerHTML = '<div class="msg-avatar">' + esc(getAgentAvatar()) + '</div>'
    + '<div class="msg-body"><div class="msg-role">' + esc(currentAgentName || 'Assistant') + ' · Active Goal</div>'
    + '<div class="msg-content">'
    + '<div class="goal-run-banner"><strong>Goal:</strong> ' + esc(goal.target)
    + ' <span class="goal-run-id">(' + esc(goal.id) + ' · ' + esc(checksSummary) + ')</span></div>'
    + '<div class="goal-run-controls">'
    +   '<button type="button" class="goal-run-pause">Pause</button>'
    +   '<button type="button" class="goal-run-abandon">Abandon</button>'
    +   '<button type="button" class="goal-run-undo">Undo</button>'
    + '</div>'
    + '<div class="goal-run-status">Starting…</div>'
    + '<div class="goal-run-cards"></div>'
    + '</div></div>';
  area.appendChild(el);
  el.querySelector('.goal-run-pause').addEventListener('click', () => goalRunControl(el, 'pause'));
  el.querySelector('.goal-run-abandon').addEventListener('click', () => goalRunControl(el, 'abandon'));
  el.querySelector('.goal-run-undo').addEventListener('click', () => goalRunControl(el, 'undo'));
  scrollBottom();
  return el;
}

async function goalRunControl(container, action) {
  const goalId = container.dataset.goalId;
  if (!goalId) return;
  const status = container.querySelector('.goal-run-status');
  const btn = container.querySelector('.goal-run-' + action);
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/goals/' + encodeURIComponent(goalId) + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      status.textContent = action + ' failed (HTTP ' + resp.status + '): ' + errTxt;
      if (btn) btn.disabled = false;
      return;
    }
    if (action === 'undo') {
      const body = await resp.json().catch(() => ({}));
      const r = (body && body.result) || {};
      const reverted = (r.reverted || []).length;
      const irreversible = (r.irreversible || []).length;
      const failed = (r.failed || []).length;
      status.textContent = 'Undone: reverted ' + reverted + ', irreversible ' + irreversible + ', failed ' + failed;
      return;
    }
    status.textContent = action === 'pause' ? 'Pause requested…' : 'Abandon requested…';
    if (action === 'abandon') finalizeGoalRunControls(container);
  } catch (err) {
    status.textContent = action + ' failed: ' + ((err && err.message) || err);
    if (btn) btn.disabled = false;
  }
}

function finalizeGoalRunControls(container) {
  const pause = container.querySelector('.goal-run-pause');
  const abandon = container.querySelector('.goal-run-abandon');
  if (pause) pause.disabled = true;
  if (abandon) abandon.disabled = true;
}

function handleGoalRunEvent(container, evType, data) {
  const status = container.querySelector('.goal-run-status');
  const cards = container.querySelector('.goal-run-cards');
  if (evType === 'loop_start') {
    status.textContent = 'Loop started';
    return;
  }
  if (evType === 'iteration_start') {
    const card = document.createElement('div');
    card.className = 'iter-card';
    card.dataset.iter = String(data.iteration);
    card.innerHTML = '<div class="iter-card-header">Iteration ' + esc(data.iteration) + ' <span class="iter-card-status">running…</span></div>'
      + '<div class="iter-card-body"></div>';
    cards.appendChild(card);
    status.textContent = 'Iteration ' + data.iteration + ' running…';
    scrollBottom();
    return;
  }
  if (evType === 'iteration_end') {
    const card = cards.querySelector('.iter-card[data-iter="' + data.iteration + '"]');
    if (!card) return;
    card.querySelector('.iter-card-status').textContent = data.outcome && data.outcome.error ? 'error' : 'done';
    const out = data.outcome || {};
    const body = card.querySelector('.iter-card-body');
    const counters = [];
    if (out.action) counters.push(out.action);
    if (typeof out.toolCalls === 'number') counters.push(out.toolCalls + ' tool calls');
    if (Array.isArray(out.filesTouched) && out.filesTouched.length) counters.push(out.filesTouched.length + ' files');
    if (typeof out.tokensUsed === 'number' && out.tokensUsed > 0) counters.push(out.tokensUsed + ' tokens');
    body.innerHTML = '<div class="iter-card-counters">' + counters.map((c) => '<span class="iter-card-pill">' + esc(c) + '</span>').join(' ') + '</div>';
    if (out.error) body.innerHTML += '<div class="iter-card-error">' + esc(out.error) + '</div>';
    if (out.notes) body.innerHTML += '<details class="iter-card-notes"><summary>notes</summary><pre>' + esc(out.notes) + '</pre></details>';
    scrollBottom();
    return;
  }
  if (evType === 'verification_end') {
    const card = cards.querySelector('.iter-card[data-iter="' + data.iteration + '"]');
    if (!card) return;
    const r = data.result || {};
    const total = Array.isArray(r.results) ? r.results.length : 0;
    const passed = Array.isArray(r.results) ? r.results.filter((x) => x.result && x.result.passed).length : 0;
    const verifLine = document.createElement('div');
    verifLine.className = 'iter-card-verif' + (r.allRequiredPassed ? ' ok' : ' fail');
    verifLine.textContent = 'verification: ' + passed + '/' + total + ' passed (' + (r.requiredPassed || 0) + '/' + (r.requiredCount || 0) + ' required)';
    card.querySelector('.iter-card-body').appendChild(verifLine);
    return;
  }
  if (evType === 'transitioned') {
    status.textContent = 'Status: ' + (data.from || '?') + ' → ' + (data.to || '?');
    return;
  }
  if (evType === 'loop_end') {
    status.textContent = 'Loop ended: ' + (data.reason || 'unknown') + ' · ' + (data.iterations || 0) + ' iteration(s)';
    scrollBottom();
    return;
  }
  if (evType === 'error') {
    status.textContent = 'Error: ' + (data.message || JSON.stringify(data));
  }
}

function addMsg(role, text) {
  const area = document.getElementById('chatArea');
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const av = role === 'user' ? 'Y' : getAgentAvatar();
  const label = role === 'user' ? 'You' : (currentAgentName || 'Assistant');
  el.innerHTML = '<div class="msg-avatar">' + av + '</div><div class="msg-body"><div class="msg-role">' + esc(label) + '</div><div class="msg-content"></div></div>';
  if (role === 'user') el.querySelector('.msg-content').textContent = text;
  else renderMd(el.querySelector('.msg-content'), text);
  area.appendChild(el);
  scrollBottom();
  return el;
}

function attachGoalStartButton(msgEl, taskCount, planPath) {
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;
  if (body.querySelector('.goal-start-row')) return;
  const row = document.createElement('div');
  row.className = 'goal-start-row';
  row.style.cssText = 'margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'goal-start-btn';
  btn.textContent = '▶ Start autonomy on ' + taskCount + ' task' + (taskCount === 1 ? '' : 's');
  btn.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid var(--accent,#6cf);background:var(--accent,#6cf);color:#000;font-weight:600;cursor:pointer';
  const status = document.createElement('span');
  status.className = 'goal-start-status';
  status.style.cssText = 'font-size:12px;color:var(--text-dim);white-space:pre-line';
  status.textContent = 'Or open the Autonomy panel for full controls.';

  // Live status pump: after a successful start, subscribe to the
  // autonomy state SSE stream and rewrite the status line on every
  // checkpoint push. One stream per click; closes when the run ends or
  // the chat tab unloads.
  let liveES = null;
  let liveStartedAt = 0;
  function closeLive() {
    if (liveES) { try { liveES.close(); } catch { /* noop */ } liveES = null; }
  }
  function fmtElapsed(ms) {
    if (!ms || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  }
  function renderLive(s) {
    if (!s) return;
    const phase = s.status || s.lastTaskStatus || 'running';
    const icon = phase === 'done' ? '✅' : phase === 'failed' ? '❌' : phase === 'running' ? '⏳' : '•';
    const task = s.lastTaskId || s.currentTask || '?';
    const taskElapsed = fmtElapsed(s.lastTaskElapsedMs);
    const runElapsed = fmtElapsed(Date.now() - liveStartedAt);
    const done = s.totalDone ?? 0;
    const failed = s.totalFailed ?? 0;
    const pending = s.totalPending ?? 0;
    const counts = done + '✓ ' + failed + '✗ ' + pending + '⋯';
    const parts = [icon + ' ' + phase, 'task: ' + task];
    if (taskElapsed) parts.push(taskElapsed);
    parts.push(counts);
    parts.push('elapsed: ' + runElapsed);
    status.textContent = parts.join(' · ');
    // Terminal states: lock in the final line and stop the stream.
    const terminal = phase === 'done' || phase === 'failed' || (pending === 0 && phase !== 'running');
    if (terminal) {
      const finalIcon = phase === 'failed' || failed > 0 ? '❌' : '✅';
      status.textContent = finalIcon + ' ' + (phase === 'failed' ? 'failed' : 'done')
        + ' in ' + runElapsed + ' · ' + counts
        + ' · see agent-outputs/ and .harness/sessions/ for artefacts.';
      closeLive();
    }
  }
  function startLive() {
    if (typeof window.EventSource !== 'function') return;
    closeLive();
    liveStartedAt = Date.now();
    try {
      liveES = new EventSource('/api/autonomy/state/stream');
      liveES.onmessage = (evt) => {
        try {
          const s = evt.data === 'null' ? null : JSON.parse(evt.data);
          renderLive(s);
        } catch { /* ignore malformed frames */ }
      };
      liveES.onerror = () => {
        if (liveES && liveES.readyState === EventSource.CLOSED) closeLive();
      };
    } catch { /* SSE unavailable; the panel polls as a fallback */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', closeLive);
  }

  btn.onclick = async () => {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    status.textContent = 'Starting...';
    try {
      const model = (document.getElementById('modelSelect')?.value) || '';
      const response = await fetch('/api/autonomy/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, maxIterations: taskCount, maxTurns: 30, timeBudgetMs: 0, unproductiveTurnLimit: 6 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        const blocked = (data.preflight && data.preflight.blocked) || [];
        const detail = blocked.length
          ? '\n' + blocked.map((c) => '• ' + c.label + ': ' + (c.message || 'no detail') + (c.action ? ' — ' + c.action : '')).join('\n')
          : '';
        throw new Error((data.error || ('HTTP ' + response.status)) + detail);
      }
      status.textContent = '✓ Started PID ' + (data.pid || '?') + ' — waiting for first checkpoint...';
      btn.textContent = '✓ Autonomy started';
      startLive();
      if (typeof startAutonomyPolling === 'function') {
        try { startAutonomyPolling(); } catch { /* noop */ }
      }
    } catch (error) {
      status.textContent = '⚠️ ' + (error.message || String(error));
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  };
  row.appendChild(btn);
  row.appendChild(status);
  body.appendChild(row);
  scrollBottom();
}

function attachEvidenceCard(msgEl, evidence) {
  const body = msgEl.querySelector('.msg-body');
  if (!body || !evidence) return;
  latestEvidenceObject = evidence;
  const tools = evidence.tools || [];
  const files = evidence.files || [];
  const commands = evidence.commands || [];
  const successRate = typeof evidence.toolSuccessRate === 'number' ? Math.round(evidence.toolSuccessRate * 100) + '%' : 'n/a';
  const outcome = summarizeEvidenceOutcome(evidence);
  const validation = evidence.validation ? outcome.validationStatus + ' · ' + Math.round((evidence.validation.score || 0) * 100) + '%' : outcome.validationStatus;
  const route = evidence.mycelium && evidence.mycelium.route && evidence.mycelium.route.length ? evidence.mycelium.route.slice(0, 4).join(' → ') : 'not routed';
  const card = document.createElement('details');
  card.className = 'evidence-card';
  card.open = true;
  card.innerHTML = '<summary><span>What happened: ' + esc(outcome.nextAction) + '</span><strong>' + esc(evidence.mode || 'general') + '</strong></summary>'
    + renderOutcomeStrip(evidence)
    + renderEvidenceNextAction(outcome)
    + '<div class="evidence-grid">'
    + '<div><strong>Model</strong><span>' + esc(evidence.model || 'unknown') + '</span></div>'
    + '<div><strong>Permission</strong><span>' + esc(evidence.permissionMode || 'default') + '</span></div>'
    + '<div><strong>Tools</strong><span>' + esc(tools.length) + ' calls · ' + esc(successRate) + '</span></div>'
    + '<div><strong>Validation</strong><span>' + esc(validation) + '</span></div>'
    + '<div><strong>Context route</strong><span>' + esc(route) + '</span></div>'
    + '<div><strong>Recovery</strong><span>' + esc(evidence.recovery?.sessionId || 'session recorded') + '</span></div>'
    + '</div>'
    + '<div class="evidence-lists">'
    + '<div><strong>Files</strong>' + renderEvidencePills(files.map(formatEvidenceFile), 180) + '</div>'
    + '<div><strong>Commands</strong>' + renderEvidencePills(commands.map((cmd) => (cmd.success === false ? 'failed: ' : '') + cmd.command)) + '</div>'
    + '</div>';
  body.appendChild(card);
}

function renderEvidenceNextAction(outcome) {
  const action = evidenceNextAction(outcome);
  return '<div class="evidence-next-action"><span>' + esc(action.label) + '</span><button class="btn-sm primary" data-evidence-next="1" onclick="draftEvidenceNextPrompt(\'' + escAttr(action.prompt) + '\')">' + esc(action.button) + '</button></div>';
}

function evidenceNextAction(outcome) {
  if (outcome.nextAction === 'Needs review') {
    return {
      label: 'Something needs attention before accepting this work.',
      button: 'Review evidence',
      prompt: 'Review the latest evidence card. Explain the failed commands or warnings, confirm whether the files need changes, and recommend the next safest action.',
    };
  }
  if (outcome.nextAction === 'Ready to inspect') {
    return {
      label: 'Changes are ready for a human check.',
      button: 'Show diff',
      prompt: 'Show me the diff for the latest changes and tell me whether I should accept them.',
    };
  }
  if (outcome.nextAction === 'Review output') {
    return {
      label: 'No files changed. Review the command output.',
      button: 'Summarize output',
      prompt: 'Summarize the latest command output and tell me if any follow-up is needed.',
    };
  }
  return {
    label: 'No next action was recorded.',
    button: 'Continue',
    prompt: 'Continue from the latest result and suggest the next useful action.',
  };
}

function draftEvidenceNextPrompt(prompt) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = prompt;
  autoSize(input);
  input.focus();
}

function buildClientStoppedEvidence(request, model, tools, commands, stopReason) {
  const safeTools = Array.isArray(tools) ? tools : [];
  const safeCommands = Array.isArray(commands) ? commands : [];
  const successes = safeTools.filter((tool) => tool.success).length;
  return {
    id: 'client-' + Date.now(),
    kind: 'chat',
    mode: 'review',
    createdAt: new Date().toISOString(),
    request: String(request || '').slice(0, 500),
    model: model || 'unknown',
    permissionMode: 'default',
    toolSuccessRate: safeTools.length > 0 ? successes / safeTools.length : undefined,
    tools: safeTools,
    files: [],
    commands: safeCommands,
    artifacts: [],
    recovery: { stopReason },
    validation: safeTools.some((tool) => tool.success === false) || stopReason !== 'completed' ? { profile: 'client-turn', status: 'fail', score: 0, findings: ['Turn ended before server evidence arrived.'], missingSections: [] } : undefined,
  };
}

function summarizeEvidenceOutcome(evidence) {
  const files = Array.isArray(evidence?.files) ? evidence.files : [];
  const commands = Array.isArray(evidence?.commands) ? evidence.commands : [];
  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
  const changedFiles = files.filter((file) => ['write', 'edit', 'move', 'delete'].includes(file.action)).length;
  const failedCommands = commands.filter((cmd) => cmd.success === false).length;
  const rawValidationStatus = evidence?.validation?.status || 'not run';
  const readOnlyWork = changedFiles === 0 && (commands.length > 0 || files.length > 0);
  const validationStatus = formatEvidenceValidationStatus(rawValidationStatus, readOnlyWork);
  const validationClass = rawValidationStatus === 'pass' ? 'good' : rawValidationStatus === 'fail' ? 'bad' : rawValidationStatus === 'warn' ? 'warn' : '';
  const nextAction = failedCommands > 0 || rawValidationStatus === 'fail'
    ? 'Needs review'
    : changedFiles > 0 || artifacts.length > 0
      ? 'Ready to inspect'
      : commands.length > 0 || files.length > 0
        ? 'Review output'
        : 'No action recorded';
  const riskLabel = failedCommands > 0 || rawValidationStatus === 'fail'
    ? 'Needs review'
    : changedFiles > 0 && rawValidationStatus !== 'pass'
      ? 'Check changes'
      : 'Low';
  const riskClass = riskLabel === 'Needs review' ? 'bad' : riskLabel === 'Check changes' ? 'warn' : 'good';
  return {
    changedFiles,
    commandsRun: commands.length,
    failedCommands,
    artifacts: artifacts.length,
    rawValidationStatus,
    validationStatus,
    validationClass,
    riskLabel,
    riskClass,
    nextAction,
    nextActionClass: nextAction === 'Needs review' ? 'bad' : nextAction === 'No action recorded' ? 'warn' : 'good',
  };
}

function formatEvidenceValidationStatus(status, readOnlyWork) {
  if (status === 'pass') return 'Passed';
  if (status === 'fail') return 'Failed';
  if (status === 'warn') return 'Warnings';
  return readOnlyWork ? 'Not run (read-only)' : 'Not run';
}

function renderOutcomeStrip(evidence) {
  const outcome = summarizeEvidenceOutcome(evidence);
  return '<div class="outcome-strip" data-outcome-strip="1">'
    + '<div class="outcome-item ' + (outcome.changedFiles > 0 ? 'good' : '') + '"><strong>Files changed</strong><span>' + esc(outcome.changedFiles) + '</span></div>'
    + '<div class="outcome-item ' + (outcome.failedCommands > 0 ? 'bad' : outcome.commandsRun > 0 ? 'good' : '') + '"><strong>Commands run</strong><span>' + esc(outcome.commandsRun) + (outcome.failedCommands ? ' · ' + esc(outcome.failedCommands) + ' failed' : '') + '</span></div>'
    + '<div class="outcome-item ' + outcome.validationClass + '"><strong>Result</strong><span>' + esc(outcome.validationStatus) + '</span></div>'
    + '<div class="outcome-item ' + outcome.riskClass + '"><strong>Risk</strong><span>' + esc(outcome.riskLabel) + '</span></div>'
    + '<div class="outcome-item ' + (outcome.artifacts > 0 ? 'good' : '') + '"><strong>Artifacts</strong><span>' + esc(outcome.artifacts) + '</span></div>'
    + '<div class="outcome-item ' + outcome.nextActionClass + '"><strong>Next</strong><span>' + esc(outcome.nextAction) + '</span></div>'
    + '</div>';
}

function renderEvidencePills(items, maxLength = 90) {
  const unique = Array.from(new Set((items || []).filter(Boolean))).slice(0, 8);
  if (unique.length === 0) return '<span class="evidence-muted">none</span>';
  return '<div class="evidence-pills">' + unique.map((item) => '<span>' + esc(String(item).slice(0, maxLength)) + '</span>').join('') + '</div>';
}

function formatEvidenceFile(file) {
  if (!file) return '';
  const action = file.action || 'unknown';
  const path = file.path || '';
  if (file.redirected && file.requestedPath && file.requestedPath !== path) {
    return action + ': ' + file.requestedPath + ' -> ' + path;
  }
  return action + ': ' + path;
}

function renderMd(el, text) {
  if (!text) { el.innerHTML = ''; return; }
  el.innerHTML = (typeof marked !== 'undefined' && marked.parse) ? marked.parse(text) : ('<pre style="white-space:pre-wrap;word-break:break-word">' + esc(text) + '</pre>');
  // Open links from message output in a new tab. Without this, clicking a
  // markdown link navigates the single-page app away and destroys the live
  // session. In-page fragment links (#...) are left alone.
  el.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  el.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    // Capture the code text BEFORE the button is appended so the
    // copied content can never contain the literal "Copy" / "Copied!"
    // string from the button itself. Prefer the inner <code> element
    // (what marked emits for fenced blocks); fall back to <pre>.
    const codeEl = pre.querySelector('code');
    const original = (codeEl ? codeEl.textContent : pre.textContent) || '';
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      navigator.clipboard.writeText(original).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }).catch((e) => { btn.textContent = 'Failed'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); console.error('clipboard', e); });
    };
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
  // Artifact extraction: any fenced code block of ≥ 8 lines, OR any
  // HTML/SVG block, becomes an artifact tab in the side panel. The
  // chat keeps the inline rendering; the panel adds preview + download.
  maybeExtractArtifacts(el, text);
}

// ─── Artifact panel ───────────────────────────────────────────────────
// Stores up to 12 artifacts per session; each has source code, language,
// and a synthesized title. The panel always shows the most-recently
// activated one with prior tabs accessible.
const artifacts = [];
const MAX_ARTIFACTS = 12;
let activeArtifactIdx = -1;
let artifactPreviewMode = true; // true = preview, false = source

function maybeExtractArtifacts(msgContentEl, rawText) {
  if (!rawText) return;
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(rawText)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const code = m[2];
    const lineCount = code.split('\n').length;
    const previewable = lang === 'html' || lang === 'svg' || lang === 'mermaid' || lang === 'markdown' || lang === 'md';
    if (lineCount >= 8 || previewable) {
      const title = synthesizeArtifactTitle(code, lang);
      addArtifact({ title, lang: lang || 'text', code });
    }
  }
}

function synthesizeArtifactTitle(code, lang) {
  // First non-empty comment-or-heading-looking line; otherwise lang + size.
  const lines = code.split('\n').slice(0, 8);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cleaned = line.replace(/^[\/#*<!\->\s]+/, '').replace(/\s*-->$/, '').trim();
    if (cleaned.length >= 4 && cleaned.length <= 60) return cleaned;
  }
  return (lang || 'text') + ' · ' + code.length + ' chars';
}

function addArtifact(artifact) {
  // Dedup against the immediately previous artifact (model frequently
  // re-emits the same code while iterating).
  const prev = artifacts[artifacts.length - 1];
  if (prev && prev.code === artifact.code && prev.lang === artifact.lang) return;
  artifacts.push(artifact);
  while (artifacts.length > MAX_ARTIFACTS) artifacts.shift();
  activeArtifactIdx = artifacts.length - 1;
  renderArtifactTabs();
  openArtifact(activeArtifactIdx);
}

function renderArtifactTabs() {
  const tabs = document.getElementById('artifactTabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  artifacts.forEach((art, i) => {
    const btn = document.createElement('button');
    btn.className = 'artifact-tab' + (i === activeArtifactIdx ? ' active' : '');
    btn.textContent = (i + 1) + '. ' + art.title.slice(0, 32);
    btn.title = art.title + ' (' + art.lang + ', ' + art.code.length + ' chars)';
    btn.onclick = () => openArtifact(i);
    tabs.appendChild(btn);
  });
}

function openArtifact(i) {
  if (i < 0 || i >= artifacts.length) return;
  activeArtifactIdx = i;
  artifactPreviewMode = isPreviewable(artifacts[i].lang);
  document.getElementById('artifactTitle').textContent = artifacts[i].title;
  document.getElementById('artifactPanel').classList.add('open');
  document.getElementById('artifactPanel').setAttribute('aria-hidden', 'false');
  renderArtifactTabs();
  refreshArtifactPreview();
}

function closeArtifact() {
  document.getElementById('artifactPanel').classList.remove('open');
  document.getElementById('artifactPanel').setAttribute('aria-hidden', 'true');
}

function isPreviewable(lang) {
  return lang === 'html' || lang === 'svg' || lang === 'markdown' || lang === 'md' || lang === 'mermaid';
}

function refreshArtifactPreview() {
  const body = document.getElementById('artifactBody');
  const toggle = document.getElementById('artifactViewToggle');
  if (!body || activeArtifactIdx < 0) return;
  const art = artifacts[activeArtifactIdx];
  const previewable = isPreviewable(art.lang);
  toggle.style.display = previewable ? '' : 'none';
  toggle.textContent = artifactPreviewMode ? 'Source' : 'Preview';
  if (previewable && artifactPreviewMode) {
    body.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', 'artifact preview');
    body.appendChild(iframe);
    let html;
    if (art.lang === 'svg') html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#fff}svg{max-width:100%;height:auto}</style></head><body>' + art.code + '</body></html>';
    else if (art.lang === 'markdown' || art.lang === 'md') html = '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:18px;max-width:780px;margin:0 auto;line-height:1.55;color:#111}h1,h2,h3{margin-top:1.2em}pre{background:#f4f4f4;padding:10px;border-radius:6px;overflow:auto}code{background:#f4f4f4;padding:1px 4px;border-radius:3px}</style></head><body>' + (window.marked ? window.marked.parse(art.code) : ('<pre>' + esc(art.code) + '</pre>')) + '</body></html>';
    else if (art.lang === 'mermaid') html = '<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script><style>body{margin:12px;font-family:system-ui,sans-serif;overflow:auto}svg{max-width:100%;height:auto}</style></head><body><div class="mermaid">' + esc(art.code) + '</div><script>mermaid.initialize({startOnLoad:true,securityLevel:"loose",fontFamily:"system-ui,sans-serif",fontSize:14,flowchart:{htmlLabels:true,curve:"basis",padding:20,nodeSpacing:50,rankSpacing:80}})</script></body></html>';
    else html = art.code; // raw HTML
    iframe.srcdoc = html;
  } else {
    body.innerHTML = '<pre>' + esc(art.code) + '</pre>';
  }
}

function toggleArtifactView() {
  artifactPreviewMode = !artifactPreviewMode;
  refreshArtifactPreview();
}

function copyArtifact() {
  if (activeArtifactIdx < 0) return;
  navigator.clipboard.writeText(artifacts[activeArtifactIdx].code);
}

function downloadArtifact() {
  if (activeArtifactIdx < 0) return;
  const art = artifacts[activeArtifactIdx];
  const ext = ({ html: 'html', svg: 'svg', md: 'md', markdown: 'md', mermaid: 'mmd', javascript: 'js', typescript: 'ts', python: 'py', json: 'json', sh: 'sh', bash: 'sh' })[art.lang] || 'txt';
  const blob = new Blob([art.code], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = art.title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) + '.' + ext;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadMmd(source, filename) {
  const blob = new Blob([source], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'diagram.mmd';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Side-by-side model compare ───────────────────────────────────────
function toggleCompare() {
  compareEnabled = !compareEnabled;
  const btn = document.getElementById('compareBtn');
  const sel = document.getElementById('compareModelSelect');
  if (compareEnabled) {
    btn.classList.add('active');
    btn.style.background = 'var(--accent-bg)';
    btn.style.borderColor = 'var(--accent)';
    sel.classList.remove('compare-select-hidden');
  } else {
    btn.classList.remove('active');
    btn.style.background = '';
    btn.style.borderColor = '';
    sel.classList.add('compare-select-hidden');
  }
}

/**
 * Run the same prompt against two models in parallel and render the
 * replies side-by-side. Each column is independent; choosing "Keep ✅"
 * promotes that column's text into chatMessages history and discards
 * the other. Tool traces and citations are intentionally omitted in
 * compare mode to keep the columns scannable.
 */
async function runCompareSend(text, modelA, modelB) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
  addMsg('user', text);
  chatMessages.push({ role: 'user', content: text });
  saveChatSession();
  document.querySelectorAll('.followup-chips, .context-cards').forEach((n) => n.remove());

  const area = document.getElementById('chatArea');
  const row = document.createElement('div');
  row.className = 'compare-row';
  const colA = makeCompareColumn(modelA);
  const colB = makeCompareColumn(modelB);
  row.appendChild(colA.wrap);
  row.appendChild(colB.wrap);
  area.appendChild(row);
  scrollBottom();

  isSending = true;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '■';
  sendBtn.classList.add('streaming');
  const badge3 = document.getElementById('streamingBadge'); if (badge3) badge3.classList.add('active');

  const runOne = async (model, col) => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, model, skipValidation: true, history: outboundChatHistory(), attachments: [] }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let assistantText = '';
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
          try { ev = JSON.parse(payload); } catch(e){ continue; }
          if (ev.type === 'text') {
            assistantText += ev.content;
            renderMd(col.contentEl, assistantText);
            scrollBottom();
          } else if (ev.type === 'usage') {
            col.metaEl.textContent = (ev.completionTokens || 0) + ' tokens · ' + Math.round((ev.totalDurationMs || 0) / 100) / 10 + 's';
          } else if (ev.type === 'error') {
            col.contentEl.innerHTML = '<em>⚠️ ' + esc(ev.message) + '</em>';
          }
        }
      }
      col.text = assistantText;
      col.keepBtn.disabled = false;
      col.keepBtn.style.opacity = '1';
    } catch (e) {
      col.contentEl.innerHTML = '<em>⚠️ ' + esc(e.message) + '</em>';
    }
  };

  await Promise.all([runOne(modelA, colA), runOne(modelB, colB)]);

  isSending = false;
  sendBtn.textContent = '➤';
  sendBtn.classList.remove('streaming');
  const badge4 = document.getElementById('streamingBadge'); if (badge4) badge4.classList.remove('active');
  document.getElementById('chatInput').focus();
}

function makeCompareColumn(model) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-col';
  const header = document.createElement('div');
  header.className = 'compare-col-header';
  const pill = document.createElement('span');
  pill.className = 'compare-pill';
  pill.textContent = model;
  const meta = document.createElement('span');
  meta.className = 'meta-sep';
  const keepBtn = document.createElement('button');
  keepBtn.className = 'compare-keep-btn';
  keepBtn.textContent = '✅ Keep this';
  keepBtn.disabled = true;
  keepBtn.style.opacity = '0.5';
  keepBtn.onclick = () => {
    chatMessages.push({ role: 'assistant', content: ref.text || '' });
    saveChatSession();
    autoSaveChat();
    // Replace the entire compare row with a single assistant bubble for
    // the chosen reply, so the history reads cleanly going forward.
    const replacement = addMsg('assistant', ref.text || '');
    wrap.parentNode.parentNode.insertBefore(replacement, wrap.parentNode);
    wrap.parentNode.remove();
  };
  header.appendChild(pill);
  header.appendChild(meta);
  header.appendChild(keepBtn);
  const content = document.createElement('div');
  content.className = 'msg-content';
  wrap.appendChild(header);
  wrap.appendChild(content);
  const ref = { wrap, contentEl: content, metaEl: meta, keepBtn, text: '' };
  return ref;
}

function addThinking() { const area = document.getElementById('chatArea'); const el = document.createElement('div'); el.className = 'thinking'; el.innerHTML = '<div class="dots"><span></span><span></span><span></span></div> <span class="thinking-status">Thinking...</span>'; area.appendChild(el); scrollBottom(); return el; }
function updateThinkingStatus(el, text) { const status = el && el.querySelector ? el.querySelector('.thinking-status') : null; if (status) status.textContent = text; }
function scrollBottom() { const a = document.getElementById('chatArea'); a.scrollTop = a.scrollHeight; }

// ─── Per-message metadata footer + session totals HUD ──────────────────
// Folds the new `usage` SSE event into a small dim footer under the
// finished assistant message and a running total in the topbar HUD.
// All accumulators reset when the user starts a new chat (`newChat`).

let sessionUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTurnMs: 0, lastModel: null };
let currentTurnUsage = null;

function resetSessionUsage() {
  sessionUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTurnMs: 0, lastModel: null };
  currentTurnUsage = null;
  updateSessionHud();
  renderRunCost(null);
  renderAnswerConfidence(null);
  renderRunProvenance(null);
  renderOffline(null);
}

function formatTokensCompact(n) {
  if (!n) return '0t';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'kt';
  return n + 't';
}

function formatDurationCompact(ms) {
  if (!ms) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'm' + (s ? s + 's' : '');
}

function updateSessionHud() {
  const hud = document.getElementById('sessionHud');
  const tokensEl = document.getElementById('sessionHudTokens');
  const timeEl = document.getElementById('sessionHudTime');
  if (!hud || !tokensEl || !timeEl) return;
  const totalTokens = (sessionUsage.promptTokens || 0) + (sessionUsage.completionTokens || 0);
  tokensEl.textContent = formatTokensCompact(totalTokens);
  // Show wall-clock turn time when available, fall back to model inference time.
  const displayMs = sessionUsage.totalTurnMs || sessionUsage.totalDurationMs || 0;
  timeEl.textContent = formatDurationCompact(displayMs);
  hud.classList.toggle('empty', sessionUsage.calls === 0);
  // Reveal the HUD as soon as the session has any activity. Hidden by default
  // so the topbar starts uncluttered for first-run users.
  if (sessionUsage.calls > 0) {
    hud.classList.remove('hidden-by-default');
    const ctx = document.getElementById('contextHud');
    if (ctx) ctx.classList.remove('hidden-by-default');
  }
  hud.title = sessionUsage.calls === 0
    ? 'Session totals (this conversation) — no LLM calls yet'
    : 'Session totals: ' + sessionUsage.calls + ' call(s) · '
      + sessionUsage.promptTokens + ' prompt tokens · '
      + sessionUsage.completionTokens + ' completion tokens · '
      + formatDurationCompact(sessionUsage.totalDurationMs) + ' model'
      + (sessionUsage.totalTurnMs ? ' · ' + formatDurationCompact(sessionUsage.totalTurnMs) + ' wall-clock' : '')
      + (sessionUsage.lastModel ? ' · last model: ' + sessionUsage.lastModel : '');
}

// Honest run-level cost verdict rendered into the session HUD. The server
// emits one `run_cost` event at the end of each run; we paint a badge that
// claims "$0 local" ONLY when the server proved every call ran locally.
function renderRunCost(verdict) {
  const costEl = document.getElementById('sessionHudCost');
  const sepEl = document.getElementById('sessionHudCostSep');
  if (!costEl || !sepEl) return;
  if (!verdict || !verdict.calls) {
    costEl.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  let label;
  if (verdict.freeMarginal) {
    label = '🟢 100% local · $0';
  } else if (verdict.locality === 'cloud') {
    label = '☁ cloud · billed';
  } else {
    label = 'cost unknown';
  }
  costEl.textContent = label;
  costEl.title = verdict.reason || '';
  costEl.style.display = '';
  sepEl.style.display = '';
}

// Honest answer-confidence verdict rendered into the session HUD. The server
// emits one `answer_confidence` event after a run that produced answer text.
// We surface an explicit abstention or a model-stated confidence band, and
// render NOTHING when the model expressed no confidence ('unstated') rather
// than inventing one.
function renderAnswerConfidence(verdict) {
  const confEl = document.getElementById('sessionHudConf');
  const sepEl = document.getElementById('sessionHudConfSep');
  if (!confEl || !sepEl) return;
  if (!verdict || verdict.band === 'unstated') {
    confEl.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  let label;
  if (verdict.abstained) {
    label = '🤔 abstained';
  } else if (verdict.band === 'high') {
    label = '✓ high confidence';
  } else if (verdict.band === 'medium') {
    label = '~ medium confidence';
  } else {
    label = '! low confidence';
  }
  confEl.textContent = label;
  confEl.title = verdict.reason || '';
  confEl.style.display = '';
  sepEl.style.display = '';
}

// Honest, auditable run provenance rendered into the session HUD. The server
// emits one `run_provenance` event per run: which model produced it, when,
// and the tools/commands/files that fed it. We paint a badge with the model
// and source count, and render NOTHING when nothing beyond a timestamp is
// provable (no model and no sources) rather than implying false provenance.
function renderRunProvenance(verdict) {
  const provEl = document.getElementById('sessionHudProv');
  const sepEl = document.getElementById('sessionHudProvSep');
  if (!provEl || !sepEl) return;
  const hasModel = Boolean(verdict && verdict.model);
  const sources = verdict && Array.isArray(verdict.sources) ? verdict.sources : [];
  if (!verdict || (!hasModel && sources.length === 0)) {
    provEl.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  const parts = [];
  if (hasModel) parts.push(verdict.model);
  if (sources.length > 0) {
    const proven = sources.filter((s) => s && s.proven).length;
    parts.push(sources.length + ' source' + (sources.length === 1 ? '' : 's')
      + (proven < sources.length ? ' (' + proven + ' proven)' : ''));
  }
  provEl.textContent = '🔗 ' + parts.join(' · ');
  provEl.title = verdict.reason || '';
  provEl.style.display = '';
  sepEl.style.display = '';
}

// Opt-in governed pass surfaced inline under the assistant message. Renders the
// confidence mode (HOW the answer knows) and the self-critique findings. Stays
// quiet if there is no message element or no governed payload.
function renderGovernedShadow(msgEl, governed) {
  if (!msgEl || !governed) return;
  const body = msgEl.querySelector('.msg-body') || msgEl;
  let box = msgEl.querySelector('.governed-shadow');
  if (!box) {
    box = document.createElement('div');
    box.className = 'governed-shadow';
    box.style.cssText = 'margin-top:6px;padding:6px 8px;border-left:2px solid var(--accent,#69c);font-size:0.85em;opacity:0.9';
    body.appendChild(box);
  }
  const mode = governed.confidence && governed.confidence.mode ? governed.confidence.mode : 'unknown';
  const reason = governed.confidence && governed.confidence.reason ? governed.confidence.reason : '';
  const overall = governed.critique && governed.critique.overall ? governed.critique.overall : 'ok';
  const badge = overall === 'review' ? '⚠️ needs review' : '✓ ok';
  const findings = (governed.critique && Array.isArray(governed.critique.findings)) ? governed.critique.findings : [];
  const icon = function (status) { return status === 'flag' ? '🚩' : status === 'warn' ? '⚠️' : '✓'; };
  const findingRows = findings.map(function (f) {
    return '<div>' + icon(f.status) + ' <strong>' + esc(String(f.check)) + ':</strong> ' + esc(String(f.detail)) + '</div>';
  }).join('');
  box.innerHTML = '<div><strong>Governed:</strong> <code>' + esc(mode) + '</code> · ' + esc(badge)
    + (reason ? ' <span class="muted">(' + esc(reason) + ')</span>' : '') + '</div>'
    + findingRows;
}

function renderOffline(verdict) {
  const offEl = document.getElementById('sessionHudOffline');
  const sepEl = document.getElementById('sessionHudOfflineSep');
  if (!offEl || !sepEl) return;
  const state = verdict && verdict.state;
  // Stay silent unless offline is provably confirmed or the run provably
  // reached the network. 'unknown' paints nothing rather than a false claim.
  if (state !== 'offline' && state !== 'online') {
    offEl.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  offEl.textContent = state === 'offline' ? '🔒 Offline' : '🌐 Online';
  offEl.title = verdict.reason || '';
  offEl.style.display = '';
  sepEl.style.display = '';
}

function attachMessageMeta(msgEl, usage) {
  if (!msgEl || !usage) return;
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;
  // Replace any prior footer to stay idempotent if the loop somehow yields
  // a second usage event for the same message.
  const existing = body.querySelector('.msg-meta');
  if (existing) existing.remove();
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const tokensTotal = (usage.promptTokens || 0) + (usage.completionTokens || 0);
  const hasTiming = usage.promptEvalDurationMs > 0 || usage.evalDurationMs > 0;
  const timingTitle = hasTiming
    ? (usage.promptEvalDurationMs ? formatDurationCompact(usage.promptEvalDurationMs) + ' prefill' : '')
      + (usage.promptEvalDurationMs && usage.evalDurationMs ? ' + ' : '')
      + (usage.evalDurationMs ? formatDurationCompact(usage.evalDurationMs) + ' gen' : '')
      + (usage.loadDurationMs > 500 ? ' + ' + formatDurationCompact(usage.loadDurationMs) + ' load' : '')
    : '';
  const timingInline = hasTiming
    ? '<span class="meta-sep">·</span><span style="color:var(--text-dim);font-size:10px" title="' + esc(timingTitle) + '">'
      + formatDurationCompact(usage.promptEvalDurationMs || 0) + ' prefill · '
      + formatDurationCompact(usage.evalDurationMs || 0) + ' gen'
      + '</span>'
    : '';
  meta.innerHTML =
    '<span class="meta-pill">' + esc(usage.model || '?') + '</span>'
    + '<span class="meta-sep">·</span>'
    + '<span title="' + (usage.promptTokens || 0) + ' prompt + ' + (usage.completionTokens || 0) + ' completion">'
    + formatTokensCompact(tokensTotal) + '</span>'
    + '<span class="meta-sep">·</span>'
    + '<span>' + formatDurationCompact(usage.totalDurationMs || 0) + '</span>'
    + timingInline
    + (usage.turnDurationMs ? '<span class="meta-sep">·</span><span title="Wall-clock turn time (model + tools)">' + formatDurationCompact(usage.turnDurationMs) + ' turn</span>' : '')
    + (usage.loadDurationMs > 500 ? '<span class="meta-sep">·</span><span title="Time spent loading model into VRAM">🔥 ' + formatDurationCompact(usage.loadDurationMs) + ' load</span>' : '')
    + (typeof HarnessExecMetrics !== 'undefined' ? HarnessExecMetrics.formatExecMetrics(usage) : '');
  body.appendChild(meta);
}

/**
 * Attach 🔁 Regenerate + 📋 Copy buttons to an assistant message.
 * `messageIndex` is the position in `chatMessages` of THIS assistant
 * reply, so regenerate can slice history just before it.
 */
function attachMessageActions(msgEl, messageIndex) {
  if (!msgEl) return;
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;
  const existing = body.querySelector('.msg-actions');
  if (existing) existing.remove();
  const row = document.createElement('div');
  row.className = 'msg-actions';
  const regen = document.createElement('button');
  regen.className = 'msg-action-btn';
  regen.title = 'Re-run the prompt that produced this reply';
  regen.innerHTML = '🔁 Regenerate';
  regen.onclick = () => {
    if (isSending) return;
    sendMessage({ regenerateFromIndex: messageIndex });
  };
  const copy = document.createElement('button');
  copy.className = 'msg-action-btn';
  copy.title = 'Copy reply text';
  copy.innerHTML = '📋 Copy';
  copy.onclick = () => {
    const content = (chatMessages[messageIndex] && chatMessages[messageIndex].content) || '';
    navigator.clipboard.writeText(content).then(() => {
      copy.innerHTML = '✅ Copied';
      setTimeout(() => { copy.innerHTML = '📋 Copy'; }, 1500);
    });
  };
  const reply = document.createElement('button');
  reply.className = 'msg-action-btn';
  reply.title = 'Reply to this message — quote it in your next prompt';
  reply.innerHTML = '💬 Reply';
  reply.onclick = () => { startReplyTo(messageIndex); };
  const save = document.createElement('button');
  save.className = 'msg-action-btn';
  save.title = 'Save this reply to a file in agent-outputs/';
  save.innerHTML = '💾 Save';
  save.onclick = async () => {
    const content = (chatMessages[messageIndex] && chatMessages[messageIndex].content) || '';
    if (!content) return;
    const suggested = await promptToast('Save reply as (filename, leave blank for auto):', '');
    if (suggested === null) return; // cancel
    save.innerHTML = '⏳ Saving';
    try {
      const r = await fetch('/api/save-output', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: suggested.trim() || undefined }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      save.innerHTML = '✅ ' + (data.relativePath || data.name);
      save.title = 'Saved → ' + (data.relativePath || data.path);
      setTimeout(() => { save.innerHTML = '💾 Save'; save.title = 'Save this reply to a file in agent-outputs/'; }, 4000);
    } catch (e) {
      save.innerHTML = '✗ Failed';
      setTimeout(() => { save.innerHTML = '💾 Save'; }, 2000);
      showToast('Save failed: ' + (e && e.message ? e.message : e));
    }
  };
  row.appendChild(regen);
  row.appendChild(copy);
  row.appendChild(reply);
  row.appendChild(save);
  body.appendChild(row);
}

/**
 * Pull a human-friendly title for a citation from the web_read output.
 * The web_read tool prepends "Content from <url>:" then the body. We
 * try to find the first non-trivial line that looks like a title.
 */
function extractCitationTitle(toolOutput, url) {
  if (!toolOutput) return url;
  const lines = String(toolOutput).split('\n').map((l) => l.trim()).filter(Boolean);
  // Skip the "Content from <url>:" header.
  for (const line of lines) {
    if (line.startsWith('Content from ')) continue;
    if (line.length < 8 || line.length > 120) continue;
    return line;
  }
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e){ return url; }
}

/**
 * Attach a numbered citation list under an assistant message and
 * rewrite raw URL mentions in the visible reply to [n] superscripts.
 * Mutates the rendered DOM only — chatMessages history keeps the
 * original text so regenerate / save / copy stay clean.
 */
function attachCitations(msgEl, citations, originalText) {
  if (!msgEl || !citations || citations.length === 0) return;
  const body = msgEl.querySelector('.msg-body');
  const content = msgEl.querySelector('.msg-content');
  if (!body || !content) return;

  // Rewrite URL mentions in the rendered HTML to [n] superscript links.
  citations.forEach((c, i) => {
    const n = i + 1;
    const url = c.url;
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace bare URL text (not already inside <a>) with the original
    // URL plus a [n] superscript link.
    const re = new RegExp('(?<![">\\w/])' + escapedUrl + '(?![">\\w/])', 'g');
    content.innerHTML = content.innerHTML.replace(re, function (match) {
      return match + '<sup><a href="' + url + '" target="_blank" rel="noopener" class="citation-sup" title="' + esc(c.title) + '">[' + n + ']</a></sup>';
    });
  });

  // Append the source list.
  const wrap = document.createElement('div');
  wrap.className = 'citations';
  wrap.innerHTML = '<div class="citations-label">Sources</div>';
  citations.forEach((c, i) => {
    const item = document.createElement('a');
    item.className = 'citation-item';
    item.href = c.url;
    item.target = '_blank';
    item.rel = 'noopener';
    let host = c.url;
    try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch(e){}
    item.innerHTML = '<span class="citation-num">[' + (i + 1) + ']</span><span class="citation-title">' + esc(c.title) + '</span><span class="citation-host">' + esc(host) + '</span>';
    wrap.appendChild(item);
  });
  body.appendChild(wrap);
}

/**
 * Render 3 follow-up suggestion chips after an assistant reply.
 * Heuristics-only (no model call): inspect the assistant text for code
 * blocks, file references, and tool-result markers, plus the user's
 * intent, and offer the 3 most likely next moves.
 */
function renderFollowUpChips(userText, assistantText) {
  if (typeof HarnessFollowUps === 'undefined') return;
  const suggestions = HarnessFollowUps.computeFollowUps(userText, assistantText);
  if (!suggestions.length) return;
  const area = document.getElementById('chatArea');
  if (!area) return;
  const wrap = document.createElement('div');
  wrap.className = 'followup-chips';
  wrap.setAttribute('aria-label', 'Suggested follow-up prompts');
  wrap.innerHTML = '<div class="followup-label">Try next:</div>';
  for (const s of suggestions) {
    const chip = document.createElement('button');
    chip.className = 'followup-chip';
    chip.textContent = s;
    chip.onclick = () => {
      const inp = document.getElementById('chatInput');
      inp.value = s;
      inp.focus();
      sendMessage();
    };
    wrap.appendChild(chip);
  }
  area.appendChild(wrap);
  scrollBottom();
}

// Inline mycelium context cards. After each assistant turn, surface the
// skills/memories/workflows the router selected so users learn what the
// system has without having to open the left rail manually. Each card
// reveals the panel + opens the right tab on click. Hide entirely when
// nothing actionable was selected (the common case for trivial chat).
const CTX_CARD_TYPE_META = {
  skill:           { icon: '⚡', tab: 'skills',    label: 'Skill' },
  memory:          { icon: '🧠', tab: 'memory',    label: 'Memory' },
  workflow:        { icon: '⚙', tab: 'workflows', label: 'Workflow' },
  prompt_template: { icon: '📝', tab: 'memory',    label: 'Prompt' },
  service:         { icon: '🛎', tab: 'runs',      label: 'Service' },
  tool:            { icon: '🔧', tab: 'tools',     label: 'Tool' },
  document:        { icon: '📄', tab: 'rag',       label: 'Document' },
};

let _lastContextCardSignature = '';

async function renderMyceliumContextCards(userText) {
  const area = document.getElementById('chatArea');
  if (!area) return;
  let payload;
  try {
    const res = await fetch('/api/mycelium/last-route');
    if (!res.ok) return;
    payload = await res.json();
  } catch(e){ return; }
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  if (nodes.length === 0) return;
  const queryLc = (userText || '').trim().toLowerCase();
  const eligible = nodes
    .filter((node) => node && CTX_CARD_TYPE_META[node.type])
    // Don't echo nodes whose label IS the user query (self-routes).
    .filter((node) => (node.label || '').toLowerCase() !== queryLc)
    // Skip very low-trust nodes — likely noise.
    .filter((node) => typeof node.trust !== 'number' || node.trust >= 0.3)
    .slice(0, 4);
  if (eligible.length === 0) return;
  // Avoid repeating the exact same card set on consecutive turns.
  const signature = eligible.map((n) => n.id).sort().join('|');
  if (signature === _lastContextCardSignature) return;
  _lastContextCardSignature = signature;
  const wrap = document.createElement('div');
  wrap.className = 'context-cards';
  wrap.setAttribute('aria-label', 'Relevant context the system used');
  const labelRow = document.createElement('div');
  labelRow.className = 'context-cards-label';
  labelRow.innerHTML = '<span>Used for this turn</span>';
  const dismiss = document.createElement('button');
  dismiss.className = 'ctx-dismiss';
  dismiss.type = 'button';
  dismiss.title = 'Dismiss';
  dismiss.textContent = '×';
  dismiss.onclick = () => wrap.remove();
  labelRow.appendChild(dismiss);
  wrap.appendChild(labelRow);
  for (const node of eligible) {
    const meta = CTX_CARD_TYPE_META[node.type];
    const card = document.createElement('button');
    card.className = 'context-card';
    card.type = 'button';
    card.title = (node.summary || node.label || '') + ' — open in ' + meta.label + ' tab';
    const summary = (node.summary || '').replace(/\s+/g, ' ').trim();
    card.innerHTML = '<div class="ctx-row"><span class="ctx-icon">' + meta.icon + '</span><span class="ctx-label">' + esc(node.label || node.id) + '</span></div>'
      + (summary ? '<div class="ctx-summary">' + esc(summary) + '</div>' : '');
    card.onclick = () => {
      try { openLeftTabByName(meta.tab); } catch (e) { console.warn('context card open failed', e); }
    };
    wrap.appendChild(card);
  }
  area.appendChild(wrap);
  scrollBottom();
}

// ─── Slash command palette ─────────────────────────────────────────────
// Opens when the composer's first character is `/`. Up/down to navigate,
// Enter to apply (replaces the input), Esc/Tab also work. Commands are
// declared once here and map to existing UI actions.

const SLASH_COMMANDS = [
  { cmd: '/files',       desc: 'Open the Files tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('files'); },
    fallback: '' },
  { cmd: '/skills',      desc: 'Open the Skills tab',
    apply: () => { hideSlashPalette(); openSkillsTab(); },
    fallback: '' },
  { cmd: '/memory',      desc: 'Open the Memory tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('memory'); },
    fallback: '' },
  { cmd: '/history',     desc: 'Open the History tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('history'); },
    fallback: '' },
  { cmd: '/learning',    desc: 'Open the Learning (🧠) tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('learning'); },
    fallback: '' },
  { cmd: '/discover',    desc: 'Open the Discover tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('discover'); },
    fallback: '' },
  { cmd: '/palace',      desc: 'Open the Memory Palace tab',
    apply: () => { hideSlashPalette(); openLeftTabByName('palace'); },
    fallback: '' },
  { cmd: '/snapshots',   desc: 'Open the Snapshots tab (skills + memory backups)',
    apply: () => { hideSlashPalette(); openLeftTabByName('snapshots'); },
    fallback: '' },
  { cmd: '/rag',         desc: 'Open the Local RAG tab (build + search local indexes)',
    apply: () => { hideSlashPalette(); openLeftTabByName('rag'); },
    fallback: '' },
  { cmd: '/tools',       desc: 'Open the Local Tools dashboard (status of everything)',
    apply: () => { hideSlashPalette(); openLeftTabByName('tools'); },
    fallback: '' },
  { cmd: '/voice',       desc: 'Toggle voice input (browser STT)',
    apply: () => { hideSlashPalette(); toggleVoiceInput(); },
    fallback: '' },
  { cmd: '/new',         desc: 'Start a new chat (clears the current conversation)',
    apply: () => { hideSlashPalette(); newChat(); },
    fallback: '' },
  { cmd: '/export',      desc: 'Export the current chat as Markdown',
    apply: () => { hideSlashPalette(); exportChat(); },
    fallback: '' },
  { cmd: '/settings',    desc: 'Toggle the settings panel',
    apply: () => { hideSlashPalette(); toggleRight(); },
    fallback: '' },
  { cmd: '/help',        desc: 'Show all slash commands (built-in + skills)',
    apply: () => { hideSlashPalette(); openHelpModal(); },
    fallback: '' },
  { cmd: '/stop',        desc: 'Stop the current agent run',
    apply: () => { hideSlashPalette(); if (activeChatController) activeChatController.abort(); },
    fallback: '' },
  { cmd: '/task',        desc: 'Add a task to the autonomy plan (type /task followed by the task description)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/schedule',    desc: 'Create a recurring automation job (type /schedule followed by the prompt)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/goal',        desc: 'Expand a high-level intent into autonomy tasks (e.g. /goal Build a wiki from D:\\big.pdf)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/run',         desc: 'Run an Active Goal end-to-end (e.g. /run gather notes -- verify file:agent-outputs/notes.md, or -- verify npm test)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/priority',    desc: 'Set your top priority for today (e.g. /priority ship the Hermes features)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/wiki',        desc: 'Turn a PDF into a chaptered wiki + RAG chat page (e.g. /wiki D:\\big.pdf)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/research',    desc: 'Generate a research report on any subject (e.g. /research Acme Corp tech stack)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/memory-wiki', desc: 'Rebuild your personal memory wiki from all stored memories',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: false },
  { cmd: '/kanban',      desc: 'Show or manage the Kanban board (e.g. /kanban or /kanban move <id> triage)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/brief',       desc: 'Generate your daily brief right now',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: false },
  { cmd: '/yolo',        desc: 'Full-send: dontAsk + all grants + autonomy loop (e.g. /yolo 2h)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
  { cmd: '/auto',        desc: 'Autonomous lead agent: plans + spawns sub-agents to finish a task (e.g. /auto build a todo API)',
    apply: () => { hideSlashPalette(); },
    fallback: '',
    takesArgs: true },
];

// Dynamic slash commands populated from /api/skills so users can autocomplete
// `/skill-name` directly from the chat composer. Refreshed by loadSkills().
let dynamicSkillSlashCommands = [];

function refreshSkillSlashCommands(skills) {
  const seen = new Set(SLASH_COMMANDS.map((c) => c.cmd));
  dynamicSkillSlashCommands = (skills || [])
    .filter((s) => s && s.name && s.enabled !== false)
    .map((s) => ({
      cmd: '/' + s.name,
      desc: s.description ? ('Skill · ' + s.description) : 'Run skill',
      apply: ((name) => () => {
        hideSlashPalette();
        const input = document.getElementById('chatInput');
        if (!input) return;
        // Guard: if no model is picked yet, an inner sendMessage() will
        // alert and bail silently. Surface that as a visible chat message
        // so the user knows why their /skill click did nothing.
        const modelEl = document.getElementById('modelSelect');
        if (!modelEl || !modelEl.value) {
          try { addMsg('assistant', '⚠️ Pick a model first (top of the chat) before running `/' + name + '`.'); } catch(e){}
          input.value = 'Use the skill: ' + name;
          input.focus();
          try { autoSize(input); } catch(e){}
          return;
        }
        input.value = 'Use the skill: ' + name;
        input.focus();
        try { autoSize(input); } catch(e){}
        sendMessage().catch((error) => {
          const detail = (error && error.message) ? error.message : String(error);
          try { addMsg('assistant', '⚠️ Could not run skill `' + name + '`: ' + detail); } catch(e){}
          console.warn('skill slash command failed', error);
        });
      })(s.name),
      fallback: '',
    }))
    .filter((c) => !seen.has(c.cmd));
}

const slashPaletteState = { visible: false, index: 0, filtered: [] };

function getAllSlashCommands() {
  return SLASH_COMMANDS.concat(dynamicSkillSlashCommands);
}

// ── Plain-English → feature suggestions ──────────────────────────────
// Beginners type "back up my stuff", not "/snapshots". This deterministic,
// LLM-free matcher maps natural phrasing onto the slash commands that already
// exist, then surfaces a one-click chip. The button reuses each command's own
// apply(), so there is no duplicate navigation logic. Ordered most-specific
// first; the first matching pattern wins.
const FEATURE_INTENTS = [
  { cmd: '/snapshots', label: 'back up your skills & memory', re: /\b(back\s?up|backup)\b.*\b(data|settings|stuff|everything|memor|skill|chat|work)|\bsnapshot/i },
  { cmd: '/memory',    label: 'see what I remember about you',  re: /\bwhat.*(remember|know about me)|\bmy memor|\bremember about me/i },
  { cmd: '/tools',     label: 'see the tools you can use',      re: /\b(what|which|list).{0,12}tools|\byour tools\b|\btool status\b|\btools.{0,12}(have|available)/i },
  { cmd: '/skills',    label: 'see your skills',                re: /\b(what|which|list|my)\b.{0,8}skills\b|\byour skills\b/i },
  { cmd: '/rag',       label: 'search your local documents',   re: /\b(search|index|build).{0,16}(docs|documents|notes|files|folder|pdf)|\blocal rag\b/i },
  { cmd: '/files',     label: 'browse your files',             re: /\bmy files\b|\b(show|browse|open|see).{0,8}files\b/i },
  { cmd: '/history',   label: 'see your chat history',         re: /\bchat history\b|\bpast chats\b|\bprevious (chats|conversations)\b|\bmy history\b/i },
  { cmd: '/new',       label: 'start a new chat',              re: /\bnew chat\b|\bstart over\b|\bclear (the )?chat\b|\breset (the )?(chat|conversation)\b|\bfresh chat\b/i },
  { cmd: '/export',    label: 'export this chat',              re: /\bexport.{0,12}(chat|conversation)|\bsave (this )?(chat|conversation)\b|\bdownload (this )?chat\b/i },
  { cmd: '/settings',  label: 'open settings',                 re: /\bopen settings\b|\bmy settings\b|\bpreferences\b|\bchange settings\b/i },
  { cmd: '/brief',     label: 'generate your daily brief',     re: /\bdaily brief\b|\bmy brief\b|\bcatch me up\b/i },
  { cmd: '/kanban',    label: 'open your task board',          re: /\bkanban\b|\btask board\b|\bmy board\b/i },
  // Argument-taking commands: the chip prefills "/cmd <arg>" (arg extracted
  // from the phrasing when clean) and focuses the box. It never auto-sends, so
  // the user can review a path or topic before kicking off a long operation.
  { cmd: '/wiki',     label: 'turn a document into a wiki',          btnLabel: 'Set up',   takesArgs: true,
    re: /\b(make|build|create|turn)\b.{0,20}\bwiki\b|\bwiki\b.{0,12}\b(from|out of)\b/i,
    arg: /(?:from|out of|on)\s+(.+?)(?:\s+into\s+a\s+wiki)?$|turn\s+(.+?)\s+into\s+a\s+wiki/i },
  { cmd: '/research', label: 'research a topic and write a report',  btnLabel: 'Start',    takesArgs: true,
    re: /\bresearch\b|\breport on\b|\blook into\b/i,
    arg: /(?:research(?:\s+on)?|report on|look into)\s+(.+)$/i },
  { cmd: '/goal',     label: 'break a big goal into autonomous tasks', btnLabel: 'Set up', takesArgs: true,
    re: /\bmy goal is\b|\bset (a |my )?goal\b|\bbreak (this|it) down into (steps|tasks)\b/i,
    arg: /(?:my goal is|set (?:a |my )?goal(?: to| of| is)?)\s+(.+)$/i },
  { cmd: '/schedule', label: 'schedule a recurring job',             btnLabel: 'Schedule', takesArgs: true,
    re: /\bevery\s+\d+\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b|\bremind me every\b/i,
    arg: /(remind me every\s+.+)$|(every\s+.+)$/i },
  { cmd: '/priority', label: 'set your top priority for today',      btnLabel: 'Set',      takesArgs: true,
    re: /\bmy (top )?priority\b|\bpriority for today\b|\btop priority is\b/i,
    arg: /priority(?:\s+(?:is|for today is|today is))?\s+(.+)$/i },
  { cmd: '/yolo',     label: 'run fully autonomous for a while',     btnLabel: 'Start',    takesArgs: true,
    re: /\byolo\b|\bfull[\s-]?send\b|\bgo (fully )?autonomous\b/i,
    arg: /\b(\d+\s*(?:h|hr|hrs|hours?|m|min|minutes?))\b/i },
  { cmd: '/help',      label: 'see what you can do here',      re: /\bwhat can (you|i) (do|type)\b|\bshow .{0,8}commands\b|\blist commands\b|\bhelp me get started\b/i },
];

let intentChipDismissedFor = '';

function detectFeatureIntent(text) {
  for (const intent of FEATURE_INTENTS) {
    if (intent.re.test(text)) return intent;
  }
  return null;
}

function hideIntentChip() {
  const chip = document.getElementById('intentChip');
  if (chip) chip.classList.add('hidden');
}

function maybeShowIntentChip(value) {
  const chip = document.getElementById('intentChip');
  if (!chip) return;
  const v = (value || '').trim();
  // Stay out of the slash palette's way and ignore tiny/dismissed input.
  if (!v || v.startsWith('/') || v.length < 4 || slashPaletteState.visible || v === intentChipDismissedFor) {
    hideIntentChip();
    return;
  }
  const hit = detectFeatureIntent(v);
  if (!hit) { hideIntentChip(); return; }
  chip.textContent = '';
  const text = document.createElement('span');
  text.textContent = '💡 Sounds like you want to ' + hit.label + '.';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'intent-chip-btn';
  open.textContent = hit.btnLabel || 'Open';
  open.onclick = () => {
    hideIntentChip();
    if (hit.takesArgs) {
      // Prefill "/cmd <arg>" and focus; the user reviews, then presses Enter.
      const input = document.getElementById('chatInput');
      if (!input) return;
      let argText = '';
      if (hit.arg) {
        const m = v.match(hit.arg);
        if (m) argText = (m[1] || m[2] || '').trim();
      }
      input.value = hit.cmd + (argText ? ' ' + argText : ' ');
      input.focus();
      try { autoSize(input); } catch (e) {}
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      return;
    }
    const c = getAllSlashCommands().find((x) => x.cmd === hit.cmd);
    if (c && typeof c.apply === 'function') c.apply();
  };
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'intent-chip-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.textContent = '✕';
  dismiss.onclick = () => { intentChipDismissedFor = v; hideIntentChip(); };
  chip.appendChild(text);
  chip.appendChild(open);
  chip.appendChild(dismiss);
  chip.classList.remove('hidden');
}

function maybeShowSlashPalette(value) {
  if (!value || !value.startsWith('/')) {
    if (slashPaletteState.visible) hideSlashPalette();
    return;
  }
  // Hide once the user types past the command name (a space marks args mode).
  if (value.includes(' ')) { hideSlashPalette(); return; }
  const prefix = value.toLowerCase();
  const term = prefix.slice(1); // drop the leading '/' for description matching
  const all = getAllSlashCommands();
  if (value === '/') {
    slashPaletteState.filtered = all;
    slashPaletteState.index = 0;
    slashPaletteState.visible = true;
    renderSlashPalette();
    return;
  }
  // Prefer prefix matches on the command itself; fall back to substring match
  // on description so `/search` finds `/web-research` etc. Prefix matches sort
  // first so the obvious intent stays at the top of the palette.
  const prefixHits = all.filter((c) => c.cmd.toLowerCase().startsWith(prefix));
  const descHits = term.length >= 2
    ? all.filter((c) => !c.cmd.toLowerCase().startsWith(prefix) && (c.desc || '').toLowerCase().includes(term))
    : [];
  const filtered = prefixHits.concat(descHits);
  if (filtered.length === 0) { hideSlashPalette(); return; }
  slashPaletteState.filtered = filtered;
  slashPaletteState.index = 0;
  slashPaletteState.visible = true;
  renderSlashPalette();
}

function renderSlashPalette() {
  const palette = document.getElementById('slashPalette');
  const list = document.getElementById('slashPaletteList');
  if (!palette || !list) return;
  palette.classList.remove('hidden');
  list.innerHTML = '';
  slashPaletteState.filtered.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'slash-palette-item' + (i === slashPaletteState.index ? ' active' : '');
    item.setAttribute('role', 'option');
    item.dataset.idx = String(i);
    item.innerHTML = '<span class="sp-cmd">' + esc(c.cmd) + '</span><span class="sp-desc">' + esc(c.desc) + '</span>';
    // Update active highlight without rebuilding the DOM. Rebuilding here
    // destroys the element before mousedown/click can fire, which is why
    // palette items used to look selectable but ignore clicks.
    item.onmouseenter = () => {
      slashPaletteState.index = i;
      updateSlashPaletteHighlight();
    };
    // Use mousedown + preventDefault so the textarea keeps focus and the
    // item handler fires before any focus/blur reshuffle can drop the click.
    item.onmousedown = (ev) => {
      ev.preventDefault();
      slashPaletteState.index = i;
      applySelectedSlashCommand();
    };
    list.appendChild(item);
  });
}

function updateSlashPaletteHighlight() {
  const list = document.getElementById('slashPaletteList');
  if (!list) return;
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === slashPaletteState.index);
  }
}

function moveSlashSelection(delta) {
  if (!slashPaletteState.visible) return;
  const n = slashPaletteState.filtered.length;
  if (n === 0) return;
  slashPaletteState.index = (slashPaletteState.index + delta + n) % n;
  updateSlashPaletteHighlight();
}

function applySelectedSlashCommand() {
  if (!slashPaletteState.visible) return;
  const choice = slashPaletteState.filtered[slashPaletteState.index];
  if (!choice) return;
  const inp = document.getElementById('chatInput');
  const currentValue = inp ? inp.value : '';

  // takesArgs commands: don't wipe input on Enter — autocomplete the command
  // so the user can type args, or if args are already present, submit. This
  // fixes the "type /goal, hit Enter, nothing happens" beginner trap where
  // the old behavior cleared the input and silently closed the palette.
  if (choice.takesArgs) {
    const cmdEsc = choice.cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasArgs = new RegExp('^\\s*' + cmdEsc + '\\s+\\S', 'i').test(currentValue);
    if (hasArgs) {
      hideSlashPalette();
      sendMessage();
      return;
    }
    if (inp) {
      inp.value = choice.cmd + ' ';
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
    hideSlashPalette();
    return;
  }

  // No-args command: invoke its apply handler (preserves existing behavior).
  if (inp) { inp.value = choice.fallback || ''; autoSize(inp); inp.focus(); }
  try { choice.apply(); } catch (e) { console.warn('slash command failed', e); }
}

function hideSlashPalette() {
  slashPaletteState.visible = false;
  slashPaletteState.filtered = [];
  const palette = document.getElementById('slashPalette');
  if (palette) palette.classList.add('hidden');
}

function openLeftTabByName(name) {
  // Maps friendly slash-command names to (a) the dispatch key showLeftTab
  // expects and (b) a substring that uniquely identifies the tab DOM node
  // (text content or emoji). Falls back to a literal text match for
  // unknown names so adding new tabs doesn't require touching this map.
  const TAB_MAP = {
    history: { key: 'history', text: 'chats' },
    chats: { key: 'history', text: 'chats' },
    files: { key: 'files', text: 'files' },
    skills: { key: 'skills', text: 'skills' },
    memory: { key: 'memory', text: 'memory' },
    palace: { key: 'palace', text: 'palace' },
    discover: { key: 'discovery', text: 'discover' },
    discovery: { key: 'discovery', text: 'discover' },
    learning: { key: 'learning', text: 'learning' },
    snapshots: { key: 'snapshots', text: 'snaps' },
    snaps: { key: 'snapshots', text: 'snaps' },
    rag: { key: 'rag', text: 'rag' },
    tools: { key: 'tools', text: 'tools' },
  };
  const lookup = TAB_MAP[name.toLowerCase()] || { key: name, text: name.toLowerCase() };
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const tab = tabs.find((t) => (t.textContent || '').toLowerCase().includes(lookup.text.toLowerCase()));
  revealLeftPanel();
  if (tab) { showLeftTab(lookup.key, tab); return; }
  // No visible tab matched — but the key may still be a valid view that
  // lives under the "More" overflow menu (autonomy, runs, tools, etc.).
  // showLeftTab() switches view by id regardless of which DOM tab was
  // clicked, so call it directly without a tab element. Without this
  // fallback, inbox cards targeting More-menu views appear to do nothing.
  if (typeof MORE_MENU_TABS !== 'undefined' && MORE_MENU_TABS.includes(lookup.key)) {
    try { showLeftTab(lookup.key); } catch (e) { console.warn('openLeftTabByName fallback failed', e); }
  }
}

async function loadHistory() {
  const q = (document.getElementById('historySearch')?.value || '').trim();
  if (q) { await searchHistory(q); return; }
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    renderHistoryList(d.chats || [], '', false);
  } catch(e){}
}

function renderHistoryList(items, query, isSearch) {
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  if (items.length === 0 && query) {
    list.innerHTML = '<div style="padding:16px 12px;font-size:12px;color:var(--text-dim)">No chats match "' + esc(query) + '"</div>';
    return;
  }
  for (const c of items) {
    const el = document.createElement('div');
    el.className = 'history-item' + (c.id === currentChatId ? ' active' : '');
    const titleHtml = query ? hlMatch(esc(c.title), query) : esc(c.title);
    const snippetHtml = isSearch && c.snippet ? '<div class="history-match-snippet">' + hlMatch(esc(c.snippet), query) + '</div>' : '';
    const meta = isSearch ? (c.matchCount + ' match' + (c.matchCount !== 1 ? 'es' : '')) : (c.messageCount + ' msgs');
    el.innerHTML = '<div style="min-width:0;flex:1"><div class="history-title">' + titleHtml + '</div><div class="history-date">' + meta + '</div>' + snippetHtml + '</div><button class="history-del" onclick="event.stopPropagation();deleteChat(\'' + c.id + '\')">🗑</button>';
    el.onclick = () => loadChat(c.id);
    list.appendChild(el);
  }
}

function hlMatch(html, query) {
  if (!query) return html;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark class="history-hl">$1</mark>');
}

let _historySearchTimer = null;
function onHistorySearch(val) {
  clearTimeout(_historySearchTimer);
  _historySearchTimer = setTimeout(() => {
    if (val.trim()) searchHistory(val.trim());
    else loadHistory();
  }, 250);
}

async function searchHistory(q) {
  try {
    const r = await fetch('/api/history/search?q=' + encodeURIComponent(q));
    const d = await r.json();
    renderHistoryList(d.results || [], q, true);
  } catch(e){}
}

async function loadChat(id) { try { const r = await fetch('/api/history/' + id); const d = await r.json(); currentChatId = id; chatMessages = d.messages || []; document.getElementById('chatArea').innerHTML = ''; for (const m of chatMessages) addMsg(m.role, m.content); saveChatSession(); loadHistory(); } catch(e){} }
async function autoSaveChat() { if (chatMessages.length < 2) return; const title = chatMessages[0].content.slice(0, 60); try { const r = await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentChatId, title, messages: chatMessages }) }); const d = await r.json(); if (!currentChatId) currentChatId = d.id; saveChatSession(); loadHistory(); } catch(e){} }
async function deleteChat(id) { await fetch('/api/history/' + id, { method: 'DELETE' }); if (id === currentChatId) newChat(); loadHistory(); }
function newChat() {
  // If current tab has messages, create a new tab; otherwise reuse the current one
  if (chatMessages.length > 0 && sessionTabs.size > 0) {
    createSessionTab();
  }
  currentChatId = null; chatMessages = []; resetSessionUsage(); saveChatSession(); document.getElementById('chatArea').innerHTML = welcomeMarkup(); renderModelCapabilityHint(); updateNoModelEmptyState(); loadReadiness(); loadSettings(); loadHistory();
  if (activeTabId) {
    const tab = sessionTabs.get(activeTabId);
    if (tab) { tab.chatMessages = []; tab.currentChatId = null; tab.status = 'idle'; tab.title = 'New chat'; tab.htmlSnapshot = null; }
    renderSessionTabs();
  }
}
function getPersonalityGreeting(name, personalityText) {
  const p = personalityText.toLowerCase();
  if (p.includes('pirate')) return { headline: 'Ahoy! Captain ' + name + ' at yer service!', subtitle: 'Set course for yer next task, matey. I can navigate files, chart code, search the seven seas of the web, and remember every port we visit.' };
  if (p.includes('mentor')) return { headline: name + ' here — ready to learn together', subtitle: 'Ask me anything and I\'ll walk you through the reasoning. We\'ll read files, write code, and build understanding step by step.' };
  if (p.includes('concise')) return { headline: name, subtitle: 'Ready. Ask anything.' };
  if (p.includes('creative')) return { headline: 'Let\'s create something new with ' + name, subtitle: 'I love exploring possibilities. Throw me a challenge — code, research, design, or something nobody\'s tried before.' };
  if (p.includes('friendly')) return { headline: 'Hey! ' + name + ' here 👋', subtitle: 'So glad you\'re here! I can help with files, code, web searches, skills, and more. What sounds fun to work on?' };
  if (p.includes('professional')) return { headline: name + ' — Technical Assistant', subtitle: 'Select a model above, then submit your request. Capabilities include file operations, code generation, shell commands, web research, and skill management.' };
  if (name !== 'Harness') return { headline: 'Meet ' + name, subtitle: 'Pick a model above, then ask me anything. I can read files, write code, run commands, search the web, create skills, and remember things across sessions.' };
  return { headline: 'What can I help you with?', subtitle: 'Type a message below and press Enter. I can read files, write code, search the web, and remember things across sessions.' };
}

function welcomeMarkup() {
  // Mirrors the redesigned hero in index.html so /new and /reset render
  // the same modern welcome card the page boots into.
  const name = currentAgentName || 'Harness';
  const personalityText = document.getElementById('personalityText')?.value || '';
  const greeting = getPersonalityGreeting(name, personalityText);
  return ''
    + '<div class="welcome" id="welcome">'
    + '<div class="welcome-hero">'
    + '<div class="welcome-eyebrow">Local-first AI agent · Ollama</div>'
    + '<h2>' + esc(greeting.headline) + '</h2>'
    + '<p>' + esc(greeting.subtitle) + '</p>'
    + '</div>'
    + '<div class="quick-start-panel">'
    + '<div class="quick-start-body"><strong>Start here</strong><span id="quickStartHint">Step 1: Pick a model above to unlock quick start.</span></div>'
    + '<div class="quick-start-actions"><button id="quickStartBtn" class="btn-sm primary" onclick="startQuickTest()">Start quick test</button><button class="btn-sm" onclick="openFirstRunGuide()">Open setup guide</button></div>'
    + '</div>'
    + '<div class="quick-suggestions" id="quickSuggestions" data-populated="1">'
    + quickStartChipsMarkup()
    + '</div>'
    + '<details class="welcome-disclosure"><summary>What can I do? — full capability list</summary>'
    + '<div class="welcome-capabilities">'
    + '<div class="cap-group"><div class="cap-icon">📁</div><div><strong>Files</strong><br>Read, write, edit, search, and list project files</div></div>'
    + '<div class="cap-group"><div class="cap-icon">💻</div><div><strong>Code</strong><br>Write, refactor, and debug code in any language</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🔧</div><div><strong>Shell</strong><br>Run terminal commands and scripts (with permission)</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🌐</div><div><strong>Web</strong><br>Search the web, fetch pages, read documentation</div></div>'
    + '<div class="cap-group"><div class="cap-icon">📄</div><div><strong>Documents</strong><br>Generate CSV, Excel, Word, and PDF files</div></div>'
    + '<div class="cap-group"><div class="cap-icon">📧</div><div><strong>Email</strong><br>Draft and send emails with attachments via SMTP</div></div>'
    + '<div class="cap-group"><div class="cap-icon">📱</div><div><strong>Telegram</strong><br>Chat from your phone, send photos, voice notes</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🖼️</div><div><strong>Vision</strong><br>Analyze images and screenshots with a vision model</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🎤</div><div><strong>Audio</strong><br>Transcribe voice recordings and audio files</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🧠</div><div><strong>Memory</strong><br>Remember context, patterns, and preferences across sessions</div></div>'
    + '<div class="cap-group"><div class="cap-icon">⚡</div><div><strong>Skills</strong><br>Create and use reusable AI capabilities</div></div>'
    + '<div class="cap-group"><div class="cap-icon">🤖</div><div><strong>Autonomy</strong><br>Run tasks automatically from a plan, no human in the loop</div></div>'
    + '</div></details>'
    + '<details class="welcome-disclosure" id="welcomeFirstRun"' + (localStorage.getItem('harness_tour_seen') ? '' : ' open') + '>'
    + '<summary>New here? Quick guided tour (2 minutes)</summary>'
    + '<div class="welcome-disclosure-body">'
    + '<div class="guided-tour" id="guidedTour">'
    + '<div class="guide-step accent">'
    + '<span class="guide-step-icon">①</span>'
    + '<div><strong>Pick a model</strong><br>Look at the dropdown at the top of the page. Select a model (e.g. <code>llama3.2</code>). If none appear, make sure Ollama is running.</div>'
    + '</div>'
    + '<div class="guide-step accent">'
    + '<span class="guide-step-icon">②</span>'
    + '<div><strong>Send your first message</strong><br>Type something in the box below and press Enter. Try: <a href="#" class="accent-link" onclick="sendTip({textContent:\'What files are in this project?\'}); event.preventDefault()">"What files are in this project?"</a></div>'
    + '</div>'
    + '<div class="guide-step accent">'
    + '<span class="guide-step-icon">③</span>'
    + '<div><strong>Explore the sidebar</strong><br>Click the tabs on the left to see your <strong>Files</strong>, <strong>Skills</strong>, <strong>Memory</strong>, and <strong>Tools</strong>. Each tab shows a different part of the system.</div>'
    + '</div>'
    + '<div class="guide-step accent">'
    + '<span class="guide-step-icon">④</span>'
    + '<div><strong>Give your agent a personality</strong><br>Open <strong>Settings</strong> (⚙ top-right) → <strong>Agent Identity</strong>. Give it a name and pick a personality. Try "Pirate" for fun!</div>'
    + '</div>'
    + '<div class="guide-step success">'
    + '<span class="guide-step-icon">✅</span>'
    + '<div><strong>You\'re ready!</strong><br>That\'s the basics. The agent can search the web, write code, create skills, and remember things. Just ask it in plain English.</div>'
    + '</div>'
    + '</div>'
    + '<div class="beginner-guide" id="beginnerGuide"><div class="guide-item"><strong>Ask</strong>Use plain English for project questions, code changes, searches, and local tasks.</div><div class="guide-item"><strong>Attach</strong>Drop files below. Images and audio show model support hints before you send.</div><div class="guide-item"><strong>Recover</strong>Resume continues unfinished work; Fork starts a copy for a different direction.</div></div>'
    + '<div class="walkthrough-checklist" id="walkthroughChecklist">' + walkthroughChecklistMarkup() + '</div>'
    + '<div class="first-run-setup" id="firstRunSetup"><h3>First-run setup</h3><p>Set the local Ollama host and optional media helpers before your first chat.</p><div class="first-run-grid"><div><label for="firstRunOllamaHost">Ollama host</label><input id="firstRunOllamaHost" type="text" value="http://localhost:11434"></div><div><label for="firstRunVisionModel">Vision model</label><input id="firstRunVisionModel" type="text" placeholder="llava"></div><div><label for="firstRunAudioCommand">Audio command</label><input id="firstRunAudioCommand" type="text" placeholder="whisper &quot;{input}&quot; --model base"></div><div><label for="firstRunAudioSamplePath">Audio test file</label><input id="firstRunAudioSamplePath" type="text" placeholder=".harness/uploads/sample.wav"></div></div><div class="first-run-actions"><button class="btn-sm" onclick="applyFirstRunSetup()">Save setup</button><button class="btn-sm" onclick="checkFirstRunHealth()">Check setup</button><span class="first-run-status" id="firstRunStatus">Optional. You can change these later in Settings.</span></div><div class="trace-detail initial-hidden" id="firstRunHealth"></div></div>'
    + '</div>'
    + '</details>'
    + '</div>';
}
function exportChat() { if (!chatMessages.length) { showToast('No messages.'); return; } let md = '# Chat Export\n\n'; for (const m of chatMessages) md += '## ' + (m.role === 'user' ? 'You' : 'Assistant') + '\n\n' + m.content + '\n\n---\n\n'; const blob = new Blob([md], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chat-' + new Date().toISOString().slice(0, 10) + '.md'; a.click(); }

async function loadFiles(dir) {
  try {
    const url = '/api/files' + (dir ? '?path=' + encodeURIComponent(dir) : '');
    const r = await fetch(url);
    const d = await r.json();
    const tree = document.getElementById('fileTree');
    tree.innerHTML = '';
    // Filter input — type to hide non-matching file rows. Persists no state;
    // re-typing on directory change is fine for the small panel use case.
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'file-search-input';
    search.placeholder = '🔍 Filter files...';
    search.oninput = () => {
      const q = search.value.toLowerCase();
      tree.querySelectorAll('.file-item').forEach((el) => {
        const name = (el.dataset.name || '').toLowerCase();
        el.style.display = !q || name.includes(q) ? '' : 'none';
      });
    };
    tree.appendChild(search);
    if (dir) { const up = document.createElement('div'); up.className = 'file-item'; up.dataset.name = '..'; up.innerHTML = '<span class="file-icon">⬆</span> ..'; up.onclick = () => loadFiles(d.cwd.split(/[\\/]/).slice(0, -1).join('/')); tree.appendChild(up); }
    for (const item of d.items || []) { const el = document.createElement('div'); el.className = 'file-item'; el.dataset.name = item.name; el.innerHTML = '<span class="file-icon">' + (item.type === 'dir' ? '📁' : '📄') + '</span>' + esc(item.name); el.onclick = () => { if (item.type === 'dir') loadFiles(item.path); else { document.getElementById('chatInput').value = 'Read the file ' + item.name; sendMessage(); } }; tree.appendChild(el); }
  } catch(e){}
}

async function loadSkills() {
  try {
    const r = await fetch('/api/skills');
    const d = await r.json();
    const usageR = await fetch('/api/skills/usage').then((r) => r.json()).catch(() => ({ records: [] }));
    const curatorR = await fetch('/api/curator').then((r) => r.json()).catch(() => null);
    const usageMap = new Map((usageR.records || []).map((rec) => [rec.name, rec]));
    const list = document.getElementById('skillList');
    if (!list) return;
    list.innerHTML = '';
    const runtime = (d.sources || []).find((source) => source.source === 'runtime') || { skills: d.skills || [], diagnostics: [], mutable: true };
    const repo = (d.sources || []).find((source) => source.source === 'repo') || { skills: [], diagnostics: [], mutable: false };
    // Refresh dynamic slash commands so the chat composer can autocomplete `/<skill-name>`.
    refreshSkillSlashCommands(runtime.skills || []);
    // Stash everything the filter handlers need so we can re-render in place
    // without a network round-trip on every keystroke.
    skillsState = { runtime: runtime.skills || [], repo: repo.skills || [], usageMap, repoInstalled: new Set((runtime.skills || []).map((s) => s.name)) };
    const runtimeCount = skillsState.runtime.length;
    const enabledCount = skillsState.runtime.filter((s) => s.enabled !== false).length;
    const domains = Array.from(new Set([...skillsState.runtime, ...skillsState.repo].map((s) => s.domain || 'general'))).sort();
    let html = '<div class="skills-gallery-header"><h4>Your skills</h4>'
      + '<span class="skills-gallery-count">' + enabledCount + ' on / ' + runtimeCount + ' total</span></div>';
    html += '<div class="skills-search-row">'
      + '<input id="skillsSearchInput" type="text" placeholder="Search name or description..." oninput="filterSkillsGallery()">'
      + '<select id="skillsDomainFilter" onchange="filterSkillsGallery()" title="Filter by domain">'
      +   '<option value="">All domains</option>'
      +   domains.map((dom) => '<option value="' + escAttr(dom) + '">' + esc(dom) + '</option>').join('')
      + '</select>'
      + '<select id="skillsSortFilter" onchange="filterSkillsGallery()" title="Sort skills">'
      +   '<option value="recent">Recently used</option>'
      +   '<option value="most">Most used</option>'
      +   '<option value="name">Name (A→Z)</option>'
      +   '<option value="domain">Domain</option>'
      + '</select>'
      + '</div>';
    html += '<div id="skillsBulkToolbar" class="skills-bulk-toolbar hidden-by-default"></div>';
    html += '<div id="skillsGalleryRuntime"></div>';
    html += '<div id="skillsGalleryFeatured"></div>';
    // Curator + automation + diagnostics are admin surfaces — fold them under
    // a single "Manage skills" disclosure so they don't dominate the panel.
    const automationHtml = renderSkillAutomationPanel(runtime, repo);
    const curatorHtml = renderCuratorPanel(curatorR);
    const diagnosticsHtml = renderSkillDiagnostics(runtime.diagnostics || []);
    html += '<details class="skills-manage-fold">'
      + '<summary>Manage skills (curator, automation, diagnostics)</summary>'
      + '<div class="skills-manage-body">' + automationHtml + curatorHtml + diagnosticsHtml + '</div>'
      + '</details>';
    list.innerHTML = html;
    renderSkillsGallery();
    if (curatorR && curatorR.proposals) loadCuratorProposals();
  } catch(e){}
}

// In-memory state for the Skills gallery so filter changes don't refetch.
let skillsState = { runtime: [], repo: [], usageMap: new Map(), repoInstalled: new Set() };
const skillsBulkSelection = new Set();

function onSkillCardSelect(checkbox, name) {
  if (checkbox.checked) skillsBulkSelection.add(name);
  else skillsBulkSelection.delete(name);
  renderSkillsBulkToolbar();
}

function renderSkillsBulkToolbar() {
  const toolbar = document.getElementById('skillsBulkToolbar');
  if (!toolbar) return;
  if (skillsBulkSelection.size === 0) {
    toolbar.classList.add('hidden-by-default');
    toolbar.innerHTML = '';
    return;
  }
  toolbar.classList.remove('hidden-by-default');
  toolbar.innerHTML = '<strong>' + skillsBulkSelection.size + '</strong> selected · '
    + '<button class="btn-sm" onclick="bulkSetSkillsEnabled(true)">Enable</button> '
    + '<button class="btn-sm" onclick="bulkSetSkillsEnabled(false)">Disable</button> '
    + '<button class="btn-sm" onclick="bulkSetSkillsPinned(true)">Pin</button> '
    + '<button class="btn-sm" onclick="bulkSetSkillsPinned(false)">Unpin</button> '
    + '<button class="btn-sm danger" onclick="bulkDeleteSkills()">🗑 Delete</button> '
    + '<button class="btn-sm" onclick="clearSkillsBulkSelection()">Clear</button>';
}

function clearSkillsBulkSelection() {
  skillsBulkSelection.clear();
  document.querySelectorAll('.skill-card-select').forEach((cb) => { cb.checked = false; });
  renderSkillsBulkToolbar();
}

async function bulkSetSkillsEnabled(enabled) {
  const names = Array.from(skillsBulkSelection);
  if (names.length === 0) return;
  if (!await confirmToast((enabled ? 'Enable' : 'Disable') + ' ' + names.length + ' skill(s)?')) return;
  await Promise.all(names.map((name) => fetch('/api/skills/' + encodeURIComponent(name) + '/enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).catch(() => {})));
  clearSkillsBulkSelection();
  await loadSkills();
}

async function bulkSetSkillsPinned(pinned) {
  const names = Array.from(skillsBulkSelection);
  if (names.length === 0) return;
  if (!await confirmToast((pinned ? 'Pin' : 'Unpin') + ' ' + names.length + ' skill(s)?')) return;
  await Promise.all(names.map((name) => fetch('/api/skills/' + encodeURIComponent(name) + '/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  }).catch(() => {})));
  clearSkillsBulkSelection();
  await loadSkills();
}

async function bulkDeleteSkills() {
  const names = Array.from(skillsBulkSelection);
  if (names.length === 0) return;
  if (!await confirmToast('Permanently delete ' + names.length + ' skill(s)?\n\n' + names.join('\n'))) return;
  await Promise.all(names.map((name) => fetch('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' }).catch(() => {})));
  clearSkillsBulkSelection();
  await loadSkills();
}

function filterSkillsGallery() {
  renderSkillsGallery();
}

function renderSkillsGallery() {
  const search = (document.getElementById('skillsSearchInput')?.value || '').toLowerCase().trim();
  const domain = document.getElementById('skillsDomainFilter')?.value || '';
  const sort = document.getElementById('skillsSortFilter')?.value || 'recent';
  const matches = (s) => {
    if (domain && (s.domain || 'general') !== domain) return false;
    if (!search) return true;
    return (s.name || '').toLowerCase().includes(search) || (s.description || '').toLowerCase().includes(search);
  };
  const sortFn = (a, b) => {
    // Disabled skills always sink to the bottom regardless of primary sort —
    // an enabled skill is always more relevant than a disabled one.
    const aDisabled = a.enabled === false;
    const bDisabled = b.enabled === false;
    if (aDisabled !== bDisabled) return aDisabled ? 1 : -1;
    const ua = skillsState.usageMap.get(a.name) || {};
    const ub = skillsState.usageMap.get(b.name) || {};
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'domain') return (a.domain || 'general').localeCompare(b.domain || 'general') || (a.name || '').localeCompare(b.name || '');
    if (sort === 'most') return (ub.useCount || 0) - (ua.useCount || 0);
    // 'recent' default — most recently used first; never-used skills sink to bottom by name.
    const ta = ua.lastUsedAt ? Date.parse(ua.lastUsedAt) : 0;
    const tb = ub.lastUsedAt ? Date.parse(ub.lastUsedAt) : 0;
    if (tb !== ta) return tb - ta;
    return (a.name || '').localeCompare(b.name || '');
  };
  const runtimeContainer = document.getElementById('skillsGalleryRuntime');
  const featuredContainer = document.getElementById('skillsGalleryFeatured');
  if (runtimeContainer) {
    const filtered = skillsState.runtime.filter(matches).slice().sort(sortFn);
    if (filtered.length === 0) {
      // First-run CTA: no skills installed AND no active filter. Otherwise just
      // tell the user nothing matched their filter so they don't think the
      // install action is broken.
      const noFilters = !search && !domain;
      const noSkillsAtAll = skillsState.runtime.length === 0;
      if (noSkillsAtAll && noFilters) {
        const repoCount = skillsState.repo.length;
        const installCta = repoCount > 0
          ? '<button class="btn-sm primary" onclick="runSkillAutomation()">+ Install ' + repoCount + ' starter skill(s)</button> '
          : '';
        runtimeContainer.innerHTML = '<div class="empty-panel-copy">'
          + '<strong>No runtime skills yet.</strong><br><br>'
          + installCta
          + '<button class="btn-sm" onclick="document.getElementById(\'skillAutomationPanel\')?.scrollIntoView({behavior:\'smooth\'});">Create one manually</button>'
          + '<br><br>Or ask the agent: <em>"create a skill for..."</em>.'
          + '</div>';
      } else {
        runtimeContainer.innerHTML = '<div class="empty-panel-copy">No runtime skills match.</div>';
      }
    } else {
      runtimeContainer.innerHTML = '<div class="skills-gallery">' + filtered.map((s) => renderRuntimeSkillCard(s, skillsState.usageMap.get(s.name))).join('') + '</div>';
    }
  }
  if (featuredContainer) {
    // Only show featured (repo) skills that are not yet installed in runtime — keeps the
    // "Yours" gallery as the source of truth for live skills.
    const featured = skillsState.repo.filter(matches).filter((s) => !skillsState.repoInstalled.has(s.name)).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (featured.length === 0) {
      featuredContainer.innerHTML = '';
    } else {
      featuredContainer.innerHTML = '<div class="skills-section-divider"><span>Featured (repo)</span><span class="skills-gallery-count">' + featured.length + ' available</span></div>'
        + '<div class="skills-gallery">' + featured.map(renderRepoSkillCard).join('') + '</div>';
    }
  }
}

function renderRepoSkillCard(s) {
  const id = s.id || s.name;
  return '<div class="skill-card featured" data-repo-skill="' + escAttr(id) + '">'
    + '<input type="checkbox" class="skill-card-select" title="Select for bulk install" onchange="onFeaturedSkillSelect(this, \'' + escAttr(id) + '\', \'' + escAttr(s.name) + '\')" onclick="event.stopPropagation()">'
    + '<div class="skill-card-top">'
    +   '<div>'
    +     '<div class="skill-card-name">' + esc(s.name) + '</div>'
    +     '<span class="skill-card-cmd">read-only</span>'
    +   '</div>'
    +   '<button class="skill-card-install" onclick="installRepoSkill(\'' + escAttr(id) + '\', \'' + escAttr(s.name) + '\')">+ Install</button>'
    + '</div>'
    + '<div class="skill-card-desc">' + esc(s.description || '(no description)') + '</div>'
    + '<div class="skill-card-meta"><span class="capability-pill">' + esc(s.domain || 'repo') + '</span></div>'
    + '</div>';
}

const featuredBulkSelection = new Map();

function onFeaturedSkillSelect(checkbox, id, name) {
  if (checkbox.checked) featuredBulkSelection.set(id, name);
  else featuredBulkSelection.delete(id);
  renderFeaturedBulkToolbar();
}

function renderFeaturedBulkToolbar() {
  let toolbar = document.getElementById('featuredBulkToolbar');
  const featuredContainer = document.getElementById('skillsGalleryFeatured');
  if (!featuredContainer) return;
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'featuredBulkToolbar';
    toolbar.className = 'skills-bulk-toolbar';
    featuredContainer.prepend(toolbar);
  }
  if (featuredBulkSelection.size === 0) {
    toolbar.classList.add('hidden-by-default');
    toolbar.innerHTML = '';
    return;
  }
  toolbar.classList.remove('hidden-by-default');
  toolbar.innerHTML = '<strong>' + featuredBulkSelection.size + '</strong> featured selected · '
    + '<button class="btn-sm primary" onclick="installSelectedFeatured()">+ Install all</button> '
    + '<button class="btn-sm" onclick="clearFeaturedBulkSelection()">Clear</button>';
}

function clearFeaturedBulkSelection() {
  featuredBulkSelection.clear();
  document.querySelectorAll('[data-repo-skill] .skill-card-select').forEach((cb) => { cb.checked = false; });
  renderFeaturedBulkToolbar();
}

async function installSelectedFeatured() {
  const entries = Array.from(featuredBulkSelection.entries());
  if (entries.length === 0) return;
  if (!await confirmToast('Install ' + entries.length + ' featured skill(s) into runtime?')) return;
  await Promise.all(entries.map(([id]) => fetch('/api/skills/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: id }),
  }).catch(() => {})));
  clearFeaturedBulkSelection();
  await loadSkills();
}

function renderSkillAutomationPanel(runtime, repo) {
  const runtimeSkipped = (runtime.diagnostics || []).length;
  const repoAvailable = (repo.skills || []).length;
  return '<div id="skillAutomationPanel" class="trace-item trace-item-spaced">'
    + '<div class="trace-title">Skill automation</div>'
    + '<div class="trace-meta">Checks ' + repoAvailable + ' repo skill(s) and ' + runtimeSkipped + ' runtime diagnostic(s). Missing repo skills are installed; missing runtime SKILL.md files get starter scaffolds.</div>'
    + '<button class="btn-sm full-width-button" onclick="runSkillAutomation()">Auto repair and install skills</button>'
    + '<details class="details-mt6"><summary class="trace-meta clickable-summary">Add a runtime skill</summary>'
    + '<div class="trace-block-spaced"><input id="newSkillName" class="compact-panel-input full-compact-input" placeholder="skill id, e.g. headless-browser-research"></div>'
    + '<input id="newSkillDescription" class="compact-panel-input full-compact-input" placeholder="one-line description">'
    + '<input id="newSkillTriggers" class="compact-panel-input full-compact-input" placeholder="triggers, comma separated">'
    + '<textarea id="newSkillContent" class="compact-panel-input full-compact-input" rows="5" placeholder="instructions, steps, controls, validation checks"></textarea>'
    + '<div class="inline-actions top-spaced"><button class="btn-sm primary" onclick="createSkillFromForm()">Create skill</button><button class="btn-sm" onclick="askAgentToCreateSkill()">Ask agent to generate</button></div>'
    + '</details>'
    + '<div id="skillAutomationResult" class="trace-meta"></div>'
    + '</div>';
}

function renderRuntimeSkillItem(s, usage) {
  // Legacy compact list renderer kept so any external callers keep working.
  // The Skills panel now uses renderRuntimeSkillCard().
  const u = usage || {};
  const id = s.id || s.name;
  const pinned = u.pinned ? ' 📌' : '';
  const archived = u.archived ? ' <span class="capability-pill muted-pill">archived</span>' : '';
  const useInfo = (u.useCount || u.viewCount) ? ' · used ' + (u.useCount || 0) + ' / viewed ' + (u.viewCount || 0) : '';
  const lastUsed = u.lastUsedAt ? ' · last ' + new Date(u.lastUsedAt).toLocaleDateString() : '';
  const pinBtn = '<button class="sk-install" onclick="event.stopPropagation();togglePinSkill(\'' + escAttr(s.name) + '\', ' + (!u.pinned) + ')" title="' + (u.pinned ? 'Unpin' : 'Pin (curator will not archive)') + '">' + (u.pinned ? 'Unpin' : 'Pin') + '</button>';
  return '<div class="skill-item" onclick="useSkillFromList(\'' + escAttr(s.name) + '\')"><div class="sk-name">' + esc(s.name) + pinned + '</div><div class="sk-desc">' + esc(s.description) + '</div><div class="sk-meta"><span>' + esc(s.domain) + useInfo + lastUsed + archived + '</span><span>' + pinBtn + ' <button class="sk-del" onclick="event.stopPropagation();deleteSkill(\'' + escAttr(id) + '\')">🗑</button></span></div></div>';
}

function renderRuntimeSkillCard(s, usage) {
  const u = usage || {};
  const id = s.id || s.name;
  const enabled = s.enabled !== false;
  const cardClass = 'skill-card' + (enabled ? '' : ' disabled');
  const slashCmd = '/' + s.name;
  const pinIcon = u.pinned ? ' 📌' : '';
  const archivedPill = u.archived ? '<span class="capability-pill muted-pill">archived</span>' : '';
  const useInfo = (u.useCount || u.viewCount) ? '· used ' + (u.useCount || 0) + ' / viewed ' + (u.viewCount || 0) : '';
  const lastUsed = u.lastUsedAt ? '· last ' + new Date(u.lastUsedAt).toLocaleDateString() : '';
  const togglePinLabel = u.pinned ? 'Unpin' : 'Pin';
  const togglePinTitle = u.pinned ? 'Unpin (curator may archive)' : 'Pin (curator will not archive)';
  return '<div class="' + cardClass + '" data-skill-name="' + escAttr(s.name) + '">'
    + '<input type="checkbox" class="skill-card-select" title="Select for bulk action" onchange="onSkillCardSelect(this, \'' + escAttr(s.name) + '\')" onclick="event.stopPropagation()">'
    + '<div class="skill-card-top">'
    +   '<div>'
    +     '<div class="skill-card-name" onclick="openSkillModal(\'' + escAttr(s.name) + '\')" title="View / edit SKILL.md">' + esc(s.name) + pinIcon + '</div>'
    +     '<span class="skill-card-cmd" onclick="useSkillFromList(\'' + escAttr(s.name) + '\')" title="Run this skill">' + esc(slashCmd) + '</span>'
    +   '</div>'
    +   '<label class="skill-toggle" title="' + (enabled ? 'Disable' : 'Enable') + ' this skill">'
    +     '<input type="checkbox"' + (enabled ? ' checked' : '') + ' onchange="toggleSkillEnabled(\'' + escAttr(id) + '\', this.checked)">'
    +     '<span class="skill-toggle-track"></span>'
    +     '<span class="skill-toggle-thumb"></span>'
    +   '</label>'
    + '</div>'
    + '<div class="skill-card-desc">' + esc(s.description || '(no description)') + '</div>'
    + '<div class="skill-card-meta">'
    +   '<span class="capability-pill">' + esc(s.domain || 'general') + '</span>'
    +   archivedPill
    +   '<span>' + esc(useInfo) + ' ' + esc(lastUsed) + '</span>'
    + '</div>'
    + '<div class="skill-card-actions">'
    +   '<div class="skill-card-actions-left">'
    +     '<button class="btn-sm" onclick="useSkillFromList(\'' + escAttr(s.name) + '\')">Use</button>'
    +     '<button class="btn-sm" onclick="togglePinSkill(\'' + escAttr(s.name) + '\', ' + (!u.pinned) + ')" title="' + togglePinTitle + '">' + togglePinLabel + '</button>'
    +   '</div>'
    +   '<div class="skill-card-actions-right">'
    +     '<button class="sk-del" title="Delete" onclick="deleteSkill(\'' + escAttr(id) + '\')">🗑</button>'
    +   '</div>'
    + '</div>'
    + '</div>';
}

async function toggleSkillEnabled(name, enabled) {
  try {
    const response = await fetch('/api/skills/' + encodeURIComponent(name) + '/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await response.json();
    if (data.error) { showToast('Toggle failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { showToast('Toggle failed: ' + (error.message || error)); }
}

// --- Skill detail modal ---
let activeSkillModalName = '';
let activeSkillModalTab = 'form';
let activeSkillModalParsed = null;
let activeSkillModalRaw = '';

async function openSkillModal(name) {
  activeSkillModalName = name;
  activeSkillModalTab = 'form';
  const modal = document.getElementById('skillModal');
  const title = document.getElementById('skillModalTitle');
  const pathEl = document.getElementById('skillModalPath');
  const status = document.getElementById('skillModalStatus');
  if (!modal) return;
  title.textContent = 'Edit skill · ' + name;
  pathEl.textContent = '';
  status.textContent = 'Loading…';
  modal.classList.remove('hidden-by-default');
  switchSkillModalTab('form');
  try {
    const [rawR, parsedR] = await Promise.all([
      fetch('/api/skills/' + encodeURIComponent(name) + '?raw=1').then((r) => r.json()),
      fetch('/api/skills/' + encodeURIComponent(name)).then((r) => r.json()),
    ]);
    if (rawR.error) { status.textContent = 'Failed: ' + rawR.error; return; }
    activeSkillModalRaw = rawR.content || '';
    activeSkillModalParsed = parsedR.error ? null : parsedR;
    pathEl.textContent = rawR.filePath || '';
    populateSkillModalForm(activeSkillModalParsed, activeSkillModalRaw);
    document.getElementById('skillModalContent').value = activeSkillModalRaw;
    status.textContent = '';
  } catch (error) {
    status.textContent = 'Failed to load: ' + (error.message || error);
  }
}

function populateSkillModalForm(parsed, raw) {
  const desc = document.getElementById('skillFormDescription');
  const dom = document.getElementById('skillFormDomain');
  const risk = document.getElementById('skillFormRiskLevel');
  const triggers = document.getElementById('skillFormTriggers');
  const whenTo = document.getElementById('skillFormWhenToUse');
  const body = document.getElementById('skillFormBody');
  const p = parsed || {};
  if (desc) desc.value = p.description || '';
  if (dom) dom.value = p.domain || '';
  if (risk) risk.value = p.riskLevel || '';
  if (triggers) triggers.value = (p.triggers || []).join(', ');
  if (whenTo) whenTo.value = p.whenToUse || '';
  if (body) body.value = stripFrontmatter(raw);
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

function switchSkillModalTab(tab) {
  activeSkillModalTab = tab;
  const form = document.getElementById('skillModalForm');
  const raw = document.getElementById('skillModalContent');
  const hist = document.getElementById('skillModalHistoryView');
  const tabForm = document.getElementById('skillModalTabForm');
  const tabRaw = document.getElementById('skillModalTabRaw');
  const tabHist = document.getElementById('skillModalTabHistory');
  [form, raw, hist].forEach((el) => el && el.classList.add('hidden-by-default'));
  [tabForm, tabRaw, tabHist].forEach((el) => el && el.classList.remove('active'));
  if (tab === 'form') { form?.classList.remove('hidden-by-default'); tabForm?.classList.add('active'); }
  else if (tab === 'raw') { raw?.classList.remove('hidden-by-default'); tabRaw?.classList.add('active'); raw.value = activeSkillModalRaw; }
  else if (tab === 'history') { hist?.classList.remove('hidden-by-default'); tabHist?.classList.add('active'); loadSkillModalHistory(); }
}

async function loadSkillModalHistory() {
  const view = document.getElementById('skillModalHistoryView');
  if (!view || !activeSkillModalName) return;
  view.innerHTML = '<div class="skill-modal-history-row">Loading…</div>';
  try {
    const data = await fetch('/api/skills/' + encodeURIComponent(activeSkillModalName) + '/history').then((r) => r.json());
    const versions = data.versions || [];
    if (versions.length === 0) { view.innerHTML = '<div class="skill-modal-history-row">No previous versions yet. Saves will be snapshotted automatically.</div>'; return; }
    view.innerHTML = versions.map((v, i) => '<div class="skill-modal-history-row">'
      + '<code>' + esc(v.timestamp) + '</code>'
      + '<span>'
      +   '<button class="btn-sm" onclick="viewSkillDiff(\'' + escAttr(v.timestamp) + '\', ' + i + ')">Diff</button> '
      +   '<button class="btn-sm" onclick="revertSkillToHistory(\'' + escAttr(v.timestamp) + '\')">Revert</button>'
      + '</span>'
      + '</div><div id="skillDiffView' + i + '" class="skill-diff-view hidden-by-default"></div>').join('');
  } catch (error) {
    view.innerHTML = '<div class="skill-modal-history-row">Failed: ' + esc(error.message || error) + '</div>';
  }
}

// Render a tiny line-by-line diff between an old snapshot and the current saved
// content. Not LCS-quality — just naive equal-line removal so reviewers can
// spot what changed without leaving the modal.
async function viewSkillDiff(ts, index) {
  const target = document.getElementById('skillDiffView' + index);
  if (!target) return;
  if (!target.classList.contains('hidden-by-default')) {
    target.classList.add('hidden-by-default');
    return;
  }
  target.classList.remove('hidden-by-default');
  target.innerHTML = 'Loading diff…';
  try {
    const snap = await fetch(`/api/skills/${encodeURIComponent(activeSkillModalName)}/history/${encodeURIComponent(ts)}`).then((r) => r.json());
    if (snap.error) { target.textContent = 'Failed: ' + snap.error; return; }
    target.innerHTML = renderSkillDiff(String(snap.content || ''), String(activeSkillModalRaw || ''))
      + '<div class="skill-modal-actions" style="margin-top:6px"><button class="btn-sm primary" onclick="revertSkillToHistory(\'' + escAttr(ts) + '\')">Looks good — revert to this version</button></div>';
  } catch (error) {
    target.textContent = 'Failed: ' + (error.message || error);
  }
}

function renderSkillDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const out = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const a = oldLines[i];
    const b = newLines[j];
    if (i < oldLines.length && j < newLines.length && a === b) {
      out.push('<div class="diff-ctx">  ' + esc(a) + '</div>');
      i++; j++;
    } else if (j < newLines.length && !oldSet.has(b)) {
      out.push('<div class="diff-add">+ ' + esc(b) + '</div>');
      j++;
    } else if (i < oldLines.length && !newSet.has(a)) {
      out.push('<div class="diff-del">- ' + esc(a) + '</div>');
      i++;
    } else {
      // Lines exist on both sides but order differs — emit as remove+add to keep it readable.
      if (i < oldLines.length) { out.push('<div class="diff-del">- ' + esc(a) + '</div>'); i++; }
      if (j < newLines.length) { out.push('<div class="diff-add">+ ' + esc(b) + '</div>'); j++; }
    }
  }
  return out.length === 0 ? '<div class="diff-ctx">(no changes)</div>' : out.join('');
}

async function revertSkillToHistory(ts) {
  if (!activeSkillModalName) return;
  if (!await confirmToast('Revert this skill to the version from ' + ts + '? The current content will be snapshotted before the revert.')) return;
  const status = document.getElementById('skillModalStatus');
  if (status) status.textContent = 'Reverting…';
  try {
    const snap = await fetch(`/api/skills/${encodeURIComponent(activeSkillModalName)}/history/${encodeURIComponent(ts)}`).then((r) => r.json());
    if (snap.error) { if (status) status.textContent = 'Failed: ' + snap.error; return; }
    const response = await fetch('/api/skills/' + encodeURIComponent(activeSkillModalName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: snap.content }),
    });
    const data = await response.json();
    if (data.error) { if (status) status.textContent = 'Failed: ' + data.error; return; }
    if (status) status.textContent = 'Reverted.';
    closeSkillModal();
    await loadSkills();
  } catch (error) {
    if (status) status.textContent = 'Failed: ' + (error.message || error);
  }
}

function closeSkillModal() {
  const modal = document.getElementById('skillModal');
  if (modal) modal.classList.add('hidden-by-default');
  activeSkillModalName = '';
  activeSkillModalParsed = null;
  activeSkillModalRaw = '';
}

// --- /help slash-commands modal ---
let helpModalIndex = 0;
let helpModalCommands = [];

function openHelpModal() {
  const modal = document.getElementById('helpModal');
  const list = document.getElementById('helpModalList');
  if (!modal || !list) return;
  helpModalCommands = getAllSlashCommands();
  helpModalIndex = 0;
  renderHelpModalList();
  modal.classList.remove('hidden-by-default');
  // Tiny global key handler bound while the modal is open.
  document.addEventListener('keydown', helpModalKeyHandler);
}

function renderHelpModalList() {
  const list = document.getElementById('helpModalList');
  if (!list) return;
  list.innerHTML = helpModalCommands.map((c, i) => '<div class="help-modal-row' + (i === helpModalIndex ? ' active' : '') + '" onclick="useSlashCommandFromHelp(\'' + escAttr(c.cmd) + '\')" data-help-index="' + i + '">'
    + '<code>' + esc(c.cmd) + '</code>'
    + '<span>' + esc(c.desc || '') + '</span>'
    + '</div>').join('');
  // Keep the active row in view when navigating with the keyboard.
  const active = list.querySelector('.help-modal-row.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function helpModalKeyHandler(e) {
  const modal = document.getElementById('helpModal');
  if (!modal || modal.classList.contains('hidden-by-default')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); helpModalIndex = Math.min(helpModalIndex + 1, helpModalCommands.length - 1); renderHelpModalList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); helpModalIndex = Math.max(helpModalIndex - 1, 0); renderHelpModalList(); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = helpModalCommands[helpModalIndex]; if (c) useSlashCommandFromHelp(c.cmd); }
  else if (e.key === 'Escape') { e.preventDefault(); closeHelpModal(); }
}

function closeHelpModal() {
  const modal = document.getElementById('helpModal');
  if (modal) modal.classList.add('hidden-by-default');
  document.removeEventListener('keydown', helpModalKeyHandler);
}

function useSlashCommandFromHelp(cmd) {
  closeHelpModal();
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = cmd + ' ';
  input.focus();
  try { autoSize(input); maybeShowSlashPalette(input.value); } catch(e){}
}

async function saveSkillModal() {
  const status = document.getElementById('skillModalStatus');
  if (!activeSkillModalName) return;
  let body;
  if (activeSkillModalTab === 'raw') {
    const ta = document.getElementById('skillModalContent');
    const content = ta?.value || '';
    if (!/^---\n[\s\S]*?\n---/.test(content.trim())) {
      status.textContent = 'Content must start with YAML frontmatter (--- ... ---).';
      return;
    }
    body = JSON.stringify({ content });
  } else {
    const description = (document.getElementById('skillFormDescription')?.value || '').trim();
    const domain = (document.getElementById('skillFormDomain')?.value || '').trim();
    const triggersRaw = (document.getElementById('skillFormTriggers')?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    const whenToUse = (document.getElementById('skillFormWhenToUse')?.value || '').trim();
    const riskLevel = document.getElementById('skillFormRiskLevel')?.value || '';
    const bodyText = (document.getElementById('skillFormBody')?.value || '').trim();
    // Validation: keep messages specific so users know exactly what to fix.
    if (description.length < 5 || /^describe what this skill does/i.test(description)) {
      status.textContent = 'Description must be at least 5 characters and not the placeholder.';
      return;
    }
    if (bodyText.length < 20) {
      status.textContent = 'Body must be at least 20 characters.';
      return;
    }
    const lower = triggersRaw.map((t) => t.toLowerCase());
    const dupe = lower.find((t, i) => lower.indexOf(t) !== i);
    if (dupe) { status.textContent = 'Triggers contain a duplicate: ' + dupe; return; }
    body = JSON.stringify({ fields: { description, domain, triggers: triggersRaw, whenToUse, riskLevel, body: bodyText } });
  }
  status.textContent = 'Saving…';
  try {
    const response = await fetch('/api/skills/' + encodeURIComponent(activeSkillModalName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    if (data.error) { status.textContent = 'Save failed: ' + data.error; return; }
    status.textContent = 'Saved.';
    closeSkillModal();
    await loadSkills();
  } catch (error) {
    status.textContent = 'Save failed: ' + (error.message || error);
  }
}

async function togglePinSkill(name, pinned) {
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(name) + '/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
    const data = await r.json();
    if (data.error) { showToast('Pin failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { showToast('Pin failed: ' + (error.message || error)); }
}

function renderCuratorPanel(curator) {
  if (!curator) return '';
  const settings = curator.settings || {};
  const enabled = settings.enabled;
  const stateBadge = enabled
    ? '<span class="rag-backend-badge success-badge">curator: on</span>'
    : '<span class="rag-backend-badge">curator: off</span>';
  const lastRun = settings.lastRunAt ? new Date(settings.lastRunAt).toLocaleString() : 'never';
  const lastActivity = curator.lastUserActivityAt ? new Date(curator.lastUserActivityAt).toLocaleString() : '?';
  const runningBadge = curator.schedulerRunning ? ' <span class="capability-pill running-pill">scheduler running</span>' : '';
  const recentLog = (curator.log || []).slice(-5).reverse().map((entry) => '<div class="trace-meta trace-meta-xxs">' + esc(JSON.stringify(entry)) + '</div>').join('');
  const proposalsBlock = curator.proposals
    ? '<div id="curatorProposalsContainer" class="trace-block-spaced"><div class="trace-meta">LLM merge proposals available — loading…</div></div>'
    : '';
  const archived = Array.isArray(curator.archived) ? curator.archived : [];
  const archivedBlock = archived.length === 0 ? '' : '<details class="details-mt6"><summary class="trace-meta clickable-summary">📦 Archived skills (' + archived.length + ')</summary><div class="details-body-mt4">'
    + archived.map((name) => '<div class="trace-row inline-row"><span class="flex-fill">' + esc(name) + '</span><button class="btn-sm" onclick="restoreArchivedSkill(\'' + escAttr(name) + '\')">Restore</button></div>').join('')
    + '</div></details>';
  return '<div id="curatorPanel" class="trace-item trace-item-spaced">'
    + '<div class="trace-title">🧹 Skill Curator ' + stateBadge + runningBadge + '</div>'
    + '<div class="trace-meta">Maintenance every ' + (settings.intervalHours || 168) + 'h after ' + (settings.idleThresholdMinutes || 120) + ' min idle. Last run: ' + esc(lastRun) + '. Last activity: ' + esc(lastActivity) + '.</div>'
    + '<div class="trace-meta">Stale threshold: ' + (settings.staleDays || 60) + ' days · max archive/run: ' + (settings.maxArchivePerRun || 5) + ' · LLM phase: ' + (settings.enableLlmPhase ? 'on' : 'off') + '</div>'
    + '<div class="inline-actions trace-block-spaced">'
    +   '<button class="btn-sm" onclick="curatorPreview()">Preview</button> '
    +   '<button class="btn-sm" onclick="curatorRunNow()">Run now</button> '
    +   '<button class="btn-sm" onclick="curatorToggle(' + (!enabled) + ')">' + (enabled ? 'Disable' : 'Enable') + ' scheduler</button>'
    + '</div>'
    + '<div id="curatorPreviewOutput" class="trace-block-spaced"></div>'
    + archivedBlock
    + (recentLog ? '<details class="details-mt6"><summary class="trace-meta clickable-summary">Recent log</summary>' + recentLog + '</details>' : '')
    + proposalsBlock
    + '</div>';
}

async function restoreArchivedSkill(name) {
  if (!await confirmToast('Restore archived skill "' + name + '" back to the runtime library?')) return;
  try {
    const response = await fetch('/api/curator/restore/' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (data.error) { showToast('Restore failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { showToast('Restore failed: ' + (error.message || error)); }
}

async function curatorPreview() {
  const out = document.getElementById('curatorPreviewOutput');
  if (out) out.textContent = 'Previewing…';
  try {
    const r = await fetch('/api/curator/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (data.error) { if (out) out.textContent = 'Preview failed: ' + data.error; return; }
    if (out) out.innerHTML = renderCuratorSummary(data.summary);
  } catch (error) { if (out) out.textContent = 'Preview failed: ' + (error.message || error); }
}

async function curatorRunNow() {
  if (!await confirmToast('Run the curator now? This may archive stale, unpinned skills.')) return;
  const out = document.getElementById('curatorPreviewOutput');
  if (out) out.textContent = 'Running curator…';
  try {
    const r = await fetch('/api/curator/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (data.error) { if (out) out.textContent = 'Run failed: ' + data.error; return; }
    if (out) out.innerHTML = renderCuratorSummary(data.summary);
    setTimeout(loadSkills, 600);
  } catch (error) { if (out) out.textContent = 'Run failed: ' + (error.message || error); }
}

async function curatorToggle(enable) {
  try {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ curator: { enabled: enable } }) });
    await loadSkills();
  } catch (error) { showToast('Toggle failed: ' + (error.message || error)); }
}

function renderCuratorSummary(summary) {
  if (!summary) return '<div class="trace-meta">(no summary)</div>';
  const candidates = (summary.staleCandidates || []).map((a) => '<div class="trace-meta trace-meta-sm">' + esc(a.kind) + ' · ' + esc(a.skill) + ' · ' + esc(a.reason) + '</div>').join('');
  const archived = (summary.archived || []).map((a) => '<div class="trace-meta trace-meta-sm trace-meta-warning">' + esc(a.kind) + ' · ' + esc(a.skill) + ' · ' + esc(a.reason) + '</div>').join('');
  const dryBadge = summary.dryRun ? ' <span class="capability-pill">dry-run</span>' : '';
  const llmNote = summary.llmSkipped ? '<div class="trace-meta">LLM phase skipped: ' + esc(summary.llmSkipped) + '</div>' : '';
  return '<div class="trace-item surface-trace-item"><div class="trace-title">Curator summary' + dryBadge + '</div>'
    + '<div class="trace-meta">' + (summary.staleCandidates?.length || 0) + ' candidate(s), ' + (summary.archived?.length || 0) + ' archived</div>'
    + (archived ? '<div class="details-body-mt4">' + archived + '</div>' : '')
    + (candidates ? '<details class="details-mt4"><summary class="trace-meta clickable-summary">All candidates</summary>' + candidates + '</details>' : '')
    + llmNote
    + '</div>';
}

async function loadCuratorProposals() {
  const container = document.getElementById('curatorProposalsContainer');
  if (!container) return;
  try {
    const data = await fetch('/api/curator/proposals').then((r) => r.json());
    const proposals = data.proposals || [];
    if (proposals.length === 0) {
      container.innerHTML = '<div class="trace-meta">LLM proposals file present but no parseable clusters. <button class="btn-sm" onclick="dismissCuratorProposals()">Clear</button></div>';
      return;
    }
    const rows = proposals.map((p, i) => {
      const skillList = p.mergeSkills.map(esc).join(', ');
      const rationale = p.rationale ? '<div class="trace-meta">' + esc(p.rationale) + '</div>' : '';
      return '<div class="trace-item">'
        + '<div class="trace-title">Cluster: ' + esc(p.heading) + '</div>'
        + '<div class="trace-meta">Merge: ' + skillList + '</div>'
        + (p.proposedDescription ? '<div class="trace-meta">' + esc(p.proposedDescription) + '</div>' : '')
        + rationale
        + '<div class="inline-actions trace-block-spaced">'
        +   '<button class="btn-sm" onclick="applyCuratorProposal(' + i + ', true)">Preview</button> '
        +   '<button class="btn-sm primary" onclick="applyCuratorProposal(' + i + ', false)">Apply merge</button>'
        + '</div>'
        + '<div class="trace-meta" id="curatorProposalResult' + i + '"></div>'
        + '</div>';
    }).join('');
    container.innerHTML = '<div class="trace-title trace-title-padded">🧪 LLM Merge Proposals (' + proposals.length + ')</div>'
      + '<div class="trace-list">' + rows + '</div>'
      + '<div class="inline-actions top-spaced"><button class="btn-sm" onclick="dismissCuratorProposals()">Dismiss all</button></div>';
    window._curatorProposals = proposals;
  } catch (error) {
    container.innerHTML = '<div class="trace-meta">Failed to load proposals: ' + esc(error.message || error) + '</div>';
  }
}

async function applyCuratorProposal(index, dryRun) {
  const proposal = (window._curatorProposals || [])[index];
  if (!proposal) return;
  const result = document.getElementById('curatorProposalResult' + index);
  if (!dryRun && !await confirmToast('Apply merge "' + proposal.heading + '"? This writes a new umbrella skill and archives ' + proposal.mergeSkills.length + ' source skill(s).')) return;
  if (result) result.textContent = dryRun ? 'Previewing…' : 'Applying…';
  try {
    const response = await fetch('/api/curator/proposals/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal, dryRun }),
    });
    const data = await response.json();
    if (data.error) { if (result) result.textContent = 'Failed: ' + data.error; return; }
    const r = data.result;
    if (result) {
      result.textContent = (dryRun ? '[preview] ' : '') + 'umbrella=' + r.umbrellaName + ' · archived=' + r.archived.length + (r.skipped.length ? ' · skipped (pinned)=' + r.skipped.join(', ') : '');
    }
    if (!dryRun) setTimeout(loadSkills, 600);
  } catch (error) {
    if (result) result.textContent = 'Failed: ' + (error.message || error);
  }
}

async function dismissCuratorProposals() {
  if (!await confirmToast('Clear all current LLM merge proposals?')) return;
  try {
    await fetch('/api/curator/proposals', { method: 'DELETE' });
    await loadSkills();
  } catch (error) { showToast('Dismiss failed: ' + (error.message || error)); }
}
function renderRepoSkillItem(s) { const id = s.id || s.name; return '<div class="skill-item"><div class="sk-name">' + esc(s.name) + '</div><div class="sk-desc">' + esc(s.description) + '</div><div class="sk-meta"><span>' + esc(s.domain || 'repo') + '</span><span>read-only</span><button class="sk-install" onclick="installRepoSkill(\'' + escAttr(id) + '\', \'' + escAttr(s.name) + '\')">Install to runtime</button></div></div>'; }
function renderSkillDiagnostics(diagnostics) { if (!diagnostics || diagnostics.length === 0) return '<div id="skillDiagnostics" class="trace-list"><div class="trace-title">Skill Diagnostics</div><div class="trace-meta">No skipped runtime skill folders.</div></div>'; return '<div id="skillDiagnostics" class="trace-list"><div class="trace-title">Skill Diagnostics</div>' + diagnostics.map((item) => '<div class="trace-item"><div class="trace-title">' + esc(item.name) + '</div><div class="trace-meta">' + esc(item.reason) + ' · ' + esc(item.message) + '</div><div class="trace-meta">' + esc(item.filePath) + '</div>' + renderSkillDiagnosticActions(item) + '</div>').join('') + '</div>'; }
function renderSkillDiagnosticActions(item) { const actions = ['<button class="btn-sm" onclick="copySkillDiagnosticPath(\'' + escAttr(item.filePath) + '\')">Copy path</button>']; if (item.reason === 'missing-skill-file') actions.push('<button class="btn-sm" onclick="scaffoldSkill(\'' + escAttr(item.name) + '\')">Create starter SKILL.md</button>'); return '<div class="skill-diagnostic-actions">' + actions.join(' ') + '</div>'; }
function useSkillFromList(name) { document.getElementById('chatInput').value = 'Use the skill: ' + name; sendMessage(); }
async function deleteSkill(name) { if (!await confirmToast('Delete skill "' + name + '"?')) return; await fetch('/api/skills/' + name, { method: 'DELETE' }); loadSkills(); }
async function installRepoSkill(id, displayName) {
  const label = displayName || id;
  if (!await confirmToast('Install repo skill "' + label + '" into runtime .harness/skills?')) return;
  try {
    let response = await fetch('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: id }) });
    if (response.status === 409) {
      if (!await confirmToast('Runtime skill "' + label + '" already exists. Overwrite it?')) return;
      response = await fetch('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: id, overwrite: true }) });
    }
    const data = await response.json();
    if (data.error) { showToast('Install failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { showToast('Install failed: ' + (error.message || error)); }
}
async function runSkillAutomation() {
  if (!await confirmToast('Run skill automation now? It installs missing repo skills and scaffolds runtime folders missing SKILL.md. Existing skills are skipped.')) return;
  const out = document.getElementById('skillAutomationResult');
  if (out) out.textContent = 'Running skill automation...';
  try {
    const response = await fetch('/api/skills/automation/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (data.error) { if (out) out.textContent = 'Automation failed: ' + data.error; return; }
    const installed = (data.installed || []).length;
    const scaffolded = (data.scaffolded || []).length;
    const skipped = (data.skipped || []).length;
    if (out) out.textContent = 'Installed ' + installed + ', scaffolded ' + scaffolded + ', skipped ' + skipped + '.';
    await loadSkills();
  } catch (error) { if (out) out.textContent = 'Automation failed: ' + (error.message || error); }
}
async function scaffoldSkill(name) {
  if (!await confirmToast('Create a starter SKILL.md for "' + name + '"?')) return;
  try {
    const response = await fetch('/api/skills/scaffold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (data.error) { showToast('Scaffold failed: ' + data.error); return; }
    await loadSkills();
  } catch (error) { showToast('Scaffold failed: ' + (error.message || error)); }
}
async function createSkillFromForm() {
  const out = document.getElementById('skillAutomationResult');
  const nameEl = document.getElementById('newSkillName');
  const rawName = nameEl?.value.trim() || '';
  const description = document.getElementById('newSkillDescription')?.value.trim() || 'Describe what this skill does.';
  const triggers = document.getElementById('newSkillTriggers')?.value || '';
  const content = document.getElementById('newSkillContent')?.value.trim() || '';
  if (!rawName) { if (out) out.textContent = 'Enter a skill id first.'; return; }
  // Server requires SAFE_ID_PATTERN /^[a-zA-Z0-9._-]+$/. If the user typed
  // spaces or other characters, auto-slug instead of bouncing them with
  // an opaque "Invalid skill name." error.
  let name = rawName;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    name = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) { if (out) out.textContent = 'Could not derive a valid id from that name. Use letters, digits, dot, dash, or underscore.'; return; }
    if (nameEl) nameEl.value = name;
  }
  try {
    let response = await fetch('/api/skills/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, triggers, content }),
    });
    if (response.status === 409) {
      if (!await confirmToast('Runtime skill "' + name + '" already exists. Overwrite it?')) return;
      response = await fetch('/api/skills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, triggers, content, overwrite: true }),
      });
    }
    const data = await response.json();
    if (data.error) { if (out) out.textContent = 'Create failed: ' + data.error; return; }
    if (out) out.textContent = 'Created ' + name + ' at ' + (data.filePath || '.harness/skills/' + name + '/SKILL.md') + '.';
    await loadSkills();
  } catch (error) { if (out) out.textContent = 'Create failed: ' + (error.message || error); }
}
function askAgentToCreateSkill() {
  const name = document.getElementById('newSkillName')?.value.trim() || 'new-runtime-skill';
  const description = document.getElementById('newSkillDescription')?.value.trim() || 'the reusable capability I need';
  const triggers = document.getElementById('newSkillTriggers')?.value.trim();
  const details = document.getElementById('newSkillContent')?.value.trim();
  const prompt = 'Create a Harness runtime skill named "' + name + '" for: ' + description
    + (triggers ? '\nTriggers: ' + triggers : '')
    + (details ? '\nDetails/control requirements:\n' + details : '')
    + '\nWrite it into .harness/skills/' + name + '/SKILL.md and keep it focused.';
  const input = document.getElementById('chatInput');
  if (input) { input.value = prompt; input.focus(); autoSize(input); }
}
function copySkillDiagnosticPath(filePath) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(filePath).catch(() => {});
}

async function loadMemory() {
  try {
    const r = await fetch('/api/memory');
    const d = await r.json();
    const view = document.getElementById('memoryView');
    if (!d.decisions && !d.patterns && !d.notes) {
      view.innerHTML = '<div class="empty-panel-copy">No memories yet.<br><br>The agent saves decisions, patterns, and notes here as it learns.</div>';
      return;
    }
    // Each section gets a tiny "Edit via chat" link that prefills a chat
    // prompt asking the agent to open the file. Saves users from hunting
    // through .harness/memory/ themselves.
    const renderSection = (title, key, content) => '<div class="mem-section">'
      + '<h5>' + esc(title) + ' <button class="btn-sm mem-edit-btn" onclick="editMemoryViaChat(\'' + key + '\')">Edit via chat</button></h5>'
      + '<pre>' + esc(content) + '</pre></div>';
    let html = '';
    if (d.decisions) html += renderSection('Decisions', 'decisions', d.decisions);
    if (d.patterns) html += renderSection('Patterns', 'patterns', d.patterns);
    if (d.notes) html += renderSection('Notes', 'notes', d.notes);
    view.innerHTML = html;
  } catch(e){}
}

function editMemoryViaChat(key) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.value = 'Open .harness/memory/' + key + '.md and walk me through what to add or remove.';
  input.focus();
  try { autoSize(input); } catch(e){}
}

async function loadMemoryPalace() { try { const response = await fetch('/api/memory/palace'); const data = await response.json(); const view = document.getElementById('memoryPalaceView'); if (!data.rooms || !data.rooms.length) { view.innerHTML = '<div class="empty-panel-copy">No palace rooms yet.</div>'; return; } view.innerHTML = '<div class="palace-grid">' + data.rooms.map((room) => '<div class="palace-room"><div class="palace-title">' + esc(room.title) + '</div><div class="palace-meta">' + room.entryCount + ' memories · ' + room.sessions.length + ' sessions</div>' + room.anchors.map((anchor) => '<button class="palace-anchor" onclick="loadPalaceEntry(\'' + escAttr(anchor.id) + '\')"><strong>' + esc(anchor.kind) + '</strong> · ' + esc(anchor.text) + '</button>').join('') + '</div>').join('') + '</div><div id="palaceDetail" class="palace-detail initial-hidden"></div>'; } catch (error) { document.getElementById('memoryPalaceView').textContent = error.message; } }

async function loadDiscovery() { const view = document.getElementById('discoveryView'); if (!view) return; view.innerHTML = '<div class="trace-meta">Loading discovery...</div>'; try { const response = await fetch('/api/discovery'); const data = await response.json(); if (data.error) throw new Error(data.error); view.innerHTML = renderDiscoveryPanel(data); } catch (error) { view.innerHTML = '<div class="trace-meta">Discovery unavailable: ' + esc(error.message || error) + '</div>'; } }

function renderDiscoveryPanel(data) {
  return '<div id="discoveryPanel" class="trace-list">' + renderModelCatalogPanel(data.modelCatalog || {}) + renderExtensionDiscoveryPanel(data.extensions || {}) + renderOperatingServicesPanel(data.services || {}) + renderAutomationDiscoveryPanel(data.automations || {}) + renderSessionSearchDiscoveryPanel(data.sessionSearch || {}) + renderCuratorDiscoveryPanel(data.curator || {}) + '</div>';
}

function renderOperatingServicesPanel(servicesData) {
  const services = servicesData.services || [];
  const rows = services.slice(0, 8).map((service) => {
    const updated = service.updated_at ? new Date(service.updated_at).toLocaleString() : 'never';
    const job = service.automation_job_id ? ' · job ' + esc(service.automation_job_id) : '';
    return '<div class="trace-row"><strong>' + esc(service.service_name || service.service_id) + '</strong><div class="trace-meta">' + esc(service.mode || 'operate') + ' · updated ' + esc(updated) + job + '</div><div class="trace-meta">' + esc(service.purpose || '') + '</div><button class="btn-sm" onclick="loadOperatingServiceDetail(\'' + escAttr(service.service_id || '') + '\')">Details</button></div>';
  }).join('');
  const total = servicesData.total || services.length || 0;
  const hidden = total > services.length ? '<div class="trace-meta">Showing ' + services.length + ' of ' + total + ' service(s).</div>' : '';
  const lifecycle = servicesData.lifecycle?.model_agnostic ? '<div class="trace-meta">Lifecycle capture: model-agnostic · local service state · evidence-backed</div>' : '';
  return '<div id="operatingServicesDiscoveryPanel" class="trace-item"><div class="trace-title">Operating Services</div><div class="trace-meta">' + total + ' service(s) configured</div>' + lifecycle + '<div class="document-actions"><button class="btn-sm" onclick="exportOperatingServices()">Export JSON</button><button class="btn-sm" onclick="document.getElementById(\'operatingServiceImportFile\').click()">Import JSON</button><input type="file" id="operatingServiceImportFile" accept=".json,application/json" class="initial-hidden" onchange="importOperatingServices(this.files)"></div>' + hidden + (rows || '<div class="trace-meta">No operating services configured.</div>') + '<div id="operatingServiceDetail" class="trace-meta"></div></div>';
}

async function exportOperatingServices() {
  try {
    const response = await fetch('/api/services/export');
    const data = await readApiJson(response, 'Operating services export API');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'operating-services-' + new Date().toISOString().slice(0, 10) + '.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  } catch (error) {
    showToast('Export failed: ' + (error.message || error));
  }
}

async function importOperatingServices(files) {
  const input = document.getElementById('operatingServiceImportFile');
  if (!files || files.length === 0) return;
  try {
    const text = await files[0].text();
    const payload = JSON.parse(text);
    const response = await fetch('/api/services/import?overwrite=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await readApiJson(response, 'Operating services import API');
    showToast('Imported ' + (data.imported?.length || 0) + ' service(s); skipped ' + (data.skipped?.length || 0) + '.');
    await loadDiscovery();
  } catch (error) {
    showToast('Import failed: ' + (error.message || error));
  } finally {
    if (input) input.value = '';
  }
}

async function loadOperatingServiceDetail(serviceId) {
  const target = document.getElementById('operatingServiceDetail');
  if (!target || !serviceId) return;
  target.textContent = 'Loading service details...';
  try {
    const [response, lifecycleRes, healthRes] = await Promise.allSettled([
      fetch('/api/services/' + encodeURIComponent(serviceId)),
      fetch('/api/services/' + encodeURIComponent(serviceId) + '/lifecycle'),
      fetch('/api/services/' + encodeURIComponent(serviceId) + '/health'),
    ]);
    const data = response.status === 'fulfilled' ? await readApiJson(response.value, 'Service detail API') : {};
    const lifecycle = lifecycleRes.status === 'fulfilled' && lifecycleRes.value.ok ? await lifecycleRes.value.json() : null;
    const health = healthRes.status === 'fulfilled' && healthRes.value.ok ? await healthRes.value.json() : null;
    const state = data.state || {};
    const count = (key) => Array.isArray(state[key]) ? state[key].length : 0;
    const lcStatus = lifecycle ? lifecycle.status : 'unknown';
    const lcIcon = lcStatus === 'active' ? '🟢' : lcStatus === 'paused' ? '⏸️' : lcStatus === 'disabled' ? '⛔' : lcStatus === 'error' ? '❌' : lcStatus === 'needs_attention' ? '⚠️' : lcStatus === 'archived' ? '📦' : '📝';
    const healthIcon = health ? (health.healthy ? '💚' : '💔') : '';
    const healthNote = health && !health.healthy ? '<div class="trace-meta" style="color:var(--danger)">' + (health.issues || []).map((i) => '⚠️ ' + esc(i)).join('<br>') + '</div>' : '';
    const lcButtons = '<div class="document-actions">'
      + (lcStatus !== 'active' ? '<button class="btn-sm" onclick="transitionService(\'' + escAttr(serviceId) + '\',\'active\')">▶️ Activate</button>' : '')
      + (lcStatus === 'active' ? '<button class="btn-sm" onclick="transitionService(\'' + escAttr(serviceId) + '\',\'paused\')">⏸️ Pause</button>' : '')
      + (lcStatus !== 'disabled' && lcStatus !== 'archived' ? '<button class="btn-sm" onclick="transitionService(\'' + escAttr(serviceId) + '\',\'disabled\')">⛔ Disable</button>' : '')
      + (lcStatus !== 'archived' ? '<button class="btn-sm" onclick="transitionService(\'' + escAttr(serviceId) + '\',\'archived\')">📦 Archive</button>' : '')
      + '</div>';
    target.innerHTML = '<div class="trace-row"><strong>' + esc(data.service?.service_name || serviceId) + '</strong>'
      + '<div class="trace-meta">' + lcIcon + ' ' + esc(lcStatus) + ' ' + healthIcon + ' · tasks ' + count('tasks') + ' · notes ' + count('notes') + ' · observations ' + count('observations') + ' · reviews ' + count('reviews') + '</div>'
      + healthNote + lcButtons
      + '<div class="trace-meta">storage ' + esc(data.service?.storage_location || '') + '</div></div>';
  } catch (error) {
    target.textContent = 'Service details unavailable: ' + (error.message || error);
  }
}
async function transitionService(serviceId, status) {
  try {
    await fetch('/api/services/' + encodeURIComponent(serviceId) + '/lifecycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadOperatingServiceDetail(serviceId);
  } catch (error) {
    console.error('transition failed', error);
  }
}

function renderCuratorDiscoveryPanel(curator) {
  const enabled = curator.enabled;
  const stateColor = enabled ? '#50c878' : '#888';
  const lastRun = curator.lastRunAt ? new Date(curator.lastRunAt).toLocaleString() : 'never';
  const events = (curator.recentEvents || []).slice(-5).reverse();
  const eventsRows = events.map((e) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '?';
    const phase = esc(e.phase || 'curator');
    const action = e.action ? ' · ' + esc(e.action) : '';
    const skill = e.skill ? ' · ' + esc(e.skill) : '';
    const note = e.error ? ' · err: ' + esc(e.error) : e.umbrella ? ' · umbrella: ' + esc(e.umbrella) : '';
    return '<div class="trace-meta trace-meta-sm">' + esc(ts) + ' · ' + phase + action + skill + note + '</div>';
  }).join('');
  const stateClass = enabled ? 'success-pill' : 'muted-pill';
  return '<div id="curatorDiscoveryPanel" class="trace-item">'
    + '<div class="trace-title">Skill Curator <span class="capability-pill ' + stateClass + '">' + (enabled ? 'enabled' : 'disabled') + '</span>' + (curator.schedulerRunning ? ' <span class="capability-pill running-pill">running</span>' : '') + '</div>'
    + '<div class="trace-meta">Interval: ' + (curator.intervalHours || 168) + 'h · Idle threshold: ' + (curator.idleThresholdMinutes || 120) + ' min · Last run: ' + esc(lastRun) + '</div>'
    + (eventsRows ? '<div class="trace-block-spaced">' + eventsRows + '</div>' : '<div class="trace-meta">No curator events yet.</div>')
    + '<button class="btn-sm full-width-button" onclick="openLeftTabByName(\'skills\')">Open Skills tab</button>'
    + '</div>';
}

function renderModelCatalogPanel(modelCatalog) {
  const manifest = modelCatalog.manifest || { providers: {} };
  const status = modelCatalog.status || {};
  const providers = Object.entries(manifest.providers || {}).map(([name, provider]) => '<div class="trace-row"><strong>' + esc(name) + '</strong><div class="trace-meta">' + (provider.models || []).length + ' model(s)</div>' + (provider.models || []).slice(0, 5).map((model) => '<div class="trace-meta">' + esc(model.id) + ' · ' + esc(model.description || '') + '</div>').join('') + '</div>').join('');
  return '<div id="modelCatalogPanel" class="trace-item"><div class="trace-title">Model Catalog</div><div class="trace-meta">' + esc(status.exists ? (status.fresh ? 'cached and fresh' : 'cached but stale') : 'using built-in catalog') + '</div>' + renderModelRecommendations(manifest) + (providers || '<div class="trace-meta">No catalog providers found.</div>') + '<button class="btn-sm full-width-button" onclick="refreshModelCatalog()">Refresh catalog</button></div>';
}

function renderModelRecommendations(manifest) {
  const fallbackRecommendations = [
    { useCase: 'Best for coding', modelId: 'qwen2.5-coder:7b', reason: 'Best built-in local default for code edits; still validate with typecheck, tests, or smoke.' },
    { useCase: 'Best for research', modelId: 'llama3.1:8b', reason: 'General local reasoning default for summaries and workspace research.' },
    { useCase: 'Safe local fallback', modelId: 'llama3.1:8b', reason: 'Keeps prompts local when privacy matters more than raw capability.' },
    { useCase: 'Best for autonomy', modelId: 'strongest configured tool-capable model', reason: 'Use the strongest configured backend for long autonomous runs; keep validation and evidence review on.' },
    { useCase: 'Vision', modelId: 'llava:latest', reason: 'Use when image analysis is required and the model is pulled locally.' },
  ];
  const recommendations = Array.isArray(manifest?.metadata?.recommendations) && manifest.metadata.recommendations.length > 0 ? manifest.metadata.recommendations : fallbackRecommendations;
  if (recommendations.length === 0) return '';
  const rows = recommendations.slice(0, 6).map((item) => {
    const useCase = item && typeof item.useCase === 'string' ? item.useCase : 'Work';
    const modelId = item && typeof item.modelId === 'string' ? item.modelId : 'No model listed';
    const reason = item && typeof item.reason === 'string' ? item.reason : '';
    return '<div class="trace-row"><strong>' + esc(useCase) + ': ' + esc(modelId) + '</strong><div class="trace-meta">' + esc(reason) + '</div></div>';
  }).join('');
  return '<div id="modelRecommendationsPanel"><div class="trace-block-spaced"><strong>Recommended defaults</strong><div class="trace-meta">Pick the model by job first, then validate the output.</div>' + rows + '</div></div>';
}

function renderExtensionDiscoveryPanel(extensions) {
  const manifests = extensions.manifests || [];
  const rows = manifests.map((manifest) => '<div class="trace-row"><strong>' + esc(manifest.kind) + ': ' + esc(manifest.name) + '</strong><div class="trace-meta">' + esc(manifest.description || manifest.filePath || '') + '</div><div class="trace-meta">Activation: ' + esc(manifest.activation?.status || 'unknown') + ' · ' + esc(manifest.activation?.reason || '') + '</div>' + renderInlineList('Tools', manifest.providesTools) + renderInlineList('Hooks', manifest.providesHooks) + renderInlineList('Triggers', manifest.triggers) + '</div>').join('');
  const skills = extensions.skills || {};
  const runtimeSummary = skills.runtime ? '<div class="trace-meta">Runtime skills: ' + (skills.runtime.total || 0) + ' loaded · ' + (skills.runtime.diagnosticCount || 0) + ' skipped</div>' : '';
  const repoSummary = skills.repo ? '<div class="trace-meta">Repo skills: ' + (skills.repo.total || 0) + ' available · ' + (skills.repo.diagnosticCount || 0) + ' malformed</div>' : '';
  const diagnosticRows = renderDiscoverySkillDiagnostics(skills);
  const skillsAction = (skills.runtime || skills.repo) ? '<button class="btn-sm full-width-button" onclick="openSkillsTab()">Open Skills tab</button>' : '';
  return '<div id="extensionDiscoveryPanel" class="trace-item"><div class="trace-title">Extensions</div><div class="trace-meta">' + manifests.length + ' manifest(s) discovered</div>' + runtimeSummary + repoSummary + diagnosticRows + (rows || '<div class="trace-meta">No extension manifests found.</div>') + skillsAction + '</div>';
}

function renderDiscoverySkillDiagnostics(skills) {
  const sources = skills.sources || [];
  const diagnostics = sources.flatMap((source) => (source.diagnostics || []).map((item) => ({ ...item, source: source.source })));
  if (diagnostics.length === 0) return '<div class="trace-meta">Skill diagnostics: clean.</div>';
  const rows = diagnostics.slice(0, 5).map((item) => '<div class="trace-meta trace-meta-sm">' + esc(item.source || 'skills') + ' · ' + esc(item.name) + ' · ' + esc(item.reason) + '</div>').join('');
  const more = diagnostics.length > 5 ? '<div class="trace-meta">+' + (diagnostics.length - 5) + ' more diagnostic(s) in the Skills tab.</div>' : '';
  return '<details class="details-my6"><summary class="trace-meta clickable-summary">Skill diagnostics (' + diagnostics.length + ')</summary>' + rows + more + '</details>';
}

function renderAutomationDiscoveryPanel(automations) {
  const due = automations.due || [];
  const rows = due.slice(0, 8).map((job) => '<div class="trace-row"><strong>' + esc(job.name) + '</strong><div class="trace-meta">' + esc(job.schedule?.display || '') + ' · next ' + esc(job.nextRunAt || '') + '</div></div>').join('');
  return '<div id="automationDiscoveryPanel" class="trace-item"><div class="trace-title">Automations</div><div class="trace-meta">' + (automations.total || 0) + ' job(s), ' + due.length + ' due</div>' + (rows || '<div class="trace-meta">No due automations.</div>') + '</div>';
}

function renderSessionSearchDiscoveryPanel(status) {
  return '<div id="sessionSearchDiscoveryPanel" class="trace-item"><div class="trace-title">Session Search Index</div><div class="trace-meta">' + esc(status.exists ? (status.fresh ? 'fresh' : 'stale') : 'not built') + ' · ' + (status.entryCount || 0) + ' entries · ' + (status.sessionCount || 0) + ' sessions</div><div class="trace-meta">Last rebuilt: ' + esc(status.rebuiltAt || 'never') + '</div><button id="rebuildSessionSearchIndexBtn" class="btn-sm full-width-button" onclick="rebuildSessionSearchIndex()">Rebuild search index</button></div>';
}

function renderInlineList(label, values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  return list.length ? '<div class="trace-meta">' + esc(label) + ': ' + esc(list.join(', ')) + '</div>' : '';
}

async function refreshModelCatalog() { const status = document.getElementById('modelCatalogSettingsStatus'); if (status) status.textContent = 'Refreshing catalog...'; try { const response = await fetch('/api/models/catalog/refresh', { method: 'POST' }); const data = await response.json(); if (data.error) throw new Error(data.error); if (status) status.textContent = 'Catalog refreshed: ' + Object.keys(data.manifest?.providers || {}).length + ' provider(s).'; await loadDiscovery(); } catch (error) { if (status) status.textContent = 'Catalog refresh failed: ' + (error.message || error); } }

async function rebuildSessionSearchIndex() { const view = document.getElementById('sessionSearchDiscoveryPanel'); if (view) view.querySelector('.trace-meta').textContent = 'Rebuilding search index...'; try { const response = await fetch('/api/sessions/search-index/rebuild', { method: 'POST' }); const data = await response.json(); if (data.error) throw new Error(data.error); await loadDiscovery(); } catch (error) { showToast('Search index rebuild failed: ' + (error.message || error)); } }

async function loadPalaceEntry(id) { const detail = document.getElementById('palaceDetail'); if (!detail) return; detail.classList.remove('initial-hidden'); detail.textContent = 'Loading memory entry...'; try { const entryResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id)); const entryData = await entryResponse.json(); if (entryData.error) { detail.textContent = entryData.error; return; } const contextResponse = await fetch('/api/memory/entries/' + encodeURIComponent(id) + '/context?window=3'); const contextData = await contextResponse.json(); const entry = entryData.entry; const transcriptRows = (contextData.events || []).map((event) => '<div class="transcript-row' + (event.isAnchor ? ' anchor' : '') + '"><div><strong>' + esc(event.kind) + '</strong> · ' + esc(event.timestamp) + '</div><div class="prewrap-text">' + esc(event.text || '[empty]') + '</div></div>').join(''); detail.innerHTML = '<div><strong>Session</strong> ' + esc(entry.sessionId) + '</div><div><strong>Event</strong> ' + esc(entry.id) + '</div><div><strong>Kind</strong> ' + esc(entry.kind) + '</div><div><strong>Time</strong> ' + esc(entry.timestamp) + '</div><div class="prewrap-text trace-block-spaced">' + esc(entry.text) + '</div><div class="trace-block-spaced-large"><strong>Transcript Context</strong>' + (transcriptRows || '<div class="transcript-row">No transcript context found.</div>') + '</div>'; } catch (error) { detail.textContent = error.message; } }

function showLeftTab(tab, el) { revealLeftPanel(); document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active')); if (el) el.classList.add('active'); if (!MORE_MENU_TABS.includes(tab)) { const moreBtn = document.getElementById('tabMoreBtn'); if (moreBtn) moreBtn.classList.remove('has-active'); document.querySelectorAll('.more-menu-item').forEach((item) => item.classList.remove('active')); } document.getElementById('historyList').style.display = tab === 'history' ? 'block' : 'none'; document.getElementById('fileTree').style.display = tab === 'files' ? 'block' : 'none'; document.getElementById('skillList').style.display = tab === 'skills' ? 'block' : 'none'; document.getElementById('memoryView').style.display = tab === 'memory' ? 'block' : 'none'; document.getElementById('memoryPalaceView').style.display = tab === 'palace' ? 'block' : 'none'; document.getElementById('discoveryView').style.display = tab === 'discovery' ? 'block' : 'none'; document.getElementById('learningView').style.display = tab === 'learning' ? 'block' : 'none'; const sn = document.getElementById('snapshotsView'); if (sn) sn.style.display = tab === 'snapshots' ? 'block' : 'none'; const rg = document.getElementById('ragView'); if (rg) rg.style.display = tab === 'rag' ? 'block' : 'none'; const td = document.getElementById('toolsDashboardView'); if (td) td.style.display = tab === 'tools' ? 'block' : 'none'; const rn = document.getElementById('runsView'); if (rn) rn.style.display = tab === 'runs' ? 'block' : 'none'; const al = document.getElementById('atlasView'); if (al) al.style.display = tab === 'atlas' ? 'block' : 'none'; const at = document.getElementById('autonomyView'); if (at) at.style.display = tab === 'autonomy' ? 'block' : 'none'; const wf = document.getElementById('workflowsView'); if (wf) wf.style.display = tab === 'workflows' ? 'block' : 'none'; const my = document.getElementById('myceliumView'); if (my) my.style.display = tab === 'mycelium' ? 'block' : 'none'; const pr = document.getElementById('promisesView'); if (pr) pr.style.display = tab === 'promises' ? 'block' : 'none'; const ev = document.getElementById('eventsView'); if (ev) ev.style.display = tab === 'events' ? 'block' : 'none'; const ci = document.getElementById('codeintelView'); if (ci) ci.style.display = tab === 'codeintel' ? 'block' : 'none'; const tk = document.getElementById('tasksView'); if (tk) tk.style.display = tab === 'tasks' ? 'block' : 'none'; const au = document.getElementById('auditView'); if (au) au.style.display = tab === 'audit' ? 'block' : 'none'; const tg = document.getElementById('triggersView'); if (tg) tg.style.display = tab === 'triggers' ? 'block' : 'none'; const ag = document.getElementById('agentsView'); if (ag) ag.style.display = tab === 'agents' ? 'block' : 'none'; const sq = document.getElementById('squadsView'); if (sq) sq.style.display = tab === 'squads' ? 'block' : 'none'; const idn = document.getElementById('identityView'); if (idn) idn.style.display = tab === 'identity' ? 'block' : 'none'; const arf = document.getElementById('artifactsView'); if (arf) arf.style.display = tab === 'artifacts' ? 'block' : 'none'; const hl = document.getElementById('healthView'); if (hl) hl.style.display = tab === 'health' ? 'block' : 'none'; if (tab === 'files') loadFiles(); if (tab === 'skills') loadSkills(); if (tab === 'memory') loadMemory(); if (tab === 'palace') loadMemoryPalace(); if (tab === 'discovery') loadDiscovery(); if (tab === 'learning') loadLearning(); if (tab === 'snapshots') loadSnapshots(); if (tab === 'rag') loadRagTab(); if (tab === 'tools') loadToolsDashboard(); if (tab === 'runs') loadRuns(); if (tab === 'atlas') loadAtlas(); if (tab === 'autonomy') loadAutonomyTab(); if (tab === 'workflows') loadWorkflows(); if (tab === 'mycelium') loadMycelium(); if (tab === 'promises') loadPromises(); if (tab === 'events') loadEvents(); if (tab === 'codeintel') loadCodeIntel(); if (tab === 'tasks') loadTasks(); if (tab === 'audit') loadAudit(); if (tab === 'triggers') loadTriggers(); if (tab === 'agents') loadAgents(); if (tab === 'squads') loadSquads(); if (tab === 'identity') loadIdentity(); if (tab === 'artifacts') loadArtifacts(); if (tab === 'health') loadHealth(); }
function toggleLeft() {
  const panel = document.getElementById('leftPanel');
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  panel.classList.toggle('visible', !hidden);
  try { localStorage.setItem('leftPanelCollapsed', hidden ? '1' : '0'); } catch(e){}
  updatePanelBackdrop();
}

// Ensure the left panel is visible. Called by slash-command openers and
// inline cards that need to reveal a tab even when the user has the
// rail collapsed. Mirrors toggleLeft's storage so the next reload keeps
// the user-visible choice.
function revealLeftPanel() {
  const panel = document.getElementById('leftPanel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    try { localStorage.setItem('leftPanelCollapsed', '0'); } catch(e){}
    updatePanelBackdrop();
  }
}

// ─── Autonomy tab ──────────────────────────────────────────────────
// One-click entry point for the Autonomy Run Builder. The panel itself
// is rendered into #autonomyBuilderPanel by the existing
// loadAutonomyPlanPreview function (used in the work area too), so
// this loader just supplies the wrapper div and reuses the data fetch.
async function loadAutonomyTab() {
  const view = document.getElementById('autonomyView');
  if (!view) return;
  view.innerHTML = '<div class="autonomy-tab-header" style="padding:12px 14px;border-bottom:1px solid var(--border)"><h3 style="margin:0">\ud83d\ude80 Autonomy</h3><p style="margin:4px 0 0;font-size:12px;color:var(--text-dim)">Add tasks, click Start. The page title gets a \ud83d\udd14 prefix when the run finishes; if you allowed browser notifications, you also get a desktop ping.</p></div>'
    + '<div class="autonomy-builder" id="autonomyBuilderPanel" style="padding:14px"><div class="readiness-empty">Loading autonomy plan...</div></div>';
  loadAutonomyPlanPreview();
}

// ─── Project Atlas ─────────────────────────────────────────────────
// Read-only map answering "what's been built, where, and by which task".
// Synthesizes IMPLEMENTATION_PLAN.md + .forge-history.jsonl via /api/atlas/map.
function atlasStatusBadge(status) {
  const map = { done: ['\u2713 done', 'var(--ok,#3fb950)'], pending: ['\u25cb pending', 'var(--text-dim)'], failed: ['\u2715 failed', 'var(--err,#f85149)'] };
  const [label, color] = map[status] || ['\u2014', 'var(--text-dim)'];
  return '<span style="color:' + color + ';font-size:11px">' + label + '</span>';
}

function atlasWhen(iso) {
  if (!iso) return '<span style="color:var(--text-dim)">never</span>';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : esc(d.toLocaleString());
}

// Pre-fill (not auto-send) a targeted update goal into the chat composer so the
// user can review before running. This is the incremental-update entry point:
// it reuses the normal chat goal path rather than introducing a new write path.
function atlasUpdateFile(filePath) {
  const inp = document.getElementById('chatInput');
  if (!inp) return;
  inp.value = 'Update ' + filePath + ': ';
  inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* noop */ }
}

async function loadAtlas() {
  const view = document.getElementById('atlasView');
  if (!view) return;
  view.innerHTML = '<div style="padding:12px 14px;border-bottom:1px solid var(--border)"><h3 style="margin:0">\ud83d\uddfa Project Atlas</h3><p style="margin:4px 0 0;font-size:12px;color:var(--text-dim)">What has been built, where, and by which task \u2014 from the plan and change history.</p></div><div id="atlasBody" style="padding:14px"><div class="readiness-empty">Loading project map\u2026</div></div>';
  const body = document.getElementById('atlasBody');
  try {
    const res = await fetch('/api/atlas/map');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const map = await res.json();
    renderAtlas(body, map);
  } catch (e) {
    body.innerHTML = '<div class="readiness-empty">Could not load the project map: ' + esc(e && e.message ? e.message : String(e)) + '</div>';
  }
}

function renderAtlas(body, map) {
  const s = map.summary || {};
  if (!map.files?.length && !map.tasks?.length) {
    body.innerHTML = '<div class="readiness-empty">No project map yet. Once the autonomy loop runs tasks (writing IMPLEMENTATION_PLAN.md and .forge-history.jsonl), the files it builds and the tasks that built them appear here.</div>';
    return;
  }
  const chip = (label, value) => '<div style="background:var(--bg-soft,rgba(255,255,255,0.04));border:1px solid var(--border);border-radius:6px;padding:6px 10px"><div style="font-size:18px;font-weight:600">' + value + '</div><div style="font-size:11px;color:var(--text-dim)">' + label + '</div></div>';
  const chips = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">'
    + chip('files tracked', s.filesTracked ?? 0)
    + chip('tasks', s.tasksTotal ?? 0)
    + chip('done', s.tasksDone ?? 0)
    + chip('pending', s.tasksPending ?? 0)
    + chip('failed', s.tasksFailed ?? 0)
    + '</div>'
    + '<div style="font-size:11px;color:var(--text-dim);margin-bottom:14px">Last activity: ' + atlasWhen(s.lastActivityAt) + '</div>';

  const fileRows = (map.files || []).map((f) => '<tr>'
    + '<td style="padding:6px 8px;font-family:monospace;font-size:12px">' + esc(f.path) + '</td>'
    + '<td style="padding:6px 8px;font-size:12px">' + esc(f.lastChangedByTaskTitle || f.lastChangedByTaskId || '\u2014') + '</td>'
    + '<td style="padding:6px 8px;font-size:12px">' + atlasWhen(f.lastChangedAt) + '</td>'
    + '<td style="padding:6px 8px;text-align:center">' + (f.changeCount ?? 0) + '</td>'
    + '<td style="padding:6px 8px">' + atlasStatusBadge(f.planStatus) + '</td>'
    + '<td style="padding:6px 8px"><button class="btn-sm" onclick="atlasUpdateFile(' + JSON.stringify(f.path).replace(/"/g, '&quot;') + ')">Update this</button></td>'
    + '</tr>').join('');
  const filesTable = '<h4 style="margin:0 0 8px">Files</h4><table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;color:var(--text-dim);font-size:11px;border-bottom:1px solid var(--border)">'
    + '<th style="padding:6px 8px">File</th><th style="padding:6px 8px">Built / last changed by</th><th style="padding:6px 8px">When</th><th style="padding:6px 8px">Changes</th><th style="padding:6px 8px">Plan status</th><th style="padding:6px 8px"></th>'
    + '</tr></thead><tbody>' + (fileRows || '<tr><td colspan="6" style="padding:8px;color:var(--text-dim)">No files changed yet.</td></tr>') + '</tbody></table>';

  const taskRows = (map.tasks || []).map((t) => '<tr>'
    + '<td style="padding:6px 8px;font-size:12px">' + esc(t.title || t.id) + (t.inPlan ? '' : ' <span style="color:var(--text-dim);font-size:10px">(not in plan)</span>') + '</td>'
    + '<td style="padding:6px 8px">' + atlasStatusBadge(t.planStatus) + '</td>'
    + '<td style="padding:6px 8px;text-align:center">' + (t.runCount ?? 0) + '</td>'
    + '<td style="padding:6px 8px;font-size:12px">' + atlasWhen(t.lastRunAt) + '</td>'
    + '<td style="padding:6px 8px;text-align:center">' + (t.changedFiles ? t.changedFiles.length : 0) + '</td>'
    + '</tr>').join('');
  const tasksTable = '<h4 style="margin:18px 0 8px">Tasks</h4><table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;color:var(--text-dim);font-size:11px;border-bottom:1px solid var(--border)">'
    + '<th style="padding:6px 8px">Task</th><th style="padding:6px 8px">Plan status</th><th style="padding:6px 8px">Runs</th><th style="padding:6px 8px">Last run</th><th style="padding:6px 8px">Files</th>'
    + '</tr></thead><tbody>' + (taskRows || '<tr><td colspan="5" style="padding:8px;color:var(--text-dim)">No tasks yet.</td></tr>') + '</tbody></table>';

  body.innerHTML = chips + filesTable + tasksTable;
}


// ─── Left panel resize ─────────────────────────────────────────────
// Drag the right edge of the left panel to widen it. Width persists in
// localStorage so it survives reloads. Min 220, max 800px. Skipped on
// narrow viewports where the panel is a fixed off-canvas drawer.
function setupLeftPanelResizer() {
  const panel = document.getElementById('leftPanel');
  const handle = document.getElementById('leftPanelResizer');
  if (!panel || !handle) return;
  const setPanelWidth = (width) => {
    const normalized = Math.min(800, Math.max(220, width));
    panel.style.setProperty('--left-panel-width', normalized + 'px');
  };
  // Restore saved width.
  try {
    const saved = parseInt(localStorage.getItem('leftPanelWidth') || '', 10);
    if (Number.isFinite(saved) && saved >= 220 && saved <= 800) {
      setPanelWidth(saved);
    }
  } catch(e){ /* private mode */ }
  // Restore persisted collapsed state. Default for new users is collapsed
  // so the chat-only surface is the first thing they see; the topbar ☰
  // button and slash commands like /skills, /files, /memory all reveal it.
  // Narrow viewports always start collapsed regardless of saved state.
  let collapsed;
  try {
    const saved = localStorage.getItem('leftPanelCollapsed');
    collapsed = saved === null ? true : saved === '1';
  } catch(e){ collapsed = true; }
  if (window.innerWidth <= 900) collapsed = true;
  if (collapsed) {
    panel.classList.add('hidden');
    panel.classList.remove('visible');
  } else {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
  }
  let startX = 0;
  let startWidth = 0;
  let dragging = false;
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    setPanelWidth(startWidth + dx);
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    try { localStorage.setItem('leftPanelWidth', String(Math.round(panel.getBoundingClientRect().width))); } catch(e){}
  }
  handle.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 900) return; // Mobile: panel is off-canvas, no resize.
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
document.addEventListener('DOMContentLoaded', setupLeftPanelResizer);
// Also run immediately in case DOMContentLoaded already fired (this
// script is loaded after the body in some build outputs).
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  setupLeftPanelResizer();
}

// Tabs we don't show in the main bar — selected via the More overflow menu.
const MORE_MENU_TABS = ['palace', 'discovery', 'learning', 'snapshots', 'rag', 'tools', 'runs', 'atlas', 'autonomy', 'mycelium', 'promises', 'events', 'codeintel', 'tasks', 'audit', 'triggers', 'agents', 'squads', 'identity', 'artifacts', 'health'];

function toggleMoreMenu(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const menu = document.getElementById('moreMenu');
  if (!menu) return;
  menu.classList.toggle('hidden-by-default');
  if (!menu.classList.contains('hidden-by-default')) {
    // Close on outside click — bind once, then auto-remove.
    setTimeout(() => {
      const closer = (e) => {
        if (!menu.contains(e.target) && e.target.id !== 'tabMoreBtn' && !document.getElementById('tabMoreBtn').contains(e.target)) {
          menu.classList.add('hidden-by-default');
          document.removeEventListener('click', closer);
        }
      };
      document.addEventListener('click', closer);
    }, 0);
  }
}

function selectFromMore(tab) {
  // Hide menu, dispatch the existing tab handler. Use the More button as the
  // "active" element so the visual indicator stays on it while a More tab is in view.
  const menu = document.getElementById('moreMenu');
  if (menu) menu.classList.add('hidden-by-default');
  const moreBtn = document.getElementById('tabMoreBtn');
  if (moreBtn) {
    showLeftTab(tab, moreBtn);
    moreBtn.classList.add('has-active');
  }
  // Highlight the chosen item next time the menu opens.
  document.querySelectorAll('.more-menu-item').forEach((item) => {
    if (item.dataset.tab === tab) item.classList.add('active');
    else item.classList.remove('active');
  });
}
function toggleRight() {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  const isOpen = !panel.classList.contains('hidden');
  // Persist so the panel state survives reloads.
  try { localStorage.setItem('harness_right_panel', isOpen ? 'open' : 'closed'); } catch(e){}
  if (isOpen) loadAbout();
  updatePanelBackdrop();
}

// Show or hide the semi-transparent backdrop when a panel is open as a
// fixed overlay (narrow viewports). Clicking the backdrop closes both panels.
function updatePanelBackdrop() {
  const backdrop = document.getElementById('panelBackdrop');
  if (!backdrop) return;
  // Only show the backdrop on truly narrow viewports where panels behave
  // like full-screen sheets. At tablet widths (900-1300) the right panel
  // overlays content but the rest of the screen is still usable, so a
  // backdrop would needlessly block left-panel interactions.
  const leftOpen = (function() {
    if (window.innerWidth > 900) return false;
    const lp = document.getElementById('leftPanel');
    return lp && !lp.classList.contains('hidden');
  })();
  const rightOpen = (function() {
    if (window.innerWidth > 900) return false;
    const rp = document.getElementById('rightPanel');
    return rp && !rp.classList.contains('hidden');
  })();
  backdrop.classList.toggle('active', leftOpen || rightOpen);
}

function dismissPanelBackdrop() {
  const lp = document.getElementById('leftPanel');
  if (lp && !lp.classList.contains('hidden') && window.innerWidth <= 900) {
    lp.classList.add('hidden');
    lp.classList.remove('visible');
    try { localStorage.setItem('leftPanelCollapsed', '1'); } catch(e){}
  }
  const rp = document.getElementById('rightPanel');
  if (rp && !rp.classList.contains('hidden') && window.innerWidth <= 900) {
    rp.classList.add('hidden');
    try { localStorage.setItem('harness_right_panel', 'closed'); } catch(e){}
  }
  updatePanelBackdrop();
}

// Restore the right panel open/closed state from a previous session. Default
// is closed (the panel ships with .hidden in markup) so first-run users still
// see the cleanest possible chat surface. Skipped on narrow viewports where
// the panel goes overlay — auto-opening an overlay panel on load would block
// the chat composer behind a sheet the user has to dismiss first.
function restoreRightPanelState() {
  try {
    if (window.innerWidth < 1300) return;
    if (localStorage.getItem('harness_right_panel') === 'open') {
      const panel = document.getElementById('rightPanel');
      if (panel && panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        loadAbout();
      }
    }
  } catch(e){}
}

// Reset a single Settings section to its default value via the existing
// /api/settings endpoint. Keep the defaults table small and explicit so the
// behavior of each "↺ Reset" button is obvious from the source.
const SETTINGS_DEFAULTS = {
  connection: { ollamaHost: 'http://localhost:11434' },
  agentFiles: { agentOutputDir: '' },
  safety: { permissionMode: 'dontAsk' },
  modelGen: { temperature: 0.7, topP: 0.9, contextMaxTokens: 0, timeBudgetMs: 0 },
  webRead: { webReadMaxChars: 12000 },
};

async function resetSettingsSection(section) {
  const payload = SETTINGS_DEFAULTS[section];
  if (!payload) return;
  if (!await confirmToast('Reset the ' + section + ' section to defaults?')) return;
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data.error) { showToast('Reset failed: ' + data.error); return; }
    // Reflect the new value in the UI inputs that the user can see.
    if (section === 'connection') {
      const el = document.getElementById('ollamaHost');
      if (el) el.value = payload.ollamaHost;
    } else if (section === 'agentFiles') {
      const el = document.getElementById('agentOutputDirInput');
      if (el) el.value = '';
    } else if (section === 'safety') {
      // Highlight the "Auto-approve all" mode option visually if present.
      const opts = document.querySelectorAll('.permission-mode-option');
      opts.forEach((opt) => opt.classList.remove('active'));
      if (opts[0]) opts[0].classList.add('active');
    } else if (section === 'modelGen') {
      const t = document.getElementById('tempSlider'); if (t) { t.value = 0.7; document.getElementById('tempVal').textContent = '0.7'; }
      const p = document.getElementById('topPSlider'); if (p) { p.value = 0.9; document.getElementById('topPVal').textContent = '0.9'; }
      const c = document.getElementById('contextMaxTokens'); if (c) c.value = 0;
    } else if (section === 'webRead') {
      const w = document.getElementById('webReadMaxChars'); if (w) w.value = 12000;
    }
    loadAbout();
  } catch (error) { showToast('Reset failed: ' + (error.message || error)); }
}

// Populate the About section with version, model, ollama host, permission/skill/memory counts.
async function loadAbout() {
  const version = document.getElementById('aboutVersion');
  const summary = document.getElementById('aboutSummary');
  if (!version || !summary) return;
  try {
    const [aboutR, settingsR, skillsR, memoryR] = await Promise.allSettled([
      fetch('/api/about').then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/skills').then((r) => r.json()),
      fetch('/api/memory').then((r) => r.json()).catch(() => null),
    ]);
    const about = aboutR.status === 'fulfilled' ? aboutR.value : {};
    const settings = settingsR.status === 'fulfilled' ? settingsR.value : {};
    const skillsData = skillsR.status === 'fulfilled' ? skillsR.value : { skills: [] };
    const memoryData = memoryR.status === 'fulfilled' && memoryR.value ? memoryR.value : null;
    const skillCount = (skillsData.skills || []).length;
    const enabledSkillCount = (skillsData.skills || []).filter((s) => s.enabled !== false).length;
    // /api/memory returns { decisions, patterns, notes } raw markdown strings; count non-empty.
    const memoryFiles = memoryData ? Object.values(memoryData).filter((v) => typeof v === 'string' && v.trim().length > 0).length : 0;
    const verLabel = about.version ? 'Harness v' + about.version : 'Harness';
    version.textContent = verLabel;
    summary.innerHTML = ''
      + '<div><strong>Model</strong>' + esc(settings.model || '—') + '</div>'
      + '<div><strong>Ollama host</strong>' + esc(settings.ollamaHost || '—') + '</div>'
      + '<div><strong>Skills</strong>' + enabledSkillCount + ' on / ' + skillCount + ' total</div>'
      + '<div><strong>Memory entries</strong>' + memoryFiles + ' file(s)</div>'
      + '<div><strong>Permission mode</strong>' + esc(settings.permissionMode || '—') + '</div>'
      + '<div><strong>Context cap</strong>' + (Number(settings.contextMaxTokens) === 0 ? 'auto' : esc(String(settings.contextMaxTokens || '—')) + ' tokens') + '</div>';
  } catch (error) {
    version.textContent = 'Harness';
    summary.textContent = 'Could not load about info: ' + (error.message || error);
  }
}

/**
 * Convert each `.settings-section` in the right panel into a collapsible
 * details-style block (header click toggles its `.open` class). Also
 * inject a search box that filters sections by title + content text.
 * Without this, the 20+ section panel is unusable on smaller viewports.
 */
function setupSettingsCollapse() {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  // Inject search input directly after the panel-header.
  const header = panel.querySelector('.panel-header');
  if (header && !panel.querySelector('.panel-search')) {
    const search = document.createElement('div');
    search.className = 'panel-search';
    search.innerHTML = '<input type="text" id="settingsSearch" placeholder="🔍 Filter settings..." autocomplete="off">'
      + '<div class="settings-collapse-actions">'
      +   '<button class="btn-sm" onclick="setAllSettingsSections(true)" title="Open every section">Expand all</button>'
      +   '<button class="btn-sm" onclick="setAllSettingsSections(false)" title="Collapse every section">Collapse all</button>'
      + '</div>';
    header.insertAdjacentElement('afterend', search);
    search.querySelector('input').addEventListener('input', filterSettingsSections);
  }
  // Wrap each section's body content in `.settings-section-body` and
  // make the h4 toggle the parent's `.open` class.
  const sections = panel.querySelectorAll('.settings-section');
  const remembered = (() => { try { return JSON.parse(localStorage.getItem('settingsOpenSections') || '[]'); } catch(e){ return []; } })();
  const rememberSet = new Set(remembered);
  sections.forEach((section, idx) => {
    if (section.dataset.collapseInit === '1') return;
    section.dataset.collapseInit = '1';
    const h4 = section.querySelector('h4');
    if (!h4) return;
    // Wrap everything after h4 in .settings-section-body.
    const body = document.createElement('div');
    body.className = 'settings-section-body';
    let next = h4.nextSibling;
    while (next) {
      const after = next.nextSibling;
      body.appendChild(next);
      next = after;
    }
    section.appendChild(body);
    const titleKey = (h4.textContent || ('section-' + idx)).trim();
    section.dataset.titleKey = titleKey;
    h4.addEventListener('click', () => {
      section.classList.toggle('open');
      const open = Array.from(panel.querySelectorAll('.settings-section.open')).map((s) => s.dataset.titleKey);
      try { localStorage.setItem('settingsOpenSections', JSON.stringify(open)); } catch(e){}
    });
    if (rememberSet.has(titleKey) || (rememberSet.size === 0 && idx === 0)) {
      // Default state: only the first section open, otherwise restore.
      section.classList.add('open');
    }
  });
  groupAdvancedSettings(panel);
}

// Hide rarely-touched sections behind a single "Advanced (N)" disclosure so
// the right panel doesn't dump 14 expandable sections on the user. The set
// of visible sections is identified by their h4 textContent (resilient to the
// order of DOM insertion).
const ALWAYS_VISIBLE_SETTINGS = new Set([
  'About',
  'Connection',
  'Remote API Keys & Services',
  '📁 Agent Files',
  'Safety Mode',
  'Generation',
  'Agent Identity',
]);

function groupAdvancedSettings(panel) {
  if (panel.dataset.advancedGrouped === '1') return;
  panel.dataset.advancedGrouped = '1';
  const sections = Array.from(panel.querySelectorAll('.settings-section'));
  const titleOf = (section) => {
    const h4 = section.querySelector('h4');
    if (!h4) return '';
    const titleNode = Array.from(h4.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    return (titleNode ? titleNode.textContent : h4.textContent).trim();
  };
  const visible = sections.filter((s) => ALWAYS_VISIBLE_SETTINGS.has(titleOf(s)));
  const advanced = sections.filter((s) => !ALWAYS_VISIBLE_SETTINGS.has(titleOf(s)));
  if (advanced.length === 0) return;
  // Re-stack always-visible sections at the top so the Advanced fold can sit
  // cleanly at the bottom. Without this, sections like 'Safety Mode' that are
  // declared after an advanced section in markup get stranded under the fold.
  for (const section of visible) panel.appendChild(section);
  const wrap = document.createElement('details');
  wrap.className = 'settings-advanced-fold';
  wrap.innerHTML = '<summary>Advanced (' + advanced.length + ' more sections)</summary>';
  panel.appendChild(wrap);
  for (const section of advanced) wrap.appendChild(section);
}

function setAllSettingsSections(open) {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  const sections = panel.querySelectorAll('.settings-section');
  sections.forEach((section) => {
    if (open) section.classList.add('open');
    else section.classList.remove('open');
  });
  const remember = open ? Array.from(sections).map((s) => s.dataset.titleKey).filter(Boolean) : [];
  try { localStorage.setItem('settingsOpenSections', JSON.stringify(remember)); } catch(e){}
}

function filterSettingsSections(event) {
  const q = (event.target.value || '').trim().toLowerCase();
  const panel = document.getElementById('rightPanel');
  if (!panel) return;
  panel.querySelectorAll('.settings-section').forEach((section) => {
    if (!q) {
      section.style.display = '';
      return;
    }
    const text = (section.textContent || '').toLowerCase();
    if (text.includes(q)) {
      section.style.display = '';
      section.classList.add('open');
    } else {
      section.style.display = 'none';
    }
  });
}

// ─── Remote API key entry ─────────────────────────────────────────────
// Backend-aligned key list. Entries here MUST correspond to a backend
// in src/core/chatClientFactory.ts OPENAI_COMPATIBLE_PRESETS — otherwise
// users save a key the harness has no client to invoke. ANTHROPIC_API_KEY
// was removed in v0.2.3 because no Anthropic chat client is wired (the
// storage path remains in ALLOWED_API_KEY_NAMES so users with an existing
// Anthropic key in env get it forwarded to the autonomy container).
const REMOTE_API_KEY_FIELDS = [
  { name: 'MISTRAL_API_KEY', label: 'Mistral AI', signup: 'https://console.mistral.ai/api-keys', group: 'LLM Providers' },
  { name: 'GROQ_API_KEY', label: 'Groq', signup: 'https://console.groq.com/keys', group: 'LLM Providers' },
  { name: 'CEREBRAS_API_KEY', label: 'Cerebras', signup: 'https://cloud.cerebras.ai/', group: 'LLM Providers' },
  { name: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare Workers AI token', signup: 'https://dash.cloudflare.com/profile/api-tokens', group: 'LLM Providers' },
  { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare Account ID', signup: 'https://dash.cloudflare.com/', group: 'LLM Providers' },
  { name: 'GEMINI_API_KEY', label: 'Google Gemini', signup: 'https://aistudio.google.com/app/apikey', group: 'LLM Providers' },
  { name: 'GITHUB_MODELS_TOKEN', label: 'GitHub Models', signup: 'https://github.com/marketplace/models', group: 'LLM Providers' },
  { name: 'OPENROUTER_API_KEY', label: 'OpenRouter', signup: 'https://openrouter.ai/keys', group: 'LLM Providers' },
  { name: 'REPLICATE_API_TOKEN', label: 'Replicate', signup: 'https://replicate.com/account/api-tokens', group: 'LLM Providers' },
  { name: 'HF_TOKEN', label: 'Hugging Face', signup: 'https://huggingface.co/settings/tokens', group: 'LLM Providers' },
  { name: 'TOGETHER_API_KEY', label: 'Together AI', signup: 'https://api.together.ai/settings/api-keys', group: 'LLM Providers' },
  { name: 'SAMBANOVA_API_KEY', label: 'SambaNova Cloud', signup: 'https://cloud.sambanova.ai/apis', group: 'LLM Providers' },
  { name: 'FIREWORKS_API_KEY', label: 'Fireworks AI', signup: 'https://fireworks.ai/account/api-keys', group: 'LLM Providers' },
  { name: 'DEEPINFRA_API_KEY', label: 'DeepInfra', signup: 'https://deepinfra.com/dash/api_keys', group: 'LLM Providers' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI', signup: 'https://platform.openai.com/api-keys', group: 'LLM Providers' },
  { name: 'HARNESS_SMTP_HOST', label: 'SMTP Host', placeholder: 'smtp.gmail.com', group: 'Email (SMTP)' },
  { name: 'HARNESS_SMTP_PORT', label: 'SMTP Port', placeholder: '587', group: 'Email (SMTP)' },
  { name: 'HARNESS_SMTP_USER', label: 'SMTP Username', placeholder: 'you@gmail.com', group: 'Email (SMTP)' },
  { name: 'HARNESS_SMTP_PASS', label: 'SMTP Password', placeholder: 'App Password', group: 'Email (SMTP)' },
  { name: 'HARNESS_SMTP_FROM', label: 'From Address', placeholder: 'you@gmail.com', group: 'Email (SMTP)' },
];

async function loadApiKeys() {
  const list = document.getElementById('apiKeysList');
  if (!list) return;
  let status = {};
  try {
    const r = await fetch('/api/api-keys');
    const d = await r.json();
    status = d.keys || {};
  } catch(e){}
  list.innerHTML = '';
  let currentGroup = '';
  for (const field of REMOTE_API_KEY_FIELDS) {
    if (field.group && field.group !== currentGroup) {
      currentGroup = field.group;
      const heading = document.createElement('div');
      heading.className = 'setting-row';
      heading.innerHTML = '<strong style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim);margin-top:6px">' + esc(currentGroup) + '</strong>';
      list.appendChild(heading);
    }
    const info = status[field.name] || { configured: false, source: 'none' };
    const row = document.createElement('div');
    row.className = 'setting-row';
    const sourceBadge = info.source === 'env'
      ? '<span class="key-source-badge env">from env</span>'
      : info.source === 'file' ? '<span class="key-source-badge stored">stored</span>' : '';
    const signupLink = field.signup ? ' <a href="' + field.signup + '" target="_blank" rel="noopener" class="key-signup-link">get key</a>' : '';
    const isPassword = field.name === 'HARNESS_SMTP_PASS';
    const inputType = isPassword ? 'password' : (field.group === 'Email (SMTP)' && !isPassword ? 'text' : 'password');
    const placeholderText = info.configured ? '••••••••• (already set, leave blank to keep)' : (field.placeholder || 'paste key here');
    row.innerHTML = '<label>' + esc(field.label) + ' (' + esc(field.name) + ')' + sourceBadge + signupLink + '</label>'
      + '<input type="' + inputType + '" data-key-name="' + esc(field.name) + '" placeholder="' + esc(placeholderText) + '" autocomplete="off">';
    list.appendChild(row);
  }
}

async function saveApiKeys() {
  const inputs = document.querySelectorAll('#apiKeysList input[data-key-name]');
  const payload = {};
  let count = 0;
  for (const input of inputs) {
    const name = input.getAttribute('data-key-name');
    const value = input.value.trim();
    // Only POST keys the user actually filled in. Empty inputs preserve
    // existing value (server treats them as no-op for non-explicit empty).
    if (value) {
      payload[name] = value;
      count++;
      input.value = '';
    }
  }
  // When any SMTP field is being saved, auto-fill host and port defaults
  // so users don't have to manually type placeholder values.
  const smtpKeys = ['HARNESS_SMTP_HOST', 'HARNESS_SMTP_PORT', 'HARNESS_SMTP_USER', 'HARNESS_SMTP_PASS', 'HARNESS_SMTP_FROM'];
  const hasAnySMTP = smtpKeys.some(function(k) { return payload[k]; });
  if (hasAnySMTP) {
    if (!payload['HARNESS_SMTP_HOST']) {
      const hostField = REMOTE_API_KEY_FIELDS.find(function(f) { return f.name === 'HARNESS_SMTP_HOST'; });
      const hostInput = document.querySelector('input[data-key-name="HARNESS_SMTP_HOST"]');
      const existing = hostInput && hostInput.placeholder.includes('already set');
      if (!existing && hostField && hostField.placeholder) { payload['HARNESS_SMTP_HOST'] = hostField.placeholder; count++; }
    }
    if (!payload['HARNESS_SMTP_PORT']) {
      const portField = REMOTE_API_KEY_FIELDS.find(function(f) { return f.name === 'HARNESS_SMTP_PORT'; });
      const portInput = document.querySelector('input[data-key-name="HARNESS_SMTP_PORT"]');
      const existing = portInput && portInput.placeholder.includes('already set');
      if (!existing && portField && portField.placeholder) { payload['HARNESS_SMTP_PORT'] = portField.placeholder; count++; }
    }
  }
  const status = document.getElementById('apiKeysStatus');
  if (count === 0) {
    status.textContent = 'No new keys entered.';
    return;
  }
  status.textContent = 'Saving...';
  try {
    const r = await fetch('/api/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('Save failed');
    status.textContent = '✅ Saved ' + count + ' key(s). Refreshing model list...';
    await loadApiKeys();
    await loadModels();
    // Auto-test SMTP when any SMTP credential was saved.
    if (hasAnySMTP) {
      status.textContent = '✅ Saved. Verifying SMTP...';
      await testSmtpConnection();
      loadConnectorBadges();
    } else {
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  } catch (e) {
    status.textContent = '❌ ' + e.message;
  }
}

// ─── SMTP connection test ─────────────────────────────────────────────
async function testSmtpConnection() {
  const status = document.getElementById('apiKeysStatus');
  status.textContent = '⏳ Testing SMTP connection...';
  try {
    const r = await fetch('/api/smtp-test', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      status.textContent = '✅ SMTP connection successful!';
      setTimeout(() => { status.textContent = ''; }, 5000);
    } else {
      status.textContent = '❌ ' + (d.error || 'SMTP test failed.');
    }
  } catch (e) {
    status.textContent = '❌ ' + e.message;
  }
}

// ─── Email drafts & sent preview ──────────────────────────────────────
async function loadEmailList() {
  const list = document.getElementById('emailList');
  const statusEl = document.getElementById('emailListStatus');
  if (!list) return;
  try {
    const r = await fetch('/api/email/list');
    const d = await r.json();
    const emails = d.emails || [];
    if (emails.length === 0) {
      list.innerHTML = '<div class="setting-row settings-note">No drafts or sent emails yet.</div>';
      return;
    }
    list.innerHTML = '';
    for (const email of emails) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.style.cursor = 'pointer';
      const badge = email.folder === 'sent'
        ? '<span class="key-source-badge stored">sent</span>'
        : '<span class="key-source-badge env">draft</span>';
      const date = new Date(email.modified).toLocaleString();
      row.innerHTML = '<span style="font-size:12px">' + badge + ' ' + esc(email.name) + '</span><span style="font-size:10px;color:var(--text-dim);margin-left:auto">' + esc(date) + '</span>';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      const viewBtn = document.createElement('span');
      viewBtn.style.cssText = 'cursor:pointer;flex:1;overflow:hidden;text-overflow:ellipsis';
      viewBtn.innerHTML = row.innerHTML;
      row.innerHTML = '';
      viewBtn.addEventListener('click', () => previewEmail(email.folder, email.name));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-sm';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete';
      delBtn.style.cssText = 'flex-shrink:0;padding:2px 6px;font-size:11px';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteEmail(email.folder, email.name); });
      row.appendChild(viewBtn);
      if (email.folder === 'drafts') {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-sm';
        editBtn.textContent = '✏️';
        editBtn.title = 'Edit & Send';
        editBtn.style.cssText = 'flex-shrink:0;padding:2px 6px;font-size:11px';
        editBtn.addEventListener('click', (e) => { e.stopPropagation(); loadDraftIntoCompose(email.folder, email.name); });
        row.appendChild(editBtn);
      }
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    if (statusEl) statusEl.textContent = emails.length + ' email(s) found.';
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ ' + e.message;
  }
}

async function previewEmail(folder, name) {
  const preview = document.getElementById('emailPreview');
  if (!preview) return;
  try {
    const r = await fetch('/api/email/read?folder=' + encodeURIComponent(folder) + '&name=' + encodeURIComponent(name));
    const d = await r.json();
    if (d.error) {
      preview.textContent = 'Error: ' + d.error;
    } else {
      preview.textContent = d.content;
    }
    preview.style.display = 'block';
  } catch (e) {
    preview.textContent = 'Error: ' + e.message;
    preview.style.display = 'block';
  }
}

async function loadDraftIntoCompose(folder, name) {
  try {
    var r = await fetch('/api/email/read?folder=' + encodeURIComponent(folder) + '&name=' + encodeURIComponent(name));
    var d = await r.json();
    if (d.error) return;
    var content = d.content || '';
    // Parse .eml-style headers: To, Subject, then body after blank line.
    var toVal = '';
    var subjectVal = '';
    var bodyVal = content;
    var headerEnd = content.indexOf('\r\n\r\n');
    if (headerEnd === -1) headerEnd = content.indexOf('\n\n');
    if (headerEnd !== -1) {
      var headerBlock = content.substring(0, headerEnd);
      bodyVal = content.substring(headerEnd).replace(/^[\r\n]+/, '');
      var toMatch = headerBlock.match(/^To:\s*(.+)$/mi);
      var subMatch = headerBlock.match(/^Subject:\s*(.+)$/mi);
      if (toMatch) toVal = toMatch[1].trim();
      if (subMatch) subjectVal = subMatch[1].trim();
    }
    var toInput = document.getElementById('composeToInput');
    var subjectInput = document.getElementById('composeSubjectInput');
    var bodyInput = document.getElementById('composeBodyInput');
    if (toInput) toInput.value = toVal;
    if (subjectInput) subjectInput.value = subjectVal;
    if (bodyInput) bodyInput.value = bodyVal;
    // Open the compose details section.
    var details = bodyInput && bodyInput.closest('details');
    if (details) details.open = true;
    var status = document.getElementById('composeStatus');
    if (status) status.textContent = '📝 Draft loaded — edit and send.';
  } catch (e) {
    var status2 = document.getElementById('composeStatus');
    if (status2) status2.textContent = '❌ ' + (e.message || e);
  }
}

async function deleteEmail(folder, name) {
  try {
    const r = await fetch('/api/email/delete?folder=' + encodeURIComponent(folder) + '&name=' + encodeURIComponent(name), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      const preview = document.getElementById('emailPreview');
      if (preview) preview.style.display = 'none';
      await loadEmailList();
    } else {
      const statusEl = document.getElementById('emailListStatus');
      if (statusEl) statusEl.textContent = '❌ ' + (d.error || 'Delete failed.');
    }
  } catch (e) {
    const statusEl = document.getElementById('emailListStatus');
    if (statusEl) statusEl.textContent = '❌ ' + e.message;
  }
}

function toggleComposeFormat() {
  var formatRadio = document.querySelector('input[name="composeFormat"]:checked');
  var isHtml = formatRadio && formatRadio.value === 'html';
  var textarea = document.getElementById('composeBodyInput');
  var richWrap = document.getElementById('composeRichWrap');
  var richBody = document.getElementById('composeRichBody');
  if (isHtml) {
    if (textarea) textarea.style.display = 'none';
    if (richWrap) richWrap.style.display = 'block';
    // Copy plain text into rich editor if switching.
    if (richBody && textarea && textarea.value && !richBody.innerHTML.trim()) {
      richBody.innerText = textarea.value;
    }
  } else {
    if (textarea) textarea.style.display = '';
    if (richWrap) richWrap.style.display = 'none';
    // Copy rich content back to textarea if switching.
    if (textarea && richBody && richBody.innerText.trim() && !textarea.value.trim()) {
      textarea.value = richBody.innerText;
    }
  }
}

async function insertComposeLink() {
  var url = await promptToast('URL:');
  if (!url) return;
  var text = await promptToast('Link text:', url);
  document.execCommand('insertHTML', false, '<a href="' + url.replace(/"/g, '&quot;') + '">' + (text || url).replace(/</g, '&lt;') + '</a>');
}

async function sendComposedEmail() {
  var toInput = document.getElementById('composeToInput');
  var subjectInput = document.getElementById('composeSubjectInput');
  var bodyInput = document.getElementById('composeBodyInput');
  var richBody = document.getElementById('composeRichBody');
  var attachInput = document.getElementById('composeAttachments');
  var status = document.getElementById('composeStatus');
  if (!toInput || !subjectInput || !status) return;
  var formatRadio = document.querySelector('input[name="composeFormat"]:checked');
  var isHtml = formatRadio && formatRadio.value === 'html';
  var to = toInput.value.trim();
  var subject = subjectInput.value.trim();
  var body = isHtml && richBody ? richBody.innerHTML.trim() : (bodyInput ? bodyInput.value.trim() : '');
  if (!to || !subject || !body) { status.textContent = '⚠️ To, subject, and body are required.'; return; }
  status.textContent = 'Sending...';
  try {
    var attachments = [];
    if (attachInput && attachInput.files && attachInput.files.length > 0) {
      for (var i = 0; i < attachInput.files.length; i++) {
        var file = attachInput.files[i];
        if (file.size > 10 * 1024 * 1024) { status.textContent = '⚠️ Attachment "' + file.name + '" exceeds 10 MB limit.'; return; }
        var b64 = await new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onload = function() { resolve(reader.result.split(',')[1]); };
          reader.onerror = function() { reject(new Error('Failed to read ' + file.name)); };
          reader.readAsDataURL(file);
        });
        attachments.push({ filename: file.name, content: b64 });
      }
    }
    var payload = { to: to, subject: subject, body: body };
    if (isHtml) payload.html = true;
    if (attachments.length > 0) payload.attachments = attachments;
    var r = await fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    var d = await r.json();
    if (d.ok) {
      status.textContent = '✅ Sent! Message ID: ' + (d.messageId || '(unknown)');
      toInput.value = ''; subjectInput.value = ''; if (bodyInput) bodyInput.value = '';
      if (richBody) richBody.innerHTML = '';
      if (attachInput) attachInput.value = '';
      var previewsWrap = document.getElementById('composeAttachmentPreviews');
      if (previewsWrap) { previewsWrap.innerHTML = ''; previewsWrap.style.display = 'none'; }
      await loadEmailList();
    } else {
      status.textContent = '❌ ' + (d.error || 'Send failed.');
    }
  } catch (e) {
    status.textContent = '❌ ' + (e.message || e);
  }
}

// ─── Email templates ──────────────────────────────────────────────────

var _composeAutoSaveTimer = null;

function startComposeAutoSave() {
  if (_composeAutoSaveTimer) return;
  _composeAutoSaveTimer = setInterval(autoSaveComposeDraft, 30000);
}

async function autoSaveComposeDraft() {
  var toInput = document.getElementById('composeToInput');
  var subjectInput = document.getElementById('composeSubjectInput');
  var bodyInput = document.getElementById('composeBodyInput');
  var richBody = document.getElementById('composeRichBody');
  var formatRadio = document.querySelector('input[name="composeFormat"]:checked');
  var isHtml = formatRadio && formatRadio.value === 'html';
  var to = toInput ? toInput.value.trim() : '';
  var subject = subjectInput ? subjectInput.value.trim() : '';
  var body = isHtml && richBody ? richBody.innerHTML.trim() : (bodyInput ? bodyInput.value.trim() : '');
  if (!to && !subject && !body) return;
  try {
    await fetch('/api/email/draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: to, subject: subject, body: body }),
    });
  } catch (_e) { /* silent — auto-save is best-effort */ }
}

// Start auto-save when compose section is opened.
document.addEventListener('toggle', function(e) {
  if (e.target && e.target.querySelector && e.target.querySelector('#composeToInput')) {
    if (e.target.open) startComposeAutoSave();
  }
}, true);

async function loadEmailTemplates() {
  var select = document.getElementById('composeTemplateSelect');
  if (!select) return;
  try {
    var r = await fetch('/api/email/templates');
    var d = await r.json();
    var templates = d.templates || [];
    select.innerHTML = '<option value="">— Templates (' + templates.length + ') —</option>';
    // Group templates by category.
    var groups = {};
    var uncategorized = [];
    for (var t of templates) {
      if (t.category) {
        if (!groups[t.category]) groups[t.category] = [];
        groups[t.category].push(t);
      } else {
        uncategorized.push(t);
      }
    }
    function appendTemplateOption(parent, t) {
      var opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      opt.dataset.to = t.to || '';
      opt.dataset.subject = t.subject || '';
      opt.dataset.body = t.body || '';
      opt.dataset.html = t.html ? '1' : '';
      opt.dataset.category = t.category || '';
      parent.appendChild(opt);
    }
    var categoryKeys = Object.keys(groups).sort();
    for (var cat of categoryKeys) {
      var og = document.createElement('optgroup');
      og.label = cat;
      for (var t of groups[cat]) appendTemplateOption(og, t);
      select.appendChild(og);
    }
    for (var t of uncategorized) appendTemplateOption(select, t);
  } catch (_e) { /* silent */ }
}

function loadSelectedTemplate() {
  var select = document.getElementById('composeTemplateSelect');
  if (!select || !select.value) return;
  var opt = select.selectedOptions[0];
  if (!opt) return;
  var toInput = document.getElementById('composeToInput');
  var subjectInput = document.getElementById('composeSubjectInput');
  var bodyInput = document.getElementById('composeBodyInput');
  if (toInput) toInput.value = opt.dataset.to || '';
  if (subjectInput) subjectInput.value = opt.dataset.subject || '';
  if (bodyInput) bodyInput.value = opt.dataset.body || '';
  if (opt.dataset.html === '1') {
    var htmlRadio = document.querySelector('input[name="composeFormat"][value="html"]');
    if (htmlRadio) htmlRadio.checked = true;
  } else {
    var plainRadio = document.querySelector('input[name="composeFormat"][value="plain"]');
    if (plainRadio) plainRadio.checked = true;
  }
  var status = document.getElementById('composeStatus');
  if (status) status.textContent = '📄 Template "' + opt.value + '" loaded.';
}

async function saveAsTemplate() {
  var toInput = document.getElementById('composeToInput');
  var subjectInput = document.getElementById('composeSubjectInput');
  var bodyInput = document.getElementById('composeBodyInput');
  var status = document.getElementById('composeStatus');
  var name = await promptToast('Template name:');
  if (!name || !name.trim()) return;
  var category = await promptToast('Category (optional, e.g. Work, Personal):');
  var formatRadio = document.querySelector('input[name="composeFormat"]:checked');
  var isHtml = formatRadio && formatRadio.value === 'html';
  try {
    var payload = {
      name: name.trim(),
      to: toInput ? toInput.value.trim() : '',
      subject: subjectInput ? subjectInput.value.trim() : '',
      body: bodyInput ? bodyInput.value.trim() : '',
      html: isHtml || undefined,
    };
    if (category && category.trim()) payload.category = category.trim();
    var r = await fetch('/api/email/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var d = await r.json();
    if (d.ok) {
      if (status) status.textContent = '💾 Template "' + name.trim() + '" saved.';
      await loadEmailTemplates();
    } else {
      if (status) status.textContent = '❌ ' + (d.error || 'Save failed.');
    }
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || e);
  }
}

async function deleteSelectedTemplate() {
  var select = document.getElementById('composeTemplateSelect');
  var status = document.getElementById('composeStatus');
  if (!select || !select.value) { if (status) status.textContent = '⚠️ Select a template first.'; return; }
  var name = select.value;
  try {
    var r = await fetch('/api/email/templates?name=' + encodeURIComponent(name), { method: 'DELETE' });
    var d = await r.json();
    if (d.ok) {
      if (status) status.textContent = '🗑 Template "' + name + '" deleted.';
      await loadEmailTemplates();
    }
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || e);
  }
}

// ─── Attachment preview thumbnails ────────────────────────────────────

function renderAttachmentPreviews() {
  var input = document.getElementById('composeAttachments');
  var wrap = document.getElementById('composeAttachmentPreviews');
  if (!input || !wrap) return;
  wrap.innerHTML = '';
  var files = input.files;
  if (!files || files.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  for (var i = 0; i < files.length; i++) {
    (function(file) {
      var card = document.createElement('div');
      card.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:10px;color:var(--text-dim);max-width:160px';
      if (file.type && file.type.startsWith('image/')) {
        var img = document.createElement('img');
        img.style.cssText = 'width:32px;height:32px;object-fit:cover;border-radius:3px;flex-shrink:0';
        var reader = new FileReader();
        reader.onload = function() { img.src = reader.result; };
        reader.readAsDataURL(file);
        card.appendChild(img);
      } else {
        var icon = document.createElement('span');
        icon.style.cssText = 'font-size:18px;flex-shrink:0';
        icon.textContent = file.name.toLowerCase().endsWith('.pdf') ? '📄' : '📎';
        card.appendChild(icon);
      }
      var name = document.createElement('span');
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      var sizeKB = (file.size / 1024).toFixed(0);
      name.textContent = file.name + ' (' + sizeKB + ' KB)';
      name.title = file.name;
      card.appendChild(name);
      wrap.appendChild(card);
    })(files[i]);
  }
}

// ─── Email search/filter ──────────────────────────────────────────────

var _emailListItems = [];

function filterEmailList() {
  var input = document.getElementById('emailSearchInput');
  var query = input ? input.value.trim().toLowerCase() : '';
  var list = document.getElementById('emailList');
  if (!list) return;
  var rows = list.children;
  for (var i = 0; i < rows.length; i++) {
    var text = (rows[i].textContent || '').toLowerCase();
    rows[i].style.display = text.includes(query) ? '' : 'none';
  }
}

// ─── File-write redirect rules ────────────────────────────────────────
// Matches the Settings panel section "File-Write Redirects". Each rule
// routes any file_write whose path matches `match` (glob: * = chars, ** =
// across separators) into `redirect` (absolute or project-relative dir).
// First matching rule wins. Persisted to .harness/file-write-redirects.json
// via POST /api/file-redirects which calls clearFileWriteRedirectCache()
// so changes take effect on the next file_write without a server restart.

// ─── Simple "all agent files go here" folder ─────────────────────────
// One-input version of the redirect feature. Persists to the standard
// /api/settings endpoint as `agentOutputDir`. Empty string = use the
// built-in default (<project>/agent-outputs). Power users can still set
// per-pattern overrides in the Advanced sub-section below.

async function loadAgentOutputDir() {
  const input = document.getElementById('agentOutputDirInput');
  const status = document.getElementById('agentOutputDirStatus');
  if (!input) return;
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) throw new Error('settings fetch failed (' + r.status + ')');
    const d = await r.json();
    input.value = typeof d.agentOutputDir === 'string' ? d.agentOutputDir : '';
    if (status) status.textContent = input.value
      ? 'Currently using: ' + input.value
      : 'Currently using default: <project>/agent-outputs';
  } catch (e) {
    if (status) status.textContent = '⚠ ' + e.message;
  }
}

async function saveAgentOutputDir() {
  const input = document.getElementById('agentOutputDirInput');
  const status = document.getElementById('agentOutputDirStatus');
  if (!input) return;
  const value = input.value.trim();
  if (status) status.textContent = 'Saving...';
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentOutputDir: value }),
    });
    if (!r.ok) throw new Error('save failed (' + r.status + ')');
    if (status) status.textContent = value
      ? '✅ Saved. New agent files now go to: ' + value + ' (also writable by file_write)'
      : '✅ Cleared. Using default: <project>/agent-outputs';
    setTimeout(() => loadAgentOutputDir(), 2000);
  } catch (e) {
    if (status) status.textContent = '❌ ' + e.message;
  }
}

// ─── Telegram settings ─────────────────────────────────────────────

async function loadTelegramStatus() {
  const status = document.getElementById('telegramStatus');
  const tokenInput = document.getElementById('telegramTokenInput');
  const chatIdsInput = document.getElementById('telegramChatIdsInput');
  if (!status) return;
  try {
    const [statusRes, settingsRes] = await Promise.all([
      fetch('/api/telegram/status'),
      fetch('/api/settings'),
    ]);
    const st = await readApiJson(statusRes, 'Telegram status API');
    const settings = await readApiJson(settingsRes, 'Settings API');
    if (tokenInput) tokenInput.value = settings.telegramBotToken || '';
    if (chatIdsInput) chatIdsInput.value = settings.telegramAllowedChatIds || '';
    status.innerHTML = st.running ? '✅ Bot is running' + (st.pollingLock && st.pollingLock.pid ? ' (PID ' + st.pollingLock.pid + ')' : '') : st.configured ? '⚠️ Token set but bot not running — click <strong>Connect</strong> to start' : '💡 Not configured — get a token from <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, paste it above, and click Connect';
  } catch (e) {
    status.textContent = '⚠ Could not load status: ' + (e.message || e);
  }
}

async function saveTelegramToken() {
  const tokenInput = document.getElementById('telegramTokenInput');
  const chatIdsInput = document.getElementById('telegramChatIdsInput');
  const status = document.getElementById('telegramStatus');
  if (!tokenInput || !status) return;
  status.textContent = 'Connecting...';
  try {
    const r = await fetch('/api/telegram/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenInput.value.trim(), allowedChatIds: chatIdsInput?.value.trim() || '' }),
    });
    const data = await readApiJson(r, 'Telegram token API');
    status.textContent = data.running ? '✅ Bot connected and running!' : '✅ Token saved (bot stopped — set token to start)';
    loadConnectorBadges();
  } catch (e) {
    status.textContent = '❌ ' + (e.message || e);
  }
}

async function stopTelegram() {
  const status = document.getElementById('telegramStatus');
  if (!status) return;
  try {
    const r = await fetch('/api/telegram/stop', { method: 'POST' });
    await readApiJson(r, 'Telegram stop API');
    status.textContent = 'Bot stopped.';
  } catch (e) {
    status.textContent = '⚠ ' + (e.message || e);
  }
}

async function loadConnectorStatuses() {
  await Promise.allSettled([loadDiscordStatus(), loadSlackStatus(), loadWhatsAppStatus(), loadWebhooks(), loadGovernedLoop(), loadBrowserAuditLog(), loadBrowserSessions(), loadConnectorBadges(), loadConnectorGallery()]);
}

async function loadConnectorBadges() {
  var container = document.getElementById('connectorBadges');
  if (!container) return;
  try {
    var r = await fetch('/api/connectors/status');
    var data = await r.json();
    var connectors = data.connectors || {};
    var labels = { telegram: '📱', discord: '🎮', slack: '💬', whatsapp: '📲', smtp: '📧' };
    var titles = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', smtp: 'Email (SMTP)' };
    var sectionIds = { telegram: 'settingsTelegram', discord: 'settingsDiscord', slack: 'settingsSlack', whatsapp: 'settingsWhatsapp', smtp: 'settingsSmtp' };
    var html = '';
    for (var key of Object.keys(labels)) {
      var c = connectors[key];
      if (!c) continue;
      var on = c.configured || c.running || false;
      html += '<span class="connector-badge ' + (on ? 'cb-on' : 'cb-off') + '" title="' + titles[key] + ': ' + (on ? 'configured' : 'not configured') + ' (click to configure)" data-section="' + sectionIds[key] + '" style="cursor:pointer"><span class="cb-dot"></span>' + labels[key] + '</span>';
    }
    if (html) { container.innerHTML = html; container.classList.remove('hidden-by-default'); }
    else { container.classList.add('hidden-by-default'); }
    container.onclick = function(e) {
      var badge = e.target.closest('.connector-badge');
      if (!badge) return;
      var sectionId = badge.getAttribute('data-section');
      if (!sectionId) return;
      var panel = document.getElementById('rightPanel');
      if (panel && panel.classList.contains('hidden')) toggleRight();
      setTimeout(function() {
        var section = document.getElementById(sectionId);
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    };
  } catch (_e) {
    // Silently skip badges on error — not critical.
  }
}

// Renders the connector gallery (Settings → 🔌 Connectors) as cards built from
// the design-stage connector contracts (/api/connectors/contracts) merged with
// live status (/api/connectors/status). Cards honestly distinguish live
// connectors, email-backed providers (Gmail/Outlook work now via SMTP/IMAP),
// and design-stage contracts whose live integration is not built yet.
async function loadConnectorGallery() {
  var container = document.getElementById('connectorGallery');
  if (!container) return;
  var statusEl = document.getElementById('connectorGalleryStatus');
  try {
    var results = await Promise.all([
      fetch('/api/connectors/contracts'),
      fetch('/api/connectors/status'),
    ]);
    var contractsData = await results[0].json();
    var statusData = await results[1].json();
    var contracts = (contractsData && contractsData.contracts) || [];
    var statuses = (statusData && statusData.connectors) || {};

    // Presentation metadata per connector id: icon, the settings section to
    // jump to when configurable, and whether email is already live for it.
    var meta = {
      google: { icon: '✉️', section: 'settingsSmtp', emailLive: true, note: 'Gmail send/read works now via SMTP/IMAP. OAuth + calendar is design-stage.' },
      microsoft: { icon: '📅', section: 'settingsSmtp', emailLive: true, note: 'Outlook send/read works now via SMTP/IMAP. OAuth + calendar is design-stage.' },
      github: { icon: '🐙', section: null, emailLive: false, note: '' },
      notion: { icon: '📝', section: null, emailLive: false, note: '' },
      telegram: { icon: '📱', section: 'settingsTelegram', emailLive: false, note: '' },
      slack: { icon: '💬', section: 'settingsSlack', emailLive: false, note: '' },
    };

    var html = '';
    for (var i = 0; i < contracts.length; i++) {
      var c = contracts[i];
      var m = meta[c.id] || { icon: '🔌', section: null, emailLive: false, note: '' };
      var live = statuses[c.id];
      var pill;
      if (live && (live.ready || live.configured || live.running)) {
        pill = '<span class="conn-pill conn-on">● Connected</span>';
      } else if (m.emailLive) {
        pill = '<span class="conn-pill conn-partial">◐ Email live · OAuth planned</span>';
      } else {
        pill = '<span class="conn-pill conn-off">○ Design stage</span>';
      }
      var ops = (c.operations || []).map(function (o) { return '<span class="conn-op">' + esc(o.name) + '</span>'; }).join('');
      var secrets = (c.requiredSecrets || []).join(', ');
      var configBtn = m.section
        ? '<button class="btn-sm" data-section="' + m.section + '" onclick="scrollToConnectorSection(this)">Configure</button>'
        : '';
      html += '<div class="connector-card">'
        + '<div class="conn-head"><span class="conn-icon">' + m.icon + '</span><span class="conn-label">' + esc(c.label) + '</span>' + pill + '</div>'
        + '<div class="conn-purpose">' + esc(c.purpose || '') + '</div>'
        + (ops ? '<div class="conn-ops">' + ops + '</div>' : '')
        + (secrets ? '<div class="conn-secrets">Needs: ' + esc(secrets) + '</div>' : '')
        + (m.note ? '<div class="conn-note">' + esc(m.note) + '</div>' : '')
        + (configBtn ? '<div class="conn-actions">' + configBtn + '</div>' : '')
        + '</div>';
    }
    container.innerHTML = html || '<div class="settings-note">No connectors available.</div>';
    if (statusEl) statusEl.textContent = '';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not load connectors: ' + (e.message || e);
  }
}

function scrollToConnectorSection(btn) {
  var sectionId = btn.getAttribute('data-section');
  if (!sectionId) return;
  var section = document.getElementById(sectionId);
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadDiscordStatus() {
  const status = document.getElementById('discordStatus');
  const tokenInput = document.getElementById('discordTokenInput');
  const channelIdsInput = document.getElementById('discordChannelIdsInput');
  if (!status) return;
  try {
    const [statusRes, settingsRes] = await Promise.all([fetch('/api/discord/status'), fetch('/api/settings')]);
    const st = await readApiJson(statusRes, 'Discord status API');
    const settings = await readApiJson(settingsRes, 'Settings API');
    if (tokenInput) tokenInput.value = '';
    if (channelIdsInput) channelIdsInput.value = settings.discordAllowedChannelIds || '';
    status.innerHTML = esc(st.running ? 'Bot is running.' : st.configured ? 'Token set. Click Connect to start the bridge.' : 'Not configured.') + connectorSourceBadge(settings.connectorSecretStatus?.discordBotToken);
  } catch (e) {
    status.textContent = 'Could not load Discord status: ' + (e.message || e);
  }
}

async function saveDiscordToken() {
  const tokenInput = document.getElementById('discordTokenInput');
  const channelIdsInput = document.getElementById('discordChannelIdsInput');
  const status = document.getElementById('discordStatus');
  if (!tokenInput || !status) return;
  status.textContent = 'Connecting...';
  try {
    const response = await fetch('/api/discord/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokenInput.value.trim(), channelIds: channelIdsInput?.value.trim() || '' }) });
    const data = await readApiJson(response, 'Discord token API');
    status.textContent = data.ok ? 'Discord token saved. Bridge is starting.' : 'Discord token saved, but bridge did not start.';
    loadConnectorBadges();
  } catch (e) {
    status.textContent = 'Discord setup failed: ' + (e.message || e);
  }
}

async function stopDiscord() {
  const status = document.getElementById('discordStatus');
  if (!status) return;
  try {
    const response = await fetch('/api/discord/stop', { method: 'POST' });
    await readApiJson(response, 'Discord stop API');
    status.textContent = 'Discord bot stopped.';
  } catch (e) {
    status.textContent = 'Could not stop Discord bot: ' + (e.message || e);
  }
}

async function loadSlackStatus() {
  const status = document.getElementById('slackStatus');
  const input = document.getElementById('slackWebhookInput');
  if (!status) return;
  try {
    const [statusRes, settingsRes] = await Promise.all([fetch('/api/slack/status'), fetch('/api/settings')]);
    const st = await readApiJson(statusRes, 'Slack status API');
    const settings = await readApiJson(settingsRes, 'Settings API');
    if (input) input.value = '';
    status.innerHTML = esc(st.ready ? 'Slack notifications are ready.' : st.message || 'Slack is not configured.') + connectorSourceBadge(settings.connectorSecretStatus?.slackWebhookUrl);
  } catch (e) {
    status.textContent = 'Could not load Slack status: ' + (e.message || e);
  }
}

async function saveSlackWebhook() {
  const input = document.getElementById('slackWebhookInput');
  const status = document.getElementById('slackStatus');
  if (!input || !status) return;
  status.textContent = 'Saving...';
  try {
    const response = await fetch('/api/slack/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookUrl: input.value.trim() }) });
    const data = await readApiJson(response, 'Slack webhook API');
    status.textContent = data.status?.message || 'Slack settings saved.';
    loadConnectorBadges();
  } catch (e) {
    status.textContent = 'Slack setup failed: ' + (e.message || e);
  }
}

// ── Outgoing webhooks (generic) ──────────────────────────────────────────────

async function loadWebhooks() {
  const list = document.getElementById('webhookList');
  if (!list) return;
  try {
    const [hooksRes, deadRes] = await Promise.all([fetch('/api/webhooks'), fetch('/api/webhooks/dead-letter')]);
    const hooks = (await readApiJson(hooksRes, 'Webhooks API')).webhooks || [];
    const dead = (await readApiJson(deadRes, 'Dead-letter API')).deadLetters || [];
    if (hooks.length === 0) {
      list.innerHTML = '<em>No webhooks configured.</em>';
    } else {
      list.innerHTML = hooks.map(function (w) {
        const d = w.lastDelivery;
        let badge = '<span class="muted">no deliveries yet</span>';
        if (d) {
          const when = new Date(d.at).toLocaleString();
          badge = d.ok
            ? '<span style="color:var(--ok,#3a3)">✓ delivered' + (d.status ? ' (' + d.status + ')' : '') + ' · ' + esc(when) + '</span>'
            : '<span style="color:var(--err,#c33)">✗ failed' + (d.status ? ' (' + d.status + ')' : '') + ' after ' + d.attempts + ' attempt(s) · ' + esc(when) + '</span>';
        }
        const history = w.recentDeliveries || [];
        let timeline = '';
        if (history.length > 0) {
          const dots = history.map(function (h) {
            const label = (h.ok ? 'ok' : 'failed') + (h.status ? ' ' + h.status : '') + ' · ' + new Date(h.at).toLocaleString();
            return '<span title="' + esc(label) + '" style="color:' + (h.ok ? 'var(--ok,#3a3)' : 'var(--err,#c33)') + '">●</span>';
          }).join('');
          const failures = history.filter(function (h) { return !h.ok; }).length;
          const flap = (failures > 0 && failures < history.length) ? ' <span style="color:var(--err,#c33)" title="mixed success/failure">⚠ flapping</span>' : '';
          timeline = '<br><span class="muted" style="letter-spacing:2px">' + dots + '</span>' + flap;
        }
        const eventsLabel = (w.events && w.events.length > 0) ? esc(w.events.join(', ')) : 'all events';
        return '<div class="setting-row" style="justify-content:space-between;gap:8px;align-items:center">'
          + '<div style="overflow:hidden;text-overflow:ellipsis"><code>' + esc(w.url) + '</code>' + (w.enabled === false ? ' <span class="muted">(disabled)</span>' : '') + '<br><span class="muted">events: ' + eventsLabel + '</span><br>' + badge + timeline + '</div>'
          + '<span style="white-space:nowrap"><button class="btn-sm" onclick="toggleWebhook(\'' + esc(w.id) + '\',' + (w.enabled === false) + ')">' + (w.enabled === false ? 'Enable' : 'Disable') + '</button> '
          + '<button class="btn-sm" onclick="editWebhookEvents(\'' + esc(w.id) + '\',\'' + esc((w.events || []).join(',')) + '\')">Events</button> '
          + '<button class="btn-sm" onclick="testWebhook(\'' + esc(w.id) + '\')">Test</button> '
          + '<button class="btn-sm" onclick="removeWebhook(\'' + esc(w.id) + '\')">Delete</button></span></div>';
      }).join('');
    }
    renderDeadLetters(dead);
  } catch (e) {
    list.textContent = 'Could not load webhooks: ' + (e.message || e);
  }
}

function renderDeadLetters(dead) {
  const box = document.getElementById('webhookDeadLetters');
  if (!box) return;
  if (!dead || dead.length === 0) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="settings-note" style="margin-top:8px"><strong>Failed deliveries awaiting action (' + dead.length + ')</strong></div>'
    + dead.map(function (e) {
      const when = new Date(e.failedAt).toLocaleString();
      const reason = e.error ? esc(e.error) : (e.status ? 'HTTP ' + e.status : 'unknown');
      return '<div class="setting-row" style="justify-content:space-between;gap:8px;align-items:center">'
        + '<div style="overflow:hidden;text-overflow:ellipsis"><code>' + esc(e.event) + '</code> → <code>' + esc(e.url) + '</code><br>'
        + '<span style="color:var(--err,#c33)">' + reason + ' · ' + esc(when) + '</span></div>'
        + '<span style="white-space:nowrap"><button class="btn-sm primary" onclick="redeliverDeadLetter(\'' + esc(e.id) + '\')">Redeliver</button> '
        + '<button class="btn-sm" onclick="discardDeadLetter(\'' + esc(e.id) + '\')">Discard</button></span></div>';
    }).join('');
}

async function addWebhook() {
  const urlInput = document.getElementById('webhookUrlInput');
  const secretInput = document.getElementById('webhookSecretInput');
  const eventsInput = document.getElementById('webhookEventsInput');
  const list = document.getElementById('webhookList');
  if (!urlInput || !urlInput.value.trim()) { if (list) list.textContent = 'A webhook URL is required.'; return; }
  const events = (eventsInput?.value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  try {
    const res = await fetch('/api/webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value.trim(), secret: secretInput?.value.trim() || undefined, events }),
    });
    await readApiJson(res, 'Webhooks API');
    urlInput.value = ''; if (secretInput) secretInput.value = ''; if (eventsInput) eventsInput.value = '';
    loadWebhooks();
  } catch (e) {
    if (list) list.textContent = 'Could not add webhook: ' + (e.message || e);
  }
}

async function removeWebhook(id) {
  try {
    await fetch('/api/webhooks/' + encodeURIComponent(id), { method: 'DELETE' });
    loadWebhooks();
  } catch (e) {
    const list = document.getElementById('webhookList');
    if (list) list.textContent = 'Could not delete webhook: ' + (e.message || e);
  }
}

async function editWebhookEvents(id, currentCsv) {
  const input = window.prompt('Comma-separated event filter (leave blank for all events):', currentCsv || '');
  if (input === null) return; // cancelled
  const events = input.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const list = document.getElementById('webhookList');
  try {
    const res = await fetch('/api/webhooks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: events }),
    });
    await readApiJson(res, 'Webhooks API');
    loadWebhooks();
  } catch (e) {
    if (list) list.textContent = 'Could not update webhook events: ' + (e.message || e);
  }
}

async function toggleWebhook(id, enable) {
  const list = document.getElementById('webhookList');
  try {
    const res = await fetch('/api/webhooks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!enable }),
    });
    await readApiJson(res, 'Webhooks API');
    loadWebhooks();
  } catch (e) {
    if (list) list.textContent = 'Could not update webhook: ' + (e.message || e);
  }
}

async function testWebhook(id) {
  const list = document.getElementById('webhookList');
  try {
    const res = await fetch('/api/webhooks/' + encodeURIComponent(id) + '/test', { method: 'POST' });
    const data = await res.json().catch(function () { return {}; });
    if (res.ok) {
      if (list) list.insertAdjacentHTML('afterbegin', '<div class="settings-note" style="color:var(--ok,#3a3)">Test ping delivered' + (data.status ? ' (' + esc(String(data.status)) + ')' : '') + '.</div>');
    } else if (list) {
      list.insertAdjacentHTML('afterbegin', '<div class="settings-note" style="color:var(--err,#c33)">Test ping failed: ' + esc(data.error || data.status || res.status) + '</div>');
    }
  } catch (e) {
    if (list) list.textContent = 'Test ping failed: ' + (e.message || e);
  }
}

async function redeliverDeadLetter(id) {
  const box = document.getElementById('webhookDeadLetters');
  try {
    const res = await fetch('/api/webhooks/dead-letter/' + encodeURIComponent(id) + '/redeliver', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(function () { return {}; });
      if (box) box.insertAdjacentHTML('afterbegin', '<div class="settings-note" style="color:var(--err,#c33)">Redelivery failed: ' + esc(data.error || res.status) + '</div>');
    }
    loadWebhooks();
  } catch (e) {
    if (box) box.textContent = 'Redelivery failed: ' + (e.message || e);
  }
}

async function discardDeadLetter(id) {
  try {
    await fetch('/api/webhooks/dead-letter/' + encodeURIComponent(id), { method: 'DELETE' });
    loadWebhooks();
  } catch (e) {
    const box = document.getElementById('webhookDeadLetters');
    if (box) box.textContent = 'Could not discard: ' + (e.message || e);
  }
}

// ── Governed Agent Loop (working memory + review queue) ───────────────────────
async function loadBrowserAuditLog() {
  const box = document.getElementById('browserAuditLogList');
  if (!box) return;
  try {
    const res = await fetch('/api/browser/audit?limit=100');
    const data = await readApiJson(res, 'Browser audit API');
    const entries = data.entries || [];
    if (entries.length === 0) { box.innerHTML = '<div class="settings-note">No browser actions recorded yet.</div>'; return; }
    box.innerHTML = entries.map(function (e) {
      const ok = e.outcome === 'ok';
      const where = e.url ? esc(e.url) : (e.target ? esc(e.target) : '');
      const detail = e.detail ? ' <span class="muted">' + esc(e.detail) + '</span>' : '';
      return '<div class="setting-row">'
        + '<code>' + esc(e.tool || '') + '</code> '
        + (ok ? '✓' : '✕') + ' '
        + where + detail
        + ' <span class="muted">' + esc(e.ts || '') + ' · ' + esc(e.mode || '') + '</span>'
        + '</div>';
    }).join('');
  } catch (e) {
    box.textContent = 'Could not load browser audit log: ' + (e.message || e);
  }
}

async function loadBrowserSessions() {
  const box = document.getElementById('browserSessionsList');
  if (!box) return;
  try {
    const res = await fetch('/api/browser/sessions');
    const data = await readApiJson(res, 'Browser sessions API');
    const sessions = data.sessions || [];
    if (sessions.length === 0) { box.innerHTML = '<div class="settings-note">No saved sessions.</div>'; return; }
    box.innerHTML = sessions.map(function (s) {
      return '<div class="setting-row">'
        + '<code>' + esc(s.name) + '</code> '
        + '<span class="muted">' + (s.cookieCount || 0) + ' cookies · ' + (s.originCount || 0) + ' origins · ' + esc(s.savedAt || '') + '</span> '
        + '<button class="btn-sm" onclick="deleteBrowserSession(\'' + esc(s.name) + '\')">Delete</button>'
        + '</div>';
    }).join('');
  } catch (e) {
    box.textContent = 'Could not load browser sessions: ' + (e.message || e);
  }
}

async function saveBrowserSession() {
  const input = document.getElementById('browserSessionNameInput');
  const status = document.getElementById('browserSessionStatus');
  const name = input ? input.value.trim() : '';
  if (!name) { if (status) status.textContent = 'Enter a session name first.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/browser/sessions/' + encodeURIComponent(name), { method: 'POST' });
    const data = await readApiJson(res, 'Browser session save API');
    if (status) status.textContent = '✓ Saved ' + (data.session ? data.session.name : name);
    if (input) input.value = '';
    loadBrowserSessions();
  } catch (e) {
    if (status) status.textContent = '✕ ' + (e.message || e);
  }
}

async function deleteBrowserSession(name) {
  const status = document.getElementById('browserSessionStatus');
  try {
    const res = await fetch('/api/browser/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
    await readApiJson(res, 'Browser session delete API');
    if (status) status.textContent = 'Deleted ' + name;
    loadBrowserSessions();
  } catch (e) {
    if (status) status.textContent = '✕ ' + (e.message || e);
  }
}

function hydrateBrowserRedaction(redaction) {
  const values = document.getElementById('browserRedactValues');
  const origin = document.getElementById('browserRedactUrlOrigin');
  if (values) values.checked = redaction.redactValues !== false;
  if (origin) origin.checked = redaction.urlMode === 'origin';
}

async function saveBrowserRedaction() {
  const values = document.getElementById('browserRedactValues');
  const origin = document.getElementById('browserRedactUrlOrigin');
  const status = document.getElementById('browserRedactionStatus');
  if (status) status.textContent = 'Saving…';
  try {
    await updateSetting('browserRedaction', {
      redactValues: values ? values.checked : true,
      urlMode: origin && origin.checked ? 'origin' : 'full',
    });
    if (status) status.textContent = 'Saved.';
  } catch (e) {
    if (status) status.textContent = 'Save failed: ' + (e.message || e);
  }
}

async function loadGovernedLoop() {
  await Promise.allSettled([loadWorkingMemory(), loadReviewQueue(), loadReplayCandidates(), loadGovernanceMetrics()]);
}

async function loadWorkingMemory() {
  const box = document.getElementById('governedWorkingMemory');
  if (!box) return;
  try {
    const res = await fetch('/api/working-memory');
    const data = await readApiJson(res, 'Working-memory API');
    const wm = data.workingMemory;
    if (!wm) { box.innerHTML = '<em>No working memory yet (no session checkpoint).</em>'; return; }
    function listRows(label, arr) {
      if (!arr || arr.length === 0) return '';
      return '<div class="setting-row"><strong>' + label + ':</strong> ' + arr.map(function (s) { return esc(String(s)); }).join('; ') + '</div>';
    }
    box.innerHTML = '<div class="setting-row"><strong>Goal:</strong> ' + esc(wm.currentGoal || '(none)') + '</div>'
      + '<div class="setting-row"><strong>Next action:</strong> ' + esc(wm.nextAction || '(none)') + '</div>'
      + listRows('Assumptions', wm.assumptions)
      + listRows('Open questions', wm.openQuestions)
      + listRows('Decisions', wm.decisions)
      + listRows('Blocked', wm.blocked);
  } catch (e) {
    box.textContent = 'Could not load working memory: ' + (e.message || e);
  }
}

async function loadReviewQueue() {
  const box = document.getElementById('governedReviewQueue');
  if (!box) return;
  try {
    const res = await fetch('/api/review-queue?status=pending');
    const data = await readApiJson(res, 'Review-queue API');
    const items = data.items || [];
    renderReviewCount(items.length);
    if (items.length === 0) { box.innerHTML = '<div class="settings-note">Review queue is empty.</div>'; return; }
    box.innerHTML = '<div class="settings-note" style="margin-top:8px"><strong>Pending review (' + items.length + ')</strong></div>'
      + items.map(function (it) {
        const isBrain = it.kind === 'brain-update';
        const tag = isBrain ? 'brain-update' : 'needs-review';
        const primary = isBrain
          ? '<button class="btn-sm primary" onclick="resolveReviewItem(\'' + esc(it.id) + '\',\'approve\')">Approve</button> '
            + '<button class="btn-sm" onclick="resolveReviewItem(\'' + esc(it.id) + '\',\'reject\')">Reject</button>'
          : '<button class="btn-sm" onclick="resolveReviewItem(\'' + esc(it.id) + '\',\'drain\')">Drain</button> '
            + '<button class="btn-sm" onclick="resolveReviewItem(\'' + esc(it.id) + '\',\'reject\')">Dismiss</button>';
        return '<div class="setting-row" style="justify-content:space-between;gap:8px;align-items:center">'
          + '<div style="overflow:hidden;text-overflow:ellipsis"><code>' + esc(tag) + '</code> ' + esc(it.content)
          + (it.priorContent ? '<br><span class="muted">was: ' + esc(it.priorContent) + '</span>' : '')
          + '<br><span class="muted">' + esc(it.reason) + '</span></div>'
          + '<span style="white-space:nowrap">' + primary + '</span></div>';
      }).join('');
  } catch (e) {
    box.textContent = 'Could not load review queue: ' + (e.message || e);
  }
}

// Pending-review count badge in the session HUD. Stays silent at zero so the
// HUD is uncluttered until the governed loop actually stages something for
// human review. Refreshed live from loadReviewQueue (called on each
// governed_shadow chat event).
function renderReviewCount(count) {
  const el = document.getElementById('sessionHudReview');
  const sepEl = document.getElementById('sessionHudReviewSep');
  if (!el || !sepEl) return;
  const n = Number(count) || 0;
  if (n <= 0) {
    el.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  el.textContent = '🔍 ' + n + ' review';
  el.title = n + ' governed-loop item(s) awaiting your approval';
  el.style.display = '';
  sepEl.style.display = '';
}

async function resolveReviewItem(id, action) {
  const box = document.getElementById('governedReviewQueue');
  try {
    const res = await fetch('/api/review-queue/' + encodeURIComponent(id) + '/' + encodeURIComponent(action), { method: 'POST' });
    await readApiJson(res, 'Review-queue API');
    loadReviewQueue();
  } catch (e) {
    if (box) box.textContent = 'Could not update review item: ' + (e.message || e);
  }
}

// Drained needs-review answers staged for re-investigation. The list is a
// non-destructive peek at the replay seam; "Replay drained answers" re-asks
// each one through the harness and re-enqueues the fresh governed answer for
// review (it auto-approves nothing).
async function loadReplayCandidates() {
  const box = document.getElementById('governedReplayCandidates');
  if (!box) return;
  try {
    const res = await fetch('/api/replay-candidates');
    const data = await readApiJson(res, 'Replay-candidates API');
    const items = data.candidates || [];
    const btn = document.getElementById('governedReplayBtn');
    if (btn) btn.disabled = items.length === 0;
    if (items.length === 0) { box.innerHTML = '<div class="settings-note">No drained answers waiting to replay.</div>'; return; }
    box.innerHTML = '<div class="settings-note" style="margin-top:8px"><strong>Drained, awaiting replay (' + items.length + ')</strong></div>'
      + items.map(function (c) {
        return '<div class="setting-row" style="gap:8px;align-items:center">'
          + '<div style="overflow:hidden;text-overflow:ellipsis"><code>replay</code> ' + esc(c.content)
          + '<br><span class="muted">' + esc(c.reason) + '</span></div></div>';
      }).join('');
  } catch (e) {
    box.textContent = 'Could not load replay candidates: ' + (e.message || e);
  }
}

// Small lifetime readout of the governed-loop review queue: staged → approved /
// drained → re-queued. Stays quiet on failure so it never blocks the panel.
async function loadGovernanceMetrics() {
  const box = document.getElementById('governedMetrics');
  if (!box) return;
  try {
    const res = await fetch('/api/governed-metrics');
    const data = await readApiJson(res, 'Governed-metrics API');
    const m = data.metrics || {};
    box.innerHTML = '<div class="settings-note" style="margin-top:8px">'
      + '<strong>Loop metrics</strong> · staged ' + (m.staged || 0)
      + ' · approved ' + (m.approved || 0)
      + ' · drained ' + (m.drained || 0)
      + ' · rejected ' + (m.rejected || 0)
      + ' · re-queued ' + (m.reQueued || 0) + '</div>';
    renderLoopMetrics(m);
  } catch (e) {
    box.textContent = 'Could not load loop metrics: ' + (e.message || e);
  }
}

// Compact loop-throughput badge in the session HUD, beside the review badge:
// ✅ approved facts and ↻ replay re-queues. Stays hidden until the loop has
// actually approved or re-queued something, so the HUD stays uncluttered.
function renderLoopMetrics(m) {
  const el = document.getElementById('sessionHudLoop');
  const sepEl = document.getElementById('sessionHudLoopSep');
  if (!el || !sepEl) return;
  const approved = Number(m && m.approved) || 0;
  const reQueued = Number(m && m.reQueued) || 0;
  if (approved <= 0 && reQueued <= 0) {
    el.style.display = 'none';
    sepEl.style.display = 'none';
    return;
  }
  el.textContent = '✅ ' + approved + ' · ↻ ' + reQueued;
  el.title = approved + ' approved fact(s), ' + reQueued + ' replay re-queue(s)';
  el.style.display = '';
  sepEl.style.display = '';
}

async function runReplayNow() {
  const statusEl = document.getElementById('governedReplayStatus');
  const btn = document.getElementById('governedReplayBtn');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Replaying…';
  try {
    const res = await fetch('/api/replay-candidates/run', { method: 'POST' });
    const data = await readApiJson(res, 'Replay-run API');
    if (statusEl) statusEl.textContent = 'Replayed ' + (data.replayed || 0) + ', re-queued ' + (data.reQueued || 0) + '.';
    loadReviewQueue();
    loadReplayCandidates();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Replay failed: ' + (e.message || e);
    if (btn) btn.disabled = false;
  }
}

async function loadWhatsAppStatus() {
  const status = document.getElementById('whatsappStatus');
  const tokenInput = document.getElementById('whatsappAccessTokenInput');
  const phoneInput = document.getElementById('whatsappPhoneNumberIdInput');
  const recipientsInput = document.getElementById('whatsappAllowedRecipientsInput');
  if (!status) return;
  try {
    const [statusRes, settingsRes] = await Promise.all([fetch('/api/whatsapp/status'), fetch('/api/settings')]);
    const st = await readApiJson(statusRes, 'WhatsApp status API');
    const settings = await readApiJson(settingsRes, 'Settings API');
    if (tokenInput) tokenInput.value = '';
    if (phoneInput) phoneInput.value = settings.whatsappPhoneNumberId || '';
    if (recipientsInput) recipientsInput.value = settings.whatsappAllowedRecipients || '';
    status.innerHTML = esc(st.ready ? 'WhatsApp setup is ready for status-only use with ' + st.allowedRecipientCount + ' allowed recipient(s).' : st.message || 'WhatsApp is not configured.') + connectorSourceBadge(settings.connectorSecretStatus?.whatsappAccessToken);
  } catch (e) {
    status.textContent = 'Could not load WhatsApp status: ' + (e.message || e);
  }
}

async function saveWhatsAppSetup() {
  const tokenInput = document.getElementById('whatsappAccessTokenInput');
  const phoneInput = document.getElementById('whatsappPhoneNumberIdInput');
  const recipientsInput = document.getElementById('whatsappAllowedRecipientsInput');
  const status = document.getElementById('whatsappStatus');
  if (!status) return;
  status.textContent = 'Saving...';
  try {
    const response = await fetch('/api/whatsapp/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: tokenInput?.value.trim() || '', phoneNumberId: phoneInput?.value.trim() || '', allowedRecipients: recipientsInput?.value.trim() || '' }) });
    const data = await readApiJson(response, 'WhatsApp setup API');
    status.textContent = data.status?.message || 'WhatsApp settings saved.';
    loadConnectorBadges();
  } catch (e) {
    status.textContent = 'WhatsApp setup failed: ' + (e.message || e);
  }
}

function connectorSourceBadge(info) {
  if (!info || !info.configured) return '';
  if (info.source === 'env') return ' <span class="key-source-badge env">from env</span>';
  if (info.source === 'file') return ' <span class="key-source-badge stored">stored</span>';
  return '';
}

async function loadDesktopInputEvidence() {
  const panel = document.getElementById('desktopInputEvidence');
  if (!panel) return;
  panel.textContent = 'Loading desktop input evidence...';
  try {
    const response = await fetch('/api/desktop-input/evidence');
    const data = await readApiJson(response, 'Desktop input evidence API');
    const audit = Array.isArray(data.audit) ? data.audit : [];
    const screenshots = Array.isArray(data.screenshots) ? data.screenshots : [];
    const auditHtml = audit.length
      ? audit.slice(-5).reverse().map((entry) => '<details class="audit-row"><summary>' + esc(entry.timestamp || 'unknown time') + ' · ' + esc(entry.outcome || 'event') + '</summary><pre class="audit-json-pre">' + esc(JSON.stringify(entry, null, 2)) + '</pre></details>').join('')
      : '<div class="readiness-empty">No desktop input audit entries yet.</div>';
    const screenshotHtml = screenshots.length
      ? '<div class="document-list">' + screenshots.slice(-6).reverse().map((file) => '<div class="document-item"><div><strong>' + esc(file.name) + '</strong><span>Screenshot evidence</span></div><a class="btn-sm" href="' + esc(file.url) + '" target="_blank" rel="noopener">Open</a></div>').join('') + '</div>'
      : '<div class="readiness-empty">No desktop screenshots yet.</div>';
    panel.innerHTML = '<div class="settings-note">Audit log: <code>' + esc(data.auditPath || '.harness/desktop/desktop-input-audit.jsonl') + '</code></div>' + auditHtml + screenshotHtml;
  } catch (e) {
    panel.textContent = 'Could not load desktop input evidence: ' + (e.message || e);
  }
}

// ─── Folder picker for the Agent Files input ─────────────────────────
// Inline expandable directory browser. Lists subdirectories of any path
// on disk via /api/browse-dirs (NOT confined to the project root). Click
// a folder name to drill in; click "Use this folder" to copy the current
// path back to the input. Preset chips jump to common locations.

function toggleAgentOutputDirBrowser() {
  const browser = document.getElementById('agentOutputDirBrowser');
  if (!browser) return;
  if (browser.classList.contains('hidden-by-default')) {
    browser.classList.remove('hidden-by-default');
    // If the input has a value already, start the picker there; otherwise home.
    const input = document.getElementById('agentOutputDirInput');
    loadAgentOutputDirBrowser(input?.value.trim() || '');
  } else {
    browser.classList.add('hidden-by-default');
  }
}

async function loadAgentOutputDirBrowser(targetPath) {
  const browser = document.getElementById('agentOutputDirBrowser');
  if (!browser) return;
  browser.innerHTML = '<div class="settings-status-line">Loading…</div>';
  try {
    const url = '/api/browse-dirs' + (targetPath ? '?path=' + encodeURIComponent(targetPath) : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error('browse failed (' + r.status + ')');
    const d = await r.json();
    renderAgentOutputDirBrowser(d);
  } catch (e) {
    browser.innerHTML = '<div class="settings-warning-line">❌ ' + esc(e.message) + '</div>';
  }
}

function renderAgentOutputDirBrowser(data) {
  const browser = document.getElementById('agentOutputDirBrowser');
  if (!browser) return;
  let html = '';
  // Quick-jump preset chips at the top.
  html += '<div class="folder-preset-row">';
  for (const preset of (data.presets || [])) {
    html += '<button class="btn-sm btn-folder-preset" onclick="loadAgentOutputDirBrowser(' + JSON.stringify(preset.path) + ')" title="' + esc(preset.path) + '">' + esc(preset.label) + '</button>';
  }
  html += '</div>';
  // Current path + Use-this-folder action.
  html += '<div class="folder-current-row">';
  html += '<span class="folder-current-path" title="' + esc(data.cwd) + '"><code>' + esc(data.cwd) + '</code></span>';
  html += '<button class="btn-sm primary btn-folder-use" onclick="useAgentOutputDir(' + JSON.stringify(data.cwd) + ')">✓ Use this folder</button>';
  html += '</div>';
  // Up button if we can go up.
  if (data.parent) {
    html += '<div class="folder-up-row"><button class="btn-sm btn-folder-up" onclick="loadAgentOutputDirBrowser(' + JSON.stringify(data.parent) + ')">⬆ Up</button></div>';
  }
  // Error from the server (e.g. permission denied) shown but presets still available.
  if (data.error) {
    html += '<div class="settings-warning-line folder-warning">⚠ ' + esc(data.error) + '</div>';
  }
  // Subdirectory list.
  const dirs = data.dirs || [];
  if (dirs.length === 0) {
    html += '<div class="folder-empty">No subfolders here.</div>';
  } else {
    html += '<div class="folder-list">';
    for (const dir of dirs.slice(0, 200)) {
      html += '<div class="folder-list-row" onclick="loadAgentOutputDirBrowser(' + JSON.stringify(dir.path) + ')">📁 ' + esc(dir.name) + '</div>';
    }
    html += '</div>';
    if (dirs.length > 200) html += '<div class="folder-overflow-note">' + (dirs.length - 200) + ' more not shown</div>';
  }
  browser.innerHTML = html;
}

function useAgentOutputDir(folderPath) {
  const input = document.getElementById('agentOutputDirInput');
  if (input) input.value = folderPath;
  // Close the browser to keep the panel tidy after selection.
  const browser = document.getElementById('agentOutputDirBrowser');
  if (browser) browser.classList.add('hidden-by-default');
}

async function loadFileRedirects() {
  const list = document.getElementById('fileRedirectsList');
  if (!list) return;
  let data = { rules: [], source: 'none', envOverride: false };
  try {
    const r = await fetch('/api/file-redirects');
    if (r.ok) data = await r.json();
  } catch(e){}
  list.innerHTML = '';
  // Surface env-var override clearly so the user knows the editor is read-only.
  if (data.envOverride) {
    const banner = document.createElement('div');
    banner.className = 'setting-row redirect-env-warning';
    banner.textContent = '⚠ HARNESS_FILE_WRITE_REDIRECTS env var is set — UI rules are ignored until you unset it.';
    list.appendChild(banner);
  }
  const rules = Array.isArray(data.rules) ? data.rules : [];
  if (rules.length === 0) {
    addFileRedirectRow();
  } else {
    for (const rule of rules) addFileRedirectRow(rule.match, rule.redirect);
  }
  const status = document.getElementById('fileRedirectsStatus');
  if (status) status.textContent = rules.length === 0 ? '' : `${rules.length} rule(s) active (source: ${data.source})`;
}

function addFileRedirectRow(matchValue = '', redirectValue = '') {
  const list = document.getElementById('fileRedirectsList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'setting-row redirect-rule-row';
  const matchInput = document.createElement('input');
  matchInput.type = 'text';
  matchInput.placeholder = 'glob, e.g. lottery-*';
  matchInput.value = matchValue;
  matchInput.dataset.field = 'match';
  matchInput.className = 'redirect-match-input';
  const redirectInput = document.createElement('input');
  redirectInput.type = 'text';
  redirectInput.placeholder = 'destination dir, e.g. C:/AI/Lottery-Toolkit/inbox';
  redirectInput.value = redirectValue;
  redirectInput.dataset.field = 'redirect';
  redirectInput.className = 'redirect-target-input';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-sm';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove rule';
  removeBtn.onclick = () => row.remove();
  row.appendChild(matchInput);
  row.appendChild(redirectInput);
  row.appendChild(removeBtn);
  list.appendChild(row);
}

async function saveFileRedirects() {
  const list = document.getElementById('fileRedirectsList');
  const status = document.getElementById('fileRedirectsStatus');
  if (!list) return;
  const rows = list.querySelectorAll('.setting-row');
  const rules = [];
  for (const row of rows) {
    const match = row.querySelector('input[data-field="match"]')?.value.trim() || '';
    const redirect = row.querySelector('input[data-field="redirect"]')?.value.trim() || '';
    if (!match || !redirect) continue;
    rules.push({ match, redirect });
  }
  if (status) status.textContent = 'Saving...';
  try {
    const r = await fetch('/api/file-redirects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!r.ok) throw new Error('Save failed (' + r.status + ')');
    const d = await r.json();
    if (status) status.textContent = '✅ Saved ' + d.count + ' rule(s).';
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  } catch (e) {
    if (status) status.textContent = '❌ ' + e.message;
  }
}

// Posts the currently-typed (unsaved) rules + a sample path to the
// preview endpoint and renders which rule (if any) would catch the
// path. Catches typos like `lottery_*` before they get saved.
async function previewFileRedirects() {
  const list = document.getElementById('fileRedirectsList');
  const input = document.getElementById('fileRedirectsPreviewInput');
  const out = document.getElementById('fileRedirectsPreviewResult');
  if (!list || !input || !out) return;
  const samplePath = input.value.trim();
  if (!samplePath) {
    out.innerHTML = '<span class="trace-meta">Type a sample path first.</span>';
    return;
  }
  // Read the rules from the form (NOT the server) so the preview
  // reflects unsaved edits.
  const rows = list.querySelectorAll('.setting-row');
  const rules = [];
  for (const row of rows) {
    const match = row.querySelector('input[data-field="match"]')?.value.trim() || '';
    const redirect = row.querySelector('input[data-field="redirect"]')?.value.trim() || '';
    if (!match || !redirect) continue;
    rules.push({ match, redirect });
  }
  out.innerHTML = '<span class="trace-meta">Checking...</span>';
  try {
    const r = await fetch('/api/file-redirects/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: samplePath, rules }),
    });
    if (!r.ok) throw new Error('Preview failed (' + r.status + ')');
    const d = await r.json();
    if (d.matched) {
      out.innerHTML = '✅ <strong>Matched</strong> rule <code>' + esc(d.rule.match) + '</code> → would write to <code>' + esc(d.destination) + '</code>';
    } else {
      out.innerHTML = '⚠️ <strong>No rule matches.</strong> A bare-filename write would still go to <code>agent-outputs/</code>; a path with subdirectories would write as-is into the project.';
    }
  } catch (e) {
    out.innerHTML = '❌ ' + esc(e.message);
  }
}

async function pullModel() { const name = document.getElementById('pullName').value.trim(); if (!name) return; const prog = document.getElementById('pullProgress'); prog.textContent = 'Starting...'; try { const res = await fetch('/api/models/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const p = line.slice(6); if (p === '[DONE]') { prog.textContent = 'Done!'; loadModels(); return; } try { const d = JSON.parse(p); if (d.error) { prog.textContent = 'Error: ' + d.error; return; } if (d.status) { const pct = d.completed && d.total ? ' (' + Math.round(d.completed / d.total * 100) + '%)' : ''; prog.textContent = d.status + pct; } } catch(e){} } } } catch (e) { prog.textContent = 'Failed: ' + e.message; } }

async function loadLearning() {
  try {
    const r = await fetch('/api/learning');
    const d = await r.json();
    const view = document.getElementById('learningView');
    let html = '<div class="learning-shell"><h5 class="panel-kicker">🧠 Self-Learning Status</h5>';
    html += '<div class="learning-search-row"><input id="semanticQuery" class="learning-search-input" placeholder="Search session memory"><button class="btn-sm" onclick="searchSemanticMemory()">Search</button></div><div id="semanticResults"></div>';
    html += '<div class="learning-stat-line">Total tool calls tracked: <strong>' + ((d.totalToolCalls) || 0) + '</strong></div>';

    if (d.toolBreakdown && Object.keys(d.toolBreakdown).length > 0) {
      html += '<div class="learning-section-block">';
      for (const [tool, count] of Object.entries(d.toolBreakdown || {})) {
        html += '<div class="metric-row"><span>' + esc(tool) + '</span><span class="accent-text">' + count + '</span></div>';
      }
      html += '</div>';
    }

    const patterns = d.patterns || [];
    if (patterns.length > 0) {
      html += '<h5 class="panel-kicker spaced">Detected Patterns</h5>';
      for (const p of patterns.slice(0, 5)) {
        html += '<div class="learning-pattern-card"><div class="accent-strong">' + esc(p.toolSequence.join(' → ')) + '</div><div class="trace-meta">' + p.occurrences + 'x across sessions' + (p.promoted ? ' ✅ promoted' : '') + '</div></div>';
      }
    }

    const reflections = d.reflections || [];
    if (reflections.length > 0) {
      html += '<h5 class="panel-kicker spaced">Recent Reflections</h5>';
      for (const item of reflections.slice(-3)) {
        html += '<div class="learning-reflection-card"><div>Success: ' + Math.round(item.successRate * 100) + '% | Tools: ' + item.toolsUsed.join(', ') + '</div>';
        if (item.insights.length) html += '<div class="trace-meta-warning top-spaced-small">' + esc(item.insights.join('; ')) + '</div>';
        html += '</div>';
      }
    }

    if (d.evolvedPrompt) html += '<h5 class="panel-kicker spaced">Evolved Instructions</h5><pre class="learning-prompt-pre">' + esc(d.evolvedPrompt) + '</pre>';
    html += '</div>';
    view.innerHTML = html;
    renderLearningManager(d);
  } catch(e){
    document.getElementById('learningView').innerHTML = '<div class="empty-panel-copy">No learning data yet. Start chatting and the agent will begin tracking patterns.</div>';
  }
}

function renderLearningManager(data) {
  const view = document.getElementById('learningView');
  if (!view) return;
  view.innerHTML += renderRoutingMetrics(data) + renderCandidateQueue(data) + renderOutputValidationTrends(data) + renderProfileFeedbackTrends(data) + renderContextLossTrend(data) + renderEvalDatasetManager(data);
  // Inject benchmark panel as a sibling section.
  const benchmarkContainer = document.createElement('div');
  benchmarkContainer.id = 'benchmarkPanel';
  view.appendChild(benchmarkContainer);
  renderBenchmarkPanel(benchmarkContainer);
}

function renderOutputValidationTrends(data) {
  const trend = data.outputValidationTrend || { totalResults: 0, byProfile: {}, bySelectionSource: {}, byStatus: {}, latestFailures: [] };
  const profileRows = Object.entries(trend.byProfile || {}).map(([profile, bucket]) => '<div class="metric-row"><span>' + esc(profile) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const sourceRows = Object.entries(trend.bySelectionSource || {}).map(([source, bucket]) => '<div class="metric-row"><span>' + esc(source) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const statusRows = Object.entries(trend.byStatus || {}).map(([status, count]) => '<span class="trace-pill">' + esc(status) + ': ' + count + '</span>').join('');
  const failures = (trend.latestFailures || []).map((failure) => '<div class="trace-meta">' + esc(failure.profile) + ' · ' + esc(failure.selectionSource || 'unknown') + ' · ' + esc(failure.task) + ' · ' + esc(failure.message) + (failure.checks?.length ? ' · ' + esc(failure.checks.join(', ')) : '') + '</div>').join('');
  return '<div id="outputValidationTrend" class="trace-list"><div class="trace-title">Output Validation Trends</div><div class="trace-meta">' + trend.totalResults + ' validation results recorded</div><button id="downloadOutputValidationTrendBtn" class="btn-sm full-width-button" onclick="downloadOutputValidationTrend()">Download validation trends</button><div class="trace-block-spaced"><strong>By profile</strong>' + (profileRows || '<div class="trace-meta">No validation runs yet</div>') + '</div><div id="outputValidationSourceTrend" class="trace-block-spaced"><strong>By selection source</strong>' + (sourceRows || '<div class="trace-meta">No source data yet</div>') + '</div>' + (statusRows ? '<div class="pill-row-spaced">' + statusRows + '</div>' : '') + (failures ? '<div class="trace-block-spaced"><strong>Recent findings</strong>' + failures + '</div>' : '') + '</div>';
}

function downloadOutputValidationTrend() {
  markWalkthroughStep('learning');
  window.location.href = '/api/learning/output-validation-trends/download';
}

function renderContextLossTrend(data) {
  const trend = data.contextLossTrend || { total: 0, recent: [] };
  if (trend.total === 0) return '';
  const rows = (trend.recent || []).map((entry) => '<div class="trace-meta">⚠️ ' + esc(entry.task) + ' <span class="text-dim">(' + esc((entry.createdAt || '').slice(0, 19)) + ')</span></div>').join('');
  return '<div id="contextLossTrend" class="trace-list"><div class="trace-title">Assistant Context Loss</div>' +
    '<div class="trace-meta trace-meta-warn"><strong>' + trend.total + '</strong> assistant reply(ies) shared no significant token with the prior turn.</div>' +
    '<div class="trace-block-spaced"><strong>Recent</strong>' + rows + '</div>' +
    '<div class="trace-meta trace-block-spaced">Tag: <code>assistant-context-loss</code>. See <code>.harness/evals/trace-runs.jsonl</code> for full traces.</div>' +
    '</div>';
}

function renderProfileFeedbackTrends(data) {
  const trend = data.profileFeedbackTrend || { totalVotes: 0, byProfile: {}, insights: [], recentVotes: [], dailyApproval: [] };
  const profileRows = Object.entries(trend.byProfile || {}).map(([profile, bucket]) => '<div class="metric-row"><span>' + esc(profile) + '</span><span>👍 ' + bucket.up + ' · 👎 ' + bucket.down + ' · ' + Math.round((bucket.approvalRate || 0) * 100) + '% approve</span></div>').join('');
  const insightRows = (trend.insights || []).map((insight) => '<div class="trace-meta ' + (insight.severity === 'warn' ? 'trace-meta-warn' : '') + '"><strong>' + esc(insight.severity.toUpperCase()) + ':</strong> ' + esc(insight.message) + '</div>').join('');
  const recentRows = (trend.recentVotes || []).map((vote) => '<div class="trace-meta">' + (vote.vote === 'up' ? '👍' : '👎') + ' ' + esc(vote.profile) + ' · ' + esc(vote.task) + '</div>').join('');
  const sparkline = renderApprovalSparkline(trend.dailyApproval || []);
  return '<div id="profileFeedbackTrend" class="trace-list"><div class="trace-title">Validation Profile Feedback</div>' +
    '<div class="trace-meta">' + trend.totalVotes + ' vote(s) recorded</div>' +
    (sparkline ? '<div class="trace-block-spaced"><strong>Approval rate over time</strong>' + sparkline + '</div>' : '') +
    '<div class="trace-block-spaced"><strong>By profile</strong>' + (profileRows || '<div class="trace-meta">No feedback yet — use 👍 / 👎 on the validation profile event in chat.</div>') + '</div>' +
    (insightRows ? '<div class="trace-block-spaced"><strong>Calibration insights</strong>' + insightRows + '</div>' : '') +
    (recentRows ? '<div class="trace-block-spaced"><strong>Recent votes</strong>' + recentRows + '</div>' : '') +
    '<div class="trace-block-spaced-large"><button class="btn-sm" onclick="replayProfileFeedback()">Replay down-votes through suggester</button></div>' +
    '<div id="profileFeedbackReplayResult" class="trace-meta initial-hidden trace-block-spaced"></div>' +
    '</div>';
}

function renderApprovalSparkline(daily) {
  if (!daily || daily.length < 2) return '';
  const w = 220;
  const h = 32;
  const pad = 2;
  const points = daily.map((d, i) => {
    const x = pad + (i / (daily.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (d.approvalRate || 0)) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const lastPct = Math.round((daily[daily.length - 1].approvalRate || 0) * 100);
  const title = daily.map((d) => d.date + ': ' + Math.round((d.approvalRate || 0) * 100) + '% (' + d.up + '/' + d.total + ')').join(' · ');
  return '<svg width="' + w + '" height="' + h + '" class="sparkline" role="img" aria-label="Approval rate sparkline">' +
    '<title>' + esc(title) + '</title>' +
    '<polyline points="' + points + '" fill="none" stroke="var(--accent,#4ea1ff)" stroke-width="1.5" />' +
    '</svg><div class="trace-meta">Latest: ' + lastPct + '% across ' + daily.length + ' day(s)</div>';
}

async function replayProfileFeedback() {
  const out = document.getElementById('profileFeedbackReplayResult');
  if (!out) return;
  out.classList.remove('initial-hidden');
  out.textContent = 'Replaying…';
  try {
    const res = await fetch('/api/output-validation/feedback-replay');
    const data = await res.json();
    const lines = (data.replays || []).slice(0, 10).map((replay) => {
      const icon = replay.status === 'fixed' ? '✅' : (replay.status === 'still-misclassified' ? '❌' : '⚠️');
      return icon + ' ' + esc(replay.originalProfile) + ' → ' + esc(replay.suggestedProfile) + (replay.prompt ? ' · ' + esc(replay.prompt.slice(0, 80)) : ' (no prompt captured)');
    }).join('<br/>');
    out.innerHTML = '<strong>' + data.totalDownVotes + ' down-vote(s):</strong> ' + data.fixed + ' fixed · ' + data.stillMisclassified + ' still misclassified · ' + data.noPrompt + ' missing prompt' + (lines ? '<br/>' + lines : '');
  } catch (err) {
    out.textContent = 'Replay failed: ' + (err && err.message ? err.message : err);
  }
}

function renderRoutingMetrics(data) {
  const summary = data.routingSummary || { total: 0, successRate: 0, escalationRate: 0, byTier: {}, topReasons: [] };
  const calibration = data.routingCalibration || { recommendations: [], suggestedPolicy: {} };
  const tiers = Object.entries(summary.byTier || {}).map(([tier, bucket]) => '<div class="metric-row"><span>' + esc(tier) + '</span><span>' + bucket.count + ' · ' + Math.round(bucket.successRate * 100) + '%</span></div>').join('');
  const recommendations = (calibration.recommendations || []).map((item) => '<div class="trace-meta">' + esc(item) + '</div>').join('');
  const suggested = Object.entries(calibration.suggestedPolicy || {}).map(([key, value]) => '<div class="metric-row"><span>' + esc(key) + '</span><span>' + esc(value) + '</span></div>').join('');
  const applyDisabled = suggested ? '' : ' disabled';
  return '<div id="routingMetricsPanel" class="trace-item"><div class="trace-title">Routing Metrics</div><div class="trace-meta">' + summary.total + ' runs · ' + Math.round((summary.successRate || 0) * 100) + '% success · ' + Math.round((summary.escalationRate || 0) * 100) + '% escalated</div>' + (tiers || '<div class="trace-meta">No tier metrics yet</div>') + '<div class="trace-block-spaced"><strong>Calibration</strong>' + (recommendations || '<div class="trace-meta">No calibration suggestions yet</div>') + (suggested ? '<div class="details-body-mt4">' + suggested + '</div>' : '') + '<button id="applyCalibrationBtn" class="btn-sm full-width-button"' + applyDisabled + ' onclick="applyRoutingCalibration()">Apply calibration</button></div></div>';
}

function renderCandidateQueue(data) {
  const candidates = data.candidates || [];
  const rows = candidates.slice(-8).reverse().map((candidate, index) => {
    const disabled = candidate.reviewStatus !== 'pending' || !candidate.accepted;
    const status = candidate.reviewStatus || 'pending';
    const gateSuffix = String(candidate.id || 'candidate').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'candidate';
    const gateId = 'gate-' + gateSuffix + '-' + index;
    return '<div class="trace-item"><div class="trace-title">Candidate · ' + esc(status) + '</div><div class="trace-meta">Quality ' + Math.round((candidate.qualityScore || 0) * 100) + '% · ' + esc(candidate.toolNames?.join(', ') || 'no tools') + '</div><div class="candidate-prompt-preview">' + esc((candidate.prompt || '').slice(0, 180)) + '</div><div id="' + escAttr(gateId) + '" data-candidate-id="' + escAttr(candidate.id) + '" class="candidate-gate-status trace-meta initial-hidden"></div><div class="inline-actions trace-block-spaced"><button class="btn-sm" onclick="inspectLearningCandidate(\'' + escAttr(candidate.id) + '\')">Details</button><button class="btn-sm" onclick="checkPromotionGate(\'' + escAttr(candidate.id) + '\',\'' + escAttr(gateId) + '\')">Gate</button><button class="btn-sm" ' + (disabled ? 'disabled' : '') + ' onclick="reviewLearningCandidate(\'' + escAttr(candidate.id) + '\',\'promote\')">Promote</button><button class="btn-sm danger" ' + (candidate.reviewStatus !== 'pending' ? 'disabled' : '') + ' onclick="reviewLearningCandidate(\'' + escAttr(candidate.id) + '\',\'reject\')">Reject</button></div></div>';
  }).join('');
  return '<div id="learningCandidateQueue" class="trace-list"><div class="trace-title">Learning Candidate Review</div>' + (rows || '<div class="trace-meta">No candidates yet</div>') + '<div id="candidateProvenanceDetail" class="trace-item initial-hidden"></div></div>';
}

async function checkPromotionGate(candidateId, gateId) {
  if (!candidateId) return;
  const host = (gateId && document.getElementById(gateId))
    || Array.from(document.querySelectorAll('.candidate-gate-status')).find((el) => el.getAttribute('data-candidate-id') === String(candidateId));
  if (!host) return;
  host.classList.remove('initial-hidden');
  host.style.display = 'block';
  host.innerHTML = '<em>Checking promotion gate…</em>';
  try {
    const response = await fetch('/api/learning/candidates/' + encodeURIComponent(candidateId) + '/gate');
    const data = await response.json();
    if (data.error) { host.textContent = data.error; return; }
    const colour = data.allowed ? 'var(--success,#50c878)' : 'var(--warning,orange)';
    const enabledNote = data.gate_enabled ? '' : ' <span style="color:var(--text-dim)">(advisory only — set HARNESS_PROMOTION_GATE_ENABLED=1 to enforce)</span>';
    const violations = (data.safety_violations || []).map((violation) =>
      '<div class="trace-meta" style="color:var(--danger,#e55)">⚠ ' + esc(violation.severity) + ' · ' + esc(violation.ruleLabel) + ' (in ' + esc(violation.matchedIn) + '): ' + esc(violation.excerpt) + '</div>',
    ).join('');
    host.innerHTML = '<div style="border-left:3px solid ' + colour + ';padding:6px 8px;margin-top:4px">'
      + '<strong>Gate ' + (data.allowed ? '✓ allowed' : '✕ blocked') + '</strong>' + enabledNote
      + '<div class="trace-meta">' + esc(data.reason) + '</div>'
      + '<div class="trace-meta">Recent runs: ' + data.pass_count + '/' + data.considered_runs + ' passing (need ' + data.required_passes + ')</div>'
      + violations
      + '</div>';
  } catch (error) {
    host.textContent = 'Gate check failed: ' + (error && error.message ? error.message : error);
  }
}

function renderEvalDatasetManager(data) {
  const examples = data.evalExamples || [];
  const trend = data.evalRunTrend || { totalRuns: 0, averagePassRate: 0 };
  const latest = trend.latest ? '<div class="trace-meta">Latest run: ' + trend.latest.passed + '/' + trend.latest.total + ' passed · ' + Math.round((trend.latest.passRate || 0) * 100) + '%</div>' : '<div class="trace-meta">No eval runs yet</div>';
  const latestFailures = renderLatestRunFailures(trend.latest);
  const tagRows = Object.entries(trend.byTag || {}).slice(0, 5).map(([tag, bucket]) => '<div class="metric-row"><span>' + esc(tag) + '</span><span>' + bucket.passed + '/' + bucket.total + ' · ' + Math.round((bucket.passRate || 0) * 100) + '%</span></div>').join('');
  const rows = examples.slice(-8).reverse().map((example) => '<div class="trace-item"><div class="trace-title">Eval · ' + esc(example.status) + (example.mode === 'replay' ? ' · replay' : '') + '</div><div class="trace-meta">' + esc(example.task) + '</div><div class="trace-meta">' + esc((example.tags || []).join(', ')) + '</div>' + renderReplaySourceLinks(example) + '<div class="inline-actions trace-block-spaced"><button class="btn-sm" onclick="tagEvalExample(\'' + escAttr(example.id) + '\',\'' + escAttr((example.tags || []).join(', ')) + '\')">Tag</button><button class="btn-sm danger" onclick="deleteEvalExample(\'' + escAttr(example.id) + '\')">Delete</button></div></div>').join('');
  return '<div id="evalDatasetManager" class="trace-list"><div class="trace-title">Eval Dataset</div><button id="runEvalDatasetBtn" class="btn-sm full-width-button" onclick="runEvalDataset(\'stored\')">Run stored evals</button><button id="runLiveReplayDatasetBtn" class="btn-sm full-width-button" onclick="runEvalDataset(\'live\')">Run live replay evals</button><button class="btn-sm full-width-button" onclick="downloadEvalDataset()">Download JSONL</button><div id="evalRunTrend" class="trace-item"><div class="trace-title">Eval Trends</div><div class="trace-meta">' + trend.totalRuns + ' runs · ' + Math.round((trend.averagePassRate || 0) * 100) + '% average pass rate</div>' + latest + tagRows + latestFailures + '</div>' + (rows || '<div class="trace-meta">No eval examples yet</div>') + '</div>';
}

function renderLatestRunFailures(run) {
  const failed = (run?.results || []).filter((result) => result.status === 'fail').slice(0, 4);
  if (failed.length === 0) return '';
  return '<div id="latestReplayFailures" class="trace-block-spaced"><strong>Latest failures</strong>' + failed.map((result) => '<div class="trace-meta">' + esc(result.task) + ' · ' + esc(result.message) + renderReplayResultLinks(result.links) + '</div>').join('') + '</div>';
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
  if (data.error) { showToast(data.error); return; }
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
  const events = (data.events || []).map((event) => '<div class="trace-row"><strong>' + esc(event.kind) + '</strong><div>' + esc(event.type) + ' · ' + esc(event.timestamp) + '</div><div class="prewrap-text">' + esc(event.summary) + '</div></div>').join('');
  detail.innerHTML = '<div class="trace-title">Candidate Provenance</div><div class="trace-meta">' + esc(data.candidate.sessionId) + ' · ' + (data.events || []).length + ' source events</div>' + (events || '<div class="trace-meta">No source events found</div>') + ((data.missingEventIds || []).length ? '<div class="trace-meta">Missing source ids: ' + esc(data.missingEventIds.join(', ')) + '</div>' : '');
}

async function runEvalDataset(mode) {
  const selectedModel = document.getElementById('modelSelect')?.value;
  if (mode === 'live' && !selectedModel) { showToast('Select a model before running live replay evals.'); return; }
  const response = await fetch('/api/evals/trace-examples/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode || 'stored', model: selectedModel }) });
  const data = await response.json();
  if (data.error) { showToast(data.error); return; }
  await loadLearning();
}

async function reviewLearningCandidate(id, action) {
  const reason = action === 'reject' ? await promptToast('Reason for rejection', 'Not useful enough') : undefined;
  if (action === 'reject' && reason === null) return;
  const response = await fetch('/api/learning/candidates/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, reason }) });
  const data = await response.json();
  if (data.error) { showToast(data.error); return; }
  await loadLearning();
}

async function tagEvalExample(id, currentTags) {
  const input = await promptToast('Tags, comma separated', currentTags || '');
  if (input === null) return;
  const response = await fetch('/api/evals/trace-examples/' + encodeURIComponent(id) + '/tags', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: input.split(',') }) });
  const data = await response.json();
  if (data.error) { showToast(data.error); return; }
  await loadLearning();
  await loadTraceEvalExamples();
}

async function deleteEvalExample(id) {
  if (!await confirmToast('Delete this eval example?')) return;
  const response = await fetch('/api/evals/trace-examples/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await response.json();
  if (data.error) { showToast(data.error); return; }
  await loadLearning();
  await loadTraceEvalExamples();
}

function downloadEvalDataset() {
  window.location.href = '/api/evals/trace-examples/download';
}

async function rebuildSemanticMemory() { try { const r = await fetch('/api/memory/rebuild', { method: 'POST' }); const d = await r.json(); showToast('Semantic memory entries: ' + (d.entries || 0)); } catch (e) { showToast(e.message); } }
async function searchSemanticMemory() { const q = document.getElementById('semanticQuery').value.trim(); const box = document.getElementById('semanticResults'); if (!q) return; try { const r = await fetch('/api/memory/search?q=' + encodeURIComponent(q)); const d = await r.json(); box.innerHTML = (d.results || []).map((x) => '<div class="learning-pattern-card"><div class="accent-strong">' + esc(x.entry.kind) + ' · ' + Math.round(x.score * 100) + '</div><div class="trace-meta">' + esc(x.entry.text.slice(0, 220)) + '</div></div>').join('') || '<div class="settings-note">No matches</div>'; } catch (e) { box.textContent = e.message; } }

async function exportTraceSnapshot() { try { const response = await fetch('/api/traces/exports', { method: 'POST' }); const data = await response.json(); if (data.error) { showToast(data.error); return; } loadTraceExports(); } catch (error) { showToast(error.message); } }
async function exportTraceEvalExample() { try { const response = await fetch('/api/evals/trace-examples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'browser trace export', tags: ['browser', 'runtime'] }) }); const data = await response.json(); if (data.error) { showToast(data.error); return; } await loadTraceEvalExamples(); } catch (error) { showToast(error.message); } }
async function createWeatherReplayEval() { try { const response = await fetch('/api/evals/replay-examples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Bracknell weather answer regression', prompt: 'What is the weather like in Bracknell, UK today?', expectedResponseIncludes: ['Bracknell', 'weather'], expectedTools: ['web_search', 'web_read'], tags: ['weather', 'replay'] }) }); const data = await response.json(); if (data.error) { showToast(data.error); return; } await loadTraceEvalExamples(); await loadLearning(); } catch (error) { showToast(error.message); } }
async function loadTraceEvalExamples() { const box = document.getElementById('traceEvalExamples'); if (!box) return; try { const response = await fetch('/api/evals/trace-examples'); const data = await response.json(); const examples = data.examples || []; box.innerHTML = examples.slice(-5).reverse().map((item) => '<div class="trace-item"><div class="trace-title">Eval · ' + esc(item.status) + '</div><div class="trace-meta">' + esc(item.task) + ' · ' + esc((item.tags || []).join(', ')) + '</div></div>').join('') || '<div class="trace-meta">No eval examples</div>'; } catch(e){ box.innerHTML = '<div class="trace-meta">Eval examples unavailable</div>'; } }
async function loadTraceExports() { const box = document.getElementById('traceExports'); if (!box) return; try { const response = await fetch('/api/traces/exports'); const data = await response.json(); box.innerHTML = (data.exports || []).slice(0, 5).map((item) => '<div class="trace-item"><div class="trace-title">' + esc(item.id) + '</div><div class="trace-meta">' + Math.round((item.size || 0) / 1024) + ' KB · ' + esc(item.modifiedAt || '') + '</div><button class="btn-sm full-width-button" onclick="inspectTraceExport(\'' + escAttr(item.id) + '\')">Inspect trace</button></div>').join('') || '<div class="trace-meta">No exports</div>'; await loadTraceEvalExamples(); } catch(e){ box.innerHTML = '<div class="trace-meta">Trace exports unavailable</div>'; } }

async function inspectTraceExport(id) { const inspector = document.getElementById('traceInspector'); if (!inspector) return; inspector.classList.remove('initial-hidden'); inspector.textContent = 'Loading trace export...'; try { const response = await fetch('/api/traces/exports/' + encodeURIComponent(id)); const data = await response.json(); if (data.error) { inspector.textContent = data.error; return; } activeTraceExport = data; renderTraceInspector(); } catch (error) { inspector.textContent = error.message; } }

function renderTraceInspector() { const inspector = document.getElementById('traceInspector'); if (!inspector || !activeTraceExport) return; const filter = (document.getElementById('traceFilter')?.value || '').toLowerCase(); const spans = (activeTraceExport.spans || []).filter((span) => traceRecordText(span).includes(filter)); const events = (activeTraceExport.events || []).filter((event) => traceRecordText(event).includes(filter)); const spanRows = spans.slice(0, 8).map((span) => '<div class="trace-row"><strong>' + esc(span.name) + '</strong><div>' + esc(span.status || 'open') + ' · ' + esc(span.durationMs ?? 0) + ' ms · ' + esc(span.startedAt || '') + '</div>' + (span.error ? '<div>' + esc(span.error) + '</div>' : '') + '</div>').join(''); const eventRows = events.slice(0, 8).map((event) => '<div class="trace-row"><strong>' + esc(event.name) + '</strong><div>' + esc(event.timestamp || '') + '</div></div>').join(''); inspector.innerHTML = '<div><strong>' + esc(activeTraceExport.id || 'trace') + '</strong></div><div>' + spans.length + '/' + (activeTraceExport.spans || []).length + ' spans · ' + events.length + '/' + (activeTraceExport.events || []).length + ' events</div><input id="traceFilter" class="trace-filter" placeholder="Filter spans and events" value="' + escAttr(filter) + '" oninput="renderTraceInspector()"><div class="trace-block-spaced-large"><strong>Spans</strong>' + (spanRows || '<div class="trace-row">No matching spans</div>') + '</div><div class="trace-block-spaced-large"><strong>Events</strong>' + (eventRows || '<div class="trace-row">No matching events</div>') + '</div>'; const input = document.getElementById('traceFilter'); if (input) input.selectionStart = input.selectionEnd = input.value.length; }

function traceRecordText(record) { return JSON.stringify(record || {}).toLowerCase(); }

async function loadRuntimeStorage() { const box = document.getElementById('runtimeStorageStatus'); if (!box) return; try { const response = await fetch('/api/runtime/storage'); const data = await response.json(); box.innerHTML = '<div><strong>Trace exports</strong> ' + esc(data.traces.count) + ' files · ' + Math.round((data.traces.bytes || 0) / 1024) + ' KB</div><div><strong>Semantic index</strong> ' + (data.semanticIndex.exists ? Math.round((data.semanticIndex.bytes || 0) / 1024) + ' KB' : 'not built') + '</div>'; } catch (error) { box.textContent = error.message; } }

async function cleanupRuntimeStorage(target) { const body = { traces: target === 'traces', semanticIndex: target === 'semanticIndex' }; try { const response = await fetch('/api/runtime/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (data.error) { showToast(data.error); return; } await loadRuntimeStorage(); if (target === 'traces') await loadTraceExports(); } catch (error) { showToast(error.message); } }

// ─── Benchmark panel (Gap #2) ───────────────────────────────────────

async function runBenchmarkSuite(tiers) {
  const btn = document.getElementById('runBenchmarkBtn');
  const box = document.getElementById('benchmarkResults');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  if (box) box.innerHTML = '<div class="trace-meta">Running benchmark suite…</div>';
  try {
    const model = document.getElementById('modelSelect')?.value || '';
    const response = await fetch('/api/benchmark/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers: tiers || undefined, model }),
    });
    const data = await response.json();
    if (data.error) { showToast(data.error); return; }
    renderBenchmarkRun(data.run, data.summary, box);
    await loadBenchmarkHistory();
  } catch (error) {
    showToast(error.message);
    if (box) box.innerHTML = '<div class="trace-meta">Error: ' + esc(error.message) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
  }
}

function renderBenchmarkRun(run, summary, box) {
  if (!box || !run) return;
  const pct = Math.round((run.passRate || 0) * 100);
  const badge = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '❌';
  const tierRows = (summary || []).map((t) =>
    '<div class="trace-row"><strong>' + esc(t.tier) + '</strong> · ' + esc(t.passed) + '/' + esc(t.total) + ' · ' + esc(t.passRate) + '</div>'
  ).join('');
  const failRows = (run.results || []).filter((r) => r.status !== 'pass').map((r) =>
    '<div class="trace-row error-row"><strong>' + esc(r.taskId) + '</strong>' +
    (r.failureCategory ? ' <span class="tool-name">' + esc(r.failureCategory) + '</span>' : '') +
    '<div class="trace-meta">' + esc(r.reason) + '</div></div>'
  ).join('');
  box.innerHTML =
    '<div class="trace-item"><div class="trace-title">' + badge + ' ' + pct + '% · ' + run.passed + '/' + run.total + ' tasks passed</div>' +
    '<div class="trace-meta">model: ' + esc(run.model) + ' · ' + run.total + ' tasks · ' + esc(run.finishedAt?.slice(0, 19) || '') + '</div>' +
    '<div class="trace-block-spaced">' + tierRows + '</div>' +
    (failRows ? '<div class="trace-block-spaced"><strong>Failures</strong>' + failRows + '</div>' : '') +
    '</div>';
}

async function loadBenchmarkHistory() {
  const box = document.getElementById('benchmarkHistory');
  if (!box) return;
  try {
    const response = await fetch('/api/benchmark/runs');
    const data = await response.json();
    const runs = data.runs || [];
    box.innerHTML = runs.slice(0, 10).map((r) => {
      const pct = Math.round((r.passRate || 0) * 100);
      const badge = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '❌';
      const tiers = (r.tiers || []).join(', ');
      return '<div class="trace-item"><div class="trace-title">' + badge + ' ' + pct + '% · ' + esc(r.model) + '</div>' +
        '<div class="trace-meta">' + r.passed + '/' + r.total + ' · tiers: ' + esc(tiers) + ' · ' + esc((r.startedAt || '').slice(0, 10)) + '</div></div>';
    }).join('') || '<div class="trace-meta">No benchmark runs yet</div>';
  } catch (e) {
    box.innerHTML = '<div class="trace-meta">History unavailable</div>';
  }
}

function renderBenchmarkPanel(container) {
  if (!container) return;
  container.innerHTML =
    '<div class="trace-list">' +
    '<div class="trace-title">Benchmark Suite</div>' +
    '<div class="trace-meta" style="margin-bottom:8px">Tiered task runner: canned · stress · adversarial · regression</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
    '<button id="runBenchmarkBtn" class="btn-sm" onclick="runBenchmarkSuite()">▶ Run all</button>' +
    '<button class="btn-sm" onclick="runBenchmarkSuite([\'canned\'])">Canned only</button>' +
    '<button class="btn-sm" onclick="runBenchmarkSuite([\'adversarial\'])">Adversarial</button>' +
    '<button class="btn-sm" onclick="runBenchmarkSuite([\'regression\'])">Regression</button>' +
    '</div>' +
    '<div id="benchmarkResults"><div class="trace-meta">No run yet this session</div></div>' +

    // A/B comparison section (Gap #3)
    '<div class="trace-title" style="margin-top:12px">A/B Model Comparison</div>' +
    '<div class="trace-meta" style="margin-bottom:6px">Run the same tasks against two models head-to-head</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
    '<input id="abModelA" class="learning-search-input" placeholder="Model A" style="width:160px">' +
    '<span>vs</span>' +
    '<input id="abModelB" class="learning-search-input" placeholder="Model B" style="width:160px">' +
    '<button class="btn-sm" onclick="runABComparison()">⚔️ Compare</button>' +
    '</div>' +
    '<div id="abCompareResults"></div>' +

    // Cost rates section (Gap #5)
    '<div class="trace-title" style="margin-top:12px">Cost Rates</div>' +
    '<div class="trace-meta" style="margin-bottom:6px">$/1K-token rates for cost-per-success calculations</div>' +
    '<div id="costRatesPanel"><div class="trace-meta">Loading…</div></div>' +

    '<div class="trace-title" style="margin-top:12px">Past Runs</div>' +
    '<div id="benchmarkHistory"><div class="trace-meta">Loading…</div></div>' +
    '</div>';
  loadBenchmarkHistory();
  loadCostRates();
}

// ─── A/B Comparison (Gap #3) ──────────────────────────────────────

async function runABComparison() {
  const modelA = (document.getElementById('abModelA') || {}).value;
  const modelB = (document.getElementById('abModelB') || {}).value;
  if (!modelA || !modelB) { showToast('Enter both Model A and Model B'); return; }
  const out = document.getElementById('abCompareResults');
  if (out) out.innerHTML = '<div class="trace-meta">Running comparison… this may take a few minutes.</div>';
  try {
    const r = await fetch('/api/benchmark/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelA, modelB }),
    });
    const d = await r.json();
    if (d.error) { if (out) out.innerHTML = '<div class="trace-meta trace-meta-warn">Error: ' + esc(d.error) + '</div>'; return; }
    if (out) out.innerHTML = renderComparisonResult(d);
  } catch (e) { if (out) out.innerHTML = '<div class="trace-meta trace-meta-warn">' + esc(e.message) + '</div>'; }
}

function renderComparisonResult(cmp) {
  let html = '<div class="trace-block-spaced">';
  html += '<div class="trace-title">' + esc(cmp.modelA.model) + ' vs ' + esc(cmp.modelB.model) + '</div>';
  html += '<div class="metric-row"><span>Pass rate</span><span>' + Math.round(cmp.modelA.passRate * 100) + '% vs ' + Math.round(cmp.modelB.passRate * 100) + '%</span></div>';
  html += '<div class="metric-row"><span>Avg duration</span><span>' + cmp.modelA.avgDurationMs + 'ms vs ' + cmp.modelB.avgDurationMs + 'ms</span></div>';
  html += '<div class="metric-row"><span>Avg tool calls</span><span>' + cmp.modelA.avgToolCalls + ' vs ' + cmp.modelB.avgToolCalls + '</span></div>';
  const winsA = (cmp.diffs || []).filter(function(d) { return d.winner === 1; }).length;
  const winsB = (cmp.diffs || []).filter(function(d) { return d.winner === -1; }).length;
  const ties = (cmp.diffs || []).filter(function(d) { return d.winner === 0; }).length;
  html += '<div class="metric-row"><span>Task wins</span><span>' + winsA + ' / ' + winsB + ' / ' + ties + ' ties</span></div>';

  // Per-task diffs
  const disagreements = (cmp.diffs || []).filter(function(d) { return d.winner !== 0; });
  if (disagreements.length > 0) {
    html += '<div class="trace-title" style="margin-top:8px">Disagreements</div>';
    for (const d of disagreements) {
      const winner = d.winner === 1 ? cmp.modelA.model : cmp.modelB.model;
      html += '<div class="trace-meta">• <strong>' + esc(d.taskId) + '</strong>: ' + esc(winner) + ' won (' + d.statusA + '/' + d.statusB + ', ' + d.durationMsA + 'ms/' + d.durationMsB + 'ms)</div>';
    }
  }
  html += '</div>';
  return html;
}

// ─── Cost Rates (Gap #5) ──────────────────────────────────────────

async function loadCostRates() {
  const panel = document.getElementById('costRatesPanel');
  if (!panel) return;
  try {
    const r = await fetch('/api/cost/rates');
    const d = await r.json();
    const rates = d.rates || {};
    const models = Object.keys(rates);
    if (models.length === 0) { panel.innerHTML = '<div class="trace-meta">No rates configured</div>'; return; }
    let html = '<div style="max-height:150px;overflow-y:auto">';
    for (const model of models) {
      const rate = rates[model];
      const label = rate.input === 0 && rate.output === 0 ? 'free (local)' : '$' + rate.input + '/$' + rate.output + ' per 1K';
      html += '<div class="metric-row"><span>' + esc(model) + '</span><span class="trace-meta">' + label + '</span></div>';
    }
    html += '</div>';
    panel.innerHTML = html;
  } catch (e) { if (panel) panel.innerHTML = '<div class="trace-meta">Failed: ' + esc(e.message) + '</div>'; }
}

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

// ─── Kill-switch global shortcut and status banner ────────────────
// Ctrl+Shift+K (or Cmd+Shift+K on macOS) toggles the kill switch from any
// view. While the switch is engaged a fixed banner stays visible at the top
// of the page so the operator never forgets the agent is muzzled.
async function toggleKillSwitchShortcut() {
  try {
    const state = await fetch('/api/permissions/state').then((r) => r.json());
    const active = Boolean(state?.killSwitch?.active);
    if (active) {
      await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
    } else {
      await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true, reason: 'Engaged via Ctrl+Shift+K shortcut.' }) });
    }
    await refreshKillSwitchBanner();
    if (document.getElementById('toolsDashboardView')?.style.display !== 'none' && typeof loadToolsDashboard === 'function') loadToolsDashboard();
  } catch (error) { console.warn('Kill switch toggle failed:', error); }
}

async function refreshKillSwitchBanner() {
  try {
    const state = await fetch('/api/permissions/state').then((r) => r.json());
    renderKillSwitchBanner(state?.killSwitch || { active: false, reason: '' });
  } catch(e){ /* leave banner state alone if the call fails */ }
}

function renderKillSwitchBanner(killSwitch) {
  let banner = document.getElementById('killSwitchBanner');
  if (!killSwitch.active) {
    if (banner) banner.remove();
    repositionGlobalAutonomyBanner();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'killSwitchBanner';
    banner.className = 'kill-switch-banner';
    document.body.appendChild(banner);
  }
  banner.innerHTML = '<strong>🛑 KILL SWITCH ACTIVE</strong>'
    + '<span>' + esc(killSwitch.reason || 'All tool calls are denied.') + '</span>'
    + '<span class="kill-switch-shortcut">Ctrl+Shift+K to toggle</span>'
    + '<button class="btn-sm btn-inline-cancel" onclick="releaseKillSwitchFromBanner()">Release</button>';
  repositionGlobalAutonomyBanner();
}

function repositionGlobalAutonomyBanner() {
  const ab = document.getElementById('globalAutonomyBanner');
  if (!ab) return;
  const ksBanner = document.getElementById('killSwitchBanner');
  ab.style.top = ksBanner ? (ksBanner.offsetHeight + 'px') : '0';
}

async function releaseKillSwitchFromBanner() {
  await fetch('/api/permissions/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  await refreshKillSwitchBanner();
  if (document.getElementById('toolsDashboardView')?.style.display !== 'none' && typeof loadToolsDashboard === 'function') loadToolsDashboard();
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'K' || event.key === 'k')) {
    event.preventDefault();
    toggleKillSwitchShortcut();
  }
  if (event.key === '?' && !event.ctrlKey && !event.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'SELECT') {
    event.preventDefault();
    showKeyboardShortcuts();
  }
  // Universal escape hatch: closes any overlay panel that might have its
  // close button rendered offscreen at narrow viewport widths. Prefer
  // closing the artifact panel first (it sits above the right panel),
  // then the right Settings panel. Stops at the first one closed so
  // users can press Escape repeatedly to dismiss layered overlays.
  if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Stop streaming first if active
    if (activeChatController) {
      event.preventDefault();
      activeChatController.abort();
      return;
    }
    const artifact = document.getElementById('artifactPanel');
    if (artifact && artifact.classList.contains('open')) {
      event.preventDefault();
      try { closeArtifact(); } catch(e){ artifact.classList.remove('open'); }
      return;
    }
    const right = document.getElementById('rightPanel');
    if (right && !right.classList.contains('hidden')) {
      event.preventDefault();
      right.classList.add('hidden');
      right.classList.remove('visible');
      try { localStorage.setItem('harness_right_panel', 'closed'); } catch(e){}
      updatePanelBackdrop();
      return;
    }
    const left = document.getElementById('leftPanel');
    if (left && !left.classList.contains('hidden')) {
      event.preventDefault();
      left.classList.add('hidden');
      left.classList.remove('visible');
      try { localStorage.setItem('leftPanelCollapsed', '1'); } catch(e){}
      updatePanelBackdrop();
      return;
    }
  }
});

// On page load, sync the banner so a kill switch persisted from a previous
// run is visible as soon as the UI mounts.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { refreshKillSwitchBanner(); refreshAutonomyBanner(); });
} else {
  refreshKillSwitchBanner();
  refreshAutonomyBanner();
}

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

// ─── Voice input (browser STT via Web Speech API) ──────────────────
// Free, no server changes, works fully offline in Chrome/Edge. Toggling
// 🎤 starts/stops recognition. Recognized phrases append to the chat
// input so the user can review before sending.

let voiceRecognition = null;
let voiceActive = false;

function toggleVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showToast('Voice input requires Web Speech API support. Try Chrome or Edge.');
    return;
  }
  const btn = document.getElementById('voiceBtn');
  if (voiceActive && voiceRecognition) {
    voiceRecognition._stoppedByUser = true;
    voiceRecognition.stop();
    return;
  }
  voiceRecognition = new Recognition();
  voiceRecognition.continuous = true;
  // Show interim results so the user sees Jarvis is actually hearing them.
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = (navigator.language || 'en-US');
  voiceActive = true;
  if (btn) { btn.classList.add('recording'); btn.title = 'Stop voice input and send'; }
  voiceShowStatus('🎙️ listening… (speak)');
  voiceRecognition.onaudiostart = () => { voiceShowStatus('🎙️ mic open · waiting for speech'); voiceStartLevelMeter(); voiceArmWatchdog(); };
  voiceRecognition.onspeechstart = () => { voiceClearWatchdog(); voiceShowStatus('🎙️ heard you · keep talking'); };
  voiceRecognition.onspeechend = () => voiceShowStatus('🎙️ processing…');
  voiceRecognition.onresult = (event) => {
    voiceClearWatchdog();
    const inp = document.getElementById('chatInput');
    if (!inp) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        const sep = inp.value && !/\s$/.test(inp.value) ? ' ' : '';
        inp.value = inp.value + sep + text;
        autoSize(inp);
        voiceShowStatus('🎙️ captured: "' + text.slice(0, 40) + '"');
      } else {
        interim += text + ' ';
      }
    }
    if (interim) voiceShowStatus('🎙️ interim: ' + interim.trim().slice(0, 60));
  };
  voiceRecognition.onerror = (event) => {
    const code = event.error || 'unknown';
    console.warn('voice recognition error:', code, event);
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      voiceShowStatus('🎙️ ❌ mic permission denied — click 🔒 in address bar to allow');
      showToast('Microphone permission denied. Allow microphone access in your browser to use voice input.');
    } else if (code === 'no-speech') {
      voiceShowStatus('🎙️ ⚠️ no speech detected — speak louder or check your input device');
    } else if (code === 'audio-capture') {
      voiceShowStatus('🎙️ ❌ no microphone found — check OS sound settings');
    } else if (code === 'network') {
      voiceShowStatus('🎙️ ❌ Web Speech API needs internet (Google service); try Edge or check connection');
    } else {
      voiceShowStatus('🎙️ ❌ error: ' + code);
    }
  };
  voiceRecognition.onend = () => {
    const shouldSend = voiceRecognition && voiceRecognition._stoppedByUser;
    voiceActive = false;
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice input (browser STT)'; }
    const wasUser = shouldSend;
    voiceRecognition = null;
    voiceStopLevelMeter();
    if (shouldSend) {
      const inp = document.getElementById('chatInput');
      if (inp && inp.value.trim()) {
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) { sendBtn.textContent = '⏳'; sendBtn.disabled = false; }
        setTimeout(() => {
          if (sendBtn) sendBtn.textContent = '➤';
          sendMessage();
        }, 300);
      }
      voiceShowStatus('');
    } else if (jarvisAlwaysListen) {
      // Recognition naturally ended (timeout / silence) but user wants
      // continuous listening — restart it.
      voiceShowStatus('🎙️ restarting always-listen…');
      setTimeout(() => { if (jarvisAlwaysListen && !voiceActive) toggleVoiceInput(); }, 400);
    } else if (!wasUser) {
      voiceShowStatus('🎙️ stopped (no speech) — click 🎤 to retry');
    }
  };
  try { voiceRecognition.start(); } catch (e) {
    voiceActive = false;
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice input (browser STT)'; }
    voiceShowStatus('🎙️ ❌ start failed: ' + e.message);
    showToast('Could not start voice input: ' + e.message);
  }
}

// Surface voice state in the Jarvis Live tile (if rendered) and the
// status bar; falls back to console when neither host exists. This is
// the single feedback path so the user never has to wonder if the mic
// is actually hearing them.
// Sticky-error window: error messages (containing ❌) hold the status line
// for STICKY_MS even if other status updates fire afterward. Without this,
// a 503 from /api/jarvis/voice/transcribe flashes by in <300ms and the
// hands-free mic appears to silently turn off — exactly the failure mode
// that wasted hours diagnosing on 2026-05-12.
const VOICE_STATUS_STICKY_MS = 5000;
let voiceStatusStickyUntil = 0;
function voiceShowStatus(text) {
  const liveBody = document.getElementById('jarvisLiveBody');
  let host = document.getElementById('jarvisVoiceStatus');
  if (!host && liveBody) {
    host = document.createElement('div');
    host.id = 'jarvisVoiceStatus';
    host.style.cssText = 'margin-top:6px;font-size:12px;color:var(--accent,#0a0)';
    liveBody.parentNode.insertBefore(host, liveBody.nextSibling);
  }
  const now = Date.now();
  const isError = typeof text === 'string' && text.includes('❌');
  const isStickyHold = now < voiceStatusStickyUntil;
  if (isStickyHold && !isError) {
    // A non-error update arrived while a recent error is still being held.
    // Defer it until the sticky window passes so the user actually sees
    // the failure reason. Always log so the trace is preserved.
    if (text) console.log('[voice deferred]', text);
    setTimeout(() => voiceShowStatus(text), Math.max(0, voiceStatusStickyUntil - now));
    return;
  }
  if (host) {
    host.textContent = text || '';
    host.style.color = isError ? 'var(--danger,#e55)' : 'var(--accent,#0a0)';
  }
  if (isError) voiceStatusStickyUntil = now + VOICE_STATUS_STICKY_MS;
  if (text) console.log('[voice]', text);
}

// ─── Mic level meter ────────────────────────────────────────────────
//
// Independent of SpeechRecognition. Uses Web Audio API to read the raw
// microphone stream and render a peak/RMS meter so the user can see
// whether the browser is receiving audio at all. If the bar stays at 0
// while the mic is "listening", the problem is the OS/device — not the
// Web Speech API.

let voiceLevelStream = null;
let voiceLevelCtx = null;
let voiceLevelRaf = 0;

async function voiceStartLevelMeter() {
  try {
    if (voiceLevelStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      voiceLevelShow('(no getUserMedia)');
      return;
    }
    const chosenDeviceId = localStorage.getItem('jarvisMicDeviceId') || undefined;
    const constraints = chosenDeviceId
      ? { audio: { deviceId: { exact: chosenDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
    voiceLevelStream = await navigator.mediaDevices.getUserMedia(constraints);
    // Tell the user which device we actually got — same root-cause helper as the picker.
    try {
      const track = voiceLevelStream.getAudioTracks()[0];
      const settings = track.getSettings();
      const label = track.label || settings.deviceId || 'unknown';
      voiceShowStatus('🎙️ mic open · device: ' + label);
    } catch { /* noop */ }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    voiceLevelCtx = new AudioCtx();
    const source = voiceLevelCtx.createMediaStreamSource(voiceLevelStream);
    const analyser = voiceLevelCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frames = 0;
    let silentFrames = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128);
        if (v > peak) peak = v;
        sum += v;
      }
      const rms = Math.round((sum / data.length) * 100 / 128);
      const peakPct = Math.round(peak * 100 / 128);
      const bar = '█'.repeat(Math.min(20, Math.floor(peakPct / 5))) + '░'.repeat(Math.max(0, 20 - Math.floor(peakPct / 5)));
      voiceLevelShow(`level [${bar}] peak ${peakPct}% rms ${rms}%`);
      frames++;
      if (peakPct < 2) silentFrames++; else silentFrames = 0;
      if (frames === 60 && silentFrames >= 55) {
        voiceShowStatus('🎙️ ⚠️ mic stream is silent — wrong input device or muted in Windows');
      }
      if (voiceLevelStream) voiceLevelRaf = requestAnimationFrame(tick);
    };
    voiceLevelRaf = requestAnimationFrame(tick);
  } catch (err) {
    voiceLevelShow('level error: ' + (err && err.message ? err.message : err));
  }
}

function voiceStopLevelMeter() {
  if (voiceLevelRaf) cancelAnimationFrame(voiceLevelRaf);
  voiceLevelRaf = 0;
  if (voiceLevelStream) {
    try { voiceLevelStream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    voiceLevelStream = null;
  }
  if (voiceLevelCtx) {
    try { voiceLevelCtx.close(); } catch { /* noop */ }
    voiceLevelCtx = null;
  }
  voiceLevelShow('');
}

function voiceLevelShow(text) {
  const liveBody = document.getElementById('jarvisLiveBody');
  let host = document.getElementById('jarvisVoiceLevel');
  if (!host && liveBody) {
    host = document.createElement('div');
    host.id = 'jarvisVoiceLevel';
    host.style.cssText = 'margin-top:2px;font-size:11px;font-family:monospace;color:var(--muted)';
    liveBody.parentNode.insertBefore(host, liveBody.nextSibling.nextSibling || null);
  }
 

// ─── Web Speech watchdog ───────────────────────────────────────────
//
// Chrome's SpeechRecognition silently fails when the audio it relays to
// Google cannot be reached (offline / firewall / corp proxy / region
// restriction). The recognizer says "listening", the level meter shows
// audio, but no `onspeechstart` / `onresult` event ever fires. We arm a
// timer when the mic opens and surface a clear diagnostic when no
// recognition event arrives despite audible audio.

let voiceWatchdogTimer = 0;
let voiceWatchdogPeak = 0;

function voiceArmWatchdog() {
  voiceClearWatchdog();
  voiceWatchdogPeak = 0;
  // 8 seconds is generous — Google STT typically returns interim within 2.
  voiceWatchdogTimer = window.setTimeout(() => {
    if (voiceWatchdogPeak > 8) {
      voiceShowStatus('🎙️ ⚠️ audio is reaching the browser but Web Speech returned nothing in 8s. Most likely cause: Chrome\'s STT relays audio to Google and that connection is blocked (firewall / offline / corporate proxy). Try Edge, or wire whisper.cpp via cookbook/voice-whisper.ts for offline STT.');
    } else {
      voiceShowStatus('🎙️ ⚠️ no audible speech detected in 8s — speak louder or move closer to the mic');
    }
  }, 8000);
}

function voiceClearWatchdog() {
  if (voiceWatchdogTimer) { clearTimeout(voiceWatchdogTimer); voiceWatchdogTimer = 0; }
}

// Hook the level meter to feed peak data into the watchdog so it can tell
// "no audio at all" from "audio fine, STT broken".
const _origVoiceLevelShow = voiceLevelShow;
voiceLevelShow = function (text) {
  if (text) {
    const m = /peak (\d+)%/.exec(text);
    if (m) {
      const peak = parseInt(m[1], 10);
      if (peak > voiceWatchdogPeak) voiceWatchdogPeak = peak;
    }
  }
  _origVoiceLevelShow(text);
}; if (host) host.textContent = text || '';
}

// ─── Jarvis voice loop: TTS + always-listening ──────────────────────
//
// Speaks assistant replies via Web Speech API speechSynthesis when the
// "Speak replies" toggle is on. Optional always-listening mode keeps
// SpeechRecognition active between turns so the user can talk without
// reaching for the mic button each time.

let jarvisAlwaysListen = false;
let jarvisSpeakReplies = false;
// Tracks whether a TTS utterance is currently playing. Used by
// (a) the barge-in detector in jarvisLocalSttStart to cancel TTS the
//     moment the user starts talking, and
// (b) the hands-free re-arm path so it can wait for `tts-ended` instead
//     of using a hard-coded delay.
let jarvisTtsPlaying = false;

function jarvisToggleAlwaysListen() {
  jarvisAlwaysListen = !jarvisAlwaysListen;
  const btn = document.getElementById('jarvisAlwaysListenBtn');
  if (btn) btn.textContent = jarvisAlwaysListen ? '🎙️ listening' : '🎙️ off';
  if (jarvisAlwaysListen && !voiceActive) toggleVoiceInput();
}

function jarvisToggleSpeakReplies() {
  jarvisSpeakReplies = !jarvisSpeakReplies;
  const btn = document.getElementById('jarvisSpeakBtn');
  if (btn) btn.textContent = jarvisSpeakReplies ? '🔊 speaking' : '🔊 off';
}

function jarvisSpeak(text) {
  if (!jarvisSpeakReplies) return;
  if (!('speechSynthesis' in window)) return;
  try {
    const utter = new SpeechSynthesisUtterance(String(text || '').slice(0, 500));
    utter.lang = navigator.language || 'en-US';
    utter.rate = 1.0;
    utter.pitch = 1.0;
    // Track playback state so the re-arm path can wait for actual end
    // (instead of a fixed 1.8s timer) and so barge-in can cancel cleanly.
    const settle = () => {
      jarvisTtsPlaying = false;
      try { document.dispatchEvent(new CustomEvent('jarvis-tts-ended')); } catch { /* noop */ }
    };
    utter.onend = settle;
    utter.onerror = settle;
    window.speechSynthesis.cancel();
    jarvisTtsPlaying = true;
    window.speechSynthesis.speak(utter);
  } catch { /* speechSynthesis is best-effort */ jarvisTtsPlaying = false; }
}

// Cancel any in-flight TTS the moment the user starts talking. Called
// from the VAD path in jarvisLocalSttStart whenever we detect a fresh
// speech burst while jarvisTtsPlaying is true. Also dispatches the
// `jarvis-tts-ended` event so anyone waiting on natural completion
// resolves immediately.
function jarvisBargeInCancelTts() {
  if (!jarvisTtsPlaying) return;
  try { window.speechSynthesis.cancel(); } catch { /* noop */ }
  jarvisTtsPlaying = false;
  try { document.dispatchEvent(new CustomEvent('jarvis-tts-ended')); } catch { /* noop */ }
  voiceShowStatus('🎙️ barge-in — cancelling TTS');
}

// Hook: when an assistant reply finalizes, optionally speak it. Other code
// dispatches `jarvis-assistant-message` on document with `detail.text`.
document.addEventListener('jarvis-assistant-message', (event) => {
  const text = event && event.detail && event.detail.text;
  if (text) jarvisSpeak(text);
  if (jarvisAlwaysListen && !voiceActive) {
    // Pause briefly so TTS doesn't get picked up as STT input.
    setTimeout(() => { if (jarvisAlwaysListen && !voiceActive) toggleVoiceInput(); }, 1500);
  }
});

// ─── Jarvis Live tile + browser voice auto-registration ─────────────
//
// Auto-detects whether the browser supports the Web Speech API and
// registers it with the runtime registry so /api/jarvis/status reports
// voice-ready without manual setup. Polls /api/jarvis/status and
// /api/telegram/status to render a single "what's running right now"
// summary you can glance at instead of hunting through tabs.

async function jarvisAutoRegisterBrowserVoice() {
  try {
    const hasSTT = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasTTS = ('speechSynthesis' in window);
    const features = [];
    if (hasSTT) features.push({ feature: 'voice_stt', adapterName: 'browser-webspeech' });
    if (hasTTS) features.push({ feature: 'voice_tts', adapterName: 'browser-webspeech' });
    for (const f of features) {
      try {
        await fetch('/api/jarvis/runtime/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(f),
        });
      } catch { /* silent */ }
    }
  } catch { /* silent */ }
}

async function refreshJarvisLive() {
  const body = document.getElementById('jarvisLiveBody');
  const stamp = document.getElementById('jarvisLiveStamp');
  if (!body) return;
  try {
    const [statusResp, telegramResp] = await Promise.allSettled([
      fetch('/api/jarvis/status').then((r) => r.json()),
      fetch('/api/telegram/status').then((r) => r.json()),
    ]);
    const status = statusResp.status === 'fulfilled' ? statusResp.value : {};
    const telegram = telegramResp.status === 'fulfilled' ? telegramResp.value : {};
    const runtime = status.runtime || { voice: {}, inbound: {} };
    const ambient = status.ambient || {};
    const kg = status.knowledgeGraph || {};
    const trustCount = ((status.trustLadder && status.trustLadder.capabilities) || []).length;
    const profile = status.assistantProfile || {};
    const schedulers = status.schedulers || [];

    const lines = [];
    lines.push(row('🧩 Assistant profile', profile.enabled ? (profile.proactive ? 'proactive · voice + ambient + channels + autonomy' : 'on · voice + ambient + channels') : 'off (run start.bat / ./start.sh, or set HARNESS_PROFILE=assistant)'));
    lines.push(row('🎤 Voice (mic)', runtime.voice.stt ? 'ready · ' + (runtime.voice.sttAdapter || '') : 'not ready'));
    lines.push(row('🔊 Voice (speak)', runtime.voice.tts ? 'ready · ' + (runtime.voice.ttsAdapter || '') : 'not ready'));
    lines.push(row('💬 Telegram', telegram.running ? 'connected' + (telegram.hasAllowedChatIds ? ' · allowlist on' : '') : (telegram.configured ? 'configured but not running' : 'not configured')));
    lines.push(row('👁️ Ambient daemon', ambient.running ? 'running · watchers: ' + ((ambient.watchers || []).join(', ') || 'none') : (profile.enabled ? 'off (click Start ambient in Daily Brief)' : 'off (assistant profile is off; set HARNESS_AMBIENT_ENABLED=1 to force)')));
    if (schedulers.length) {
      const runningCount = schedulers.filter((s) => s.running).length;
      const cells = schedulers.map((s) => {
        let control;
        if (s.running) {
          control = ' <button class="btn-sm" style="padding:0 6px" onclick="jarvisStopScheduler(\'' + escAttr(s.name) + '\')" title="Stop this scheduler">Stop</button>';
        } else if (s.restartable) {
          control = ' <button class="btn-sm" style="padding:0 6px" onclick="jarvisRestartScheduler(\'' + escAttr(s.name) + '\')" title="Start this scheduler">Start</button>';
        } else {
          control = ' <span style="color:var(--muted)">(idle)</span>';
        }
        return '<span style="display:inline-block">' + esc(s.name) + control + '</span>';
      }).join('<br>');
      lines.push('<tr><td style="padding:2px 8px;color:var(--muted);vertical-align:top">' + esc('🗓️ Schedulers') + '</td><td style="padding:2px 8px">' + runningCount + '/' + schedulers.length + ' running<br>' + cells + '</td></tr>');
    }
    lines.push(row('🧠 Knowledge graph', kg.records ? (kg.records + ' records · ' + kg.entities + ' entities · ' + kg.facts + ' facts') : 'empty (run jarvis:seed to backfill)'));
    lines.push(row('📊 Trust ladder', trustCount + ' tracked capability(s)'));
    lines.push(row('🛰️ MCP server', (status.mcpServer && status.mcpServer.toolCount) ? (status.mcpServer.toolCount + ' tool(s) catalogued · run jarvis:mcp to expose') : 'not exposed'));
    body.innerHTML = '<table style="border-collapse:collapse;font-size:12px">' + lines.join('') + '</table>';
    if (stamp) stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    body.innerHTML = '<div style="color:var(--muted)">Status unavailable: ' + esc(error.message || error) + '</div>';
  }
  function row(label, value) {
    return '<tr><td style="padding:2px 8px;color:var(--muted)">' + esc(label) + '</td><td style="padding:2px 8px">' + esc(value) + '</td></tr>';
  }
}

// Stop one registered scheduler from the Jarvis Live panel. This is the
// per-subsystem control that complements the global kill switch: the kill
// switch only makes ticks no-op, whereas this fully stops the named
// scheduler. Restartable schedulers can be brought back via the Start
// button (jarvisRestartScheduler); the rest stay stopped until a server
// restart.
async function jarvisStopScheduler(name) {
  if (!await confirmToast('Stop the "' + name + '" scheduler?\n\nIt halts only this one subsystem (this is not the kill switch). You can bring it back with the Start button if it is restartable, otherwise it stays stopped until the next server restart.')) return;
  try {
    const response = await fetch('/api/jarvis/schedulers/' + encodeURIComponent(name) + '/stop', { method: 'POST' });
    await readApiJson(response, 'Stop scheduler');
    showToast('Stopped scheduler: ' + name, 2500, 'success');
    refreshJarvisLive();
  } catch (error) {
    showToast('Stop failed: ' + (error.message || error), 4000, 'error');
  }
}

// Restart (start) one registered scheduler from the Jarvis Live panel. Starting
// is benign — it re-runs the scheduler's own configure path, which respects the
// same enabled guards — so no confirmation is required.
async function jarvisRestartScheduler(name) {
  try {
    const response = await fetch('/api/jarvis/schedulers/' + encodeURIComponent(name) + '/restart', { method: 'POST' });
    await readApiJson(response, 'Start scheduler');
    showToast('Started scheduler: ' + name, 2500, 'success');
    refreshJarvisLive();
  } catch (error) {
    showToast('Start failed: ' + (error.message || error), 4000, 'error');
  }
}

async function jarvisSendBriefToTelegram() {
  try {
    const response = await fetch('/api/jarvis/brief/telegram', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) { showToast('Telegram brief failed: ' + (data.error || response.status)); return; }
    showToast('Brief delivered to ' + data.delivered + ' Telegram chat(s).');
  } catch (error) {
    showToast('Telegram brief failed: ' + (error.message || error));
  }
}

// ─── Mic device picker ─────────────────────────────────────────────
//
// Chrome's default mic for one origin can differ from another even on the
// same machine. ChatGPT might use device A, the harness might silently get
// device B. This picker lists every audioinput device the browser exposes
// and remembers the choice in localStorage so the level meter and Web
// Speech recognizer use the same source.

async function jarvisPickMic() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      showToast('Browser does not expose mic device enumeration.');
      return;
    }
    // Permission must already have been granted at least once for labels
    // to be populated. Request a throwaway stream so labels appear.
    let probeStream = null;
    try { probeStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* permission may already be denied — labels will be blank */ }
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (probeStream) probeStream.getTracks().forEach((t) => t.stop());
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      showToast('No microphones detected. Check Windows → Settings → Privacy → Microphone.');
      return;
    }
    const current = localStorage.getItem('jarvisMicDeviceId') || '';
    const lines = inputs.map((d, i) => `${i + 1}. ${d.label || '(unlabeled — grant permission first)'}${d.deviceId === current ? '  ← currently selected' : ''}`).join('\n');
    const choice = await promptToast('Pick microphone (number):\n\n' + lines + '\n\nLeave blank to use system default.', '');
    if (choice === null) return;
    const trimmed = choice.trim();
    if (!trimmed) {
      localStorage.removeItem('jarvisMicDeviceId');
      showToast('Cleared mic preference. Will use system default next time.');
      return;
    }
    const idx = parseInt(trimmed, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= inputs.length) {
      showToast('Invalid choice.');
      return;
    }
    localStorage.setItem('jarvisMicDeviceId', inputs[idx].deviceId);
    showToast('Selected: ' + (inputs[idx].label || inputs[idx].deviceId) + '\n\nClick the 🎤 button again to use it.');
  } catch (error) {
    showToast('Mic picker failed: ' + (error.message || error));
  }
}

// ─── Local STT via whisper.cpp (offline) ────────────────────────────
//
// Captures raw PCM audio from the user-picked mic, encodes a 16kHz mono
// WAV in the browser, and POSTs it to /api/jarvis/voice/transcribe which
// runs whisper.cpp on the server. No Google dependency — works fully
// offline once whisper.cpp is configured server-side.

let localSttCtx = null;
let localSttStream = null;
let localSttProcessor = null;
let localSttSource = null;
let localSttBuffers = [];
let localSttRecording = false;

async function jarvisLocalSttToggle() {
  if (localSttRecording) {
    // Manual stop while recording = "send what you have now".
    await jarvisLocalSttStop({ autoSend: true });
  } else {
    await jarvisLocalSttStart();
  }
}

// Hands-free mode: re-arm the mic automatically after each assistant reply
// so a conversation flows without touching the keyboard. Click the same
// button that toggles always-listening for browser STT — but for offline
// whisper. Persisted in localStorage so the toggle survives reloads.
let jarvisHandsFree = (() => { try { return localStorage.getItem('jarvisHandsFree') === '1'; } catch { return false; } })();

// VAD tunables — exposed via the ⚙️ voice settings panel. Persisted in
// localStorage so user adjustments survive reloads. Defaults match the
// shipped behavior so first-run users get the same experience.
const JARVIS_VAD_DEFAULTS = { silenceThreshold: 0.012, silenceTimeoutMs: 1500, minSpeechMs: 350 };
const jarvisVoiceVad = (() => {
  try {
    const raw = localStorage.getItem('jarvisVoiceVad');
    if (!raw) return { ...JARVIS_VAD_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      silenceThreshold: typeof parsed.silenceThreshold === 'number' ? parsed.silenceThreshold : JARVIS_VAD_DEFAULTS.silenceThreshold,
      silenceTimeoutMs: typeof parsed.silenceTimeoutMs === 'number' ? parsed.silenceTimeoutMs : JARVIS_VAD_DEFAULTS.silenceTimeoutMs,
      minSpeechMs: typeof parsed.minSpeechMs === 'number' ? parsed.minSpeechMs : JARVIS_VAD_DEFAULTS.minSpeechMs,
    };
  } catch { return { ...JARVIS_VAD_DEFAULTS }; }
})();
function jarvisVoiceVadPersist() { try { localStorage.setItem('jarvisVoiceVad', JSON.stringify(jarvisVoiceVad)); } catch { /* noop */ } }

// Bound to the slider inputs in the voice settings panel.
function jarvisVoiceVadUpdate(key, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return;
  jarvisVoiceVad[key] = num;
  jarvisVoiceVadPersist();
  const label = document.getElementById('jarvisVoiceVadLabel-' + key);
  if (label) label.textContent = jarvisVoiceVadFormat(key, num);
}
function jarvisVoiceVadFormat(key, value) {
  if (key === 'silenceThreshold') return value.toFixed(3) + ' (peak amplitude)';
  if (key === 'silenceTimeoutMs') return value + ' ms pause';
  if (key === 'minSpeechMs') return value + ' ms minimum speech';
  return String(value);
}
function jarvisVoiceVadReset() {
  Object.assign(jarvisVoiceVad, JARVIS_VAD_DEFAULTS);
  jarvisVoiceVadPersist();
  // Re-render whatever sliders are currently in the DOM so they snap back.
  for (const key of Object.keys(JARVIS_VAD_DEFAULTS)) {
    const slider = document.getElementById('jarvisVoiceVadSlider-' + key);
    const label = document.getElementById('jarvisVoiceVadLabel-' + key);
    if (slider) slider.value = String(jarvisVoiceVad[key]);
    if (label) label.textContent = jarvisVoiceVadFormat(key, jarvisVoiceVad[key]);
  }
}

// Toggle the inline voice settings panel. Lazy-rendered so the page load
// path stays cheap; subsequent toggles just flip display.
function jarvisToggleVoiceSettings() {
  let panel = document.getElementById('jarvisVoiceSettingsPanel');
  if (panel) { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; return; }
  const host = document.getElementById('jarvisVoiceControls') || document.getElementById('jarvisLivePanel');
  if (!host) return;
  panel = document.createElement('div');
  panel.id = 'jarvisVoiceSettingsPanel';
  panel.style.cssText = 'margin-top:8px;padding:8px;border:1px solid var(--surface2);border-radius:6px;font-size:12px';
  const row = (key, min, max, step) =>
    '<div style="margin-bottom:6px"><label style="display:block;color:var(--muted);margin-bottom:2px">'
    + key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
    + ': <span id="jarvisVoiceVadLabel-' + key + '">' + jarvisVoiceVadFormat(key, jarvisVoiceVad[key]) + '</span></label>'
    + '<input type="range" id="jarvisVoiceVadSlider-' + key + '" min="' + min + '" max="' + max + '" step="' + step
    + '" value="' + jarvisVoiceVad[key] + '" oninput="jarvisVoiceVadUpdate(\'' + key + '\', this.value)" style="width:100%"></div>';
  panel.innerHTML =
    '<div style="font-weight:600;margin-bottom:6px">🎚️ Voice tuning</div>'
    + row('silenceThreshold', 0.001, 0.1, 0.001)
    + row('silenceTimeoutMs', 300, 5000, 100)
    + row('minSpeechMs', 100, 2000, 50)
    + '<button class="btn-sm" onclick="jarvisVoiceVadReset()">↺ Reset defaults</button>'
    + ' <button class="btn-sm" id="jarvisVoiceVadTestBtn" onclick="jarvisVoiceVadToggleTest()" title="Open the mic and show live levels so you can pick a silence threshold above your noise floor">🎤 Test mic</button>'
    + '<div id="jarvisVoiceVadLiveBar" style="display:none;margin-top:8px;font-family:monospace;font-size:11px"></div>'
    + '<div style="margin-top:6px;color:var(--muted);font-size:11px">Changes apply to the <em>next</em> recording.</div>';
  host.appendChild(panel);
}

// Live VAD bar: opens a temporary mic stream and renders peak amplitude
// per frame next to the threshold marker so users can pick a silence
// threshold visually instead of guessing. Runs only while the settings
// panel's "🎤 Test mic" toggle is on.
let jarvisVoiceVadTestStream = null;
let jarvisVoiceVadTestCtx = null;
let jarvisVoiceVadTestRaf = 0;
function jarvisVoiceVadToggleTest() {
  const bar = document.getElementById('jarvisVoiceVadLiveBar');
  const btn = document.getElementById('jarvisVoiceVadTestBtn');
  if (jarvisVoiceVadTestStream) {
    jarvisVoiceVadStopTest();
    if (bar) bar.style.display = 'none';
    if (btn) btn.textContent = '🎤 Test mic';
    return;
  }
  if (bar) { bar.style.display = 'block'; bar.textContent = 'opening mic…'; }
  if (btn) btn.textContent = '⏹ Stop test';
  jarvisVoiceVadStartTest();
}
async function jarvisVoiceVadStartTest() {
  try {
    const chosenDeviceId = localStorage.getItem('jarvisMicDeviceId') || undefined;
    const constraints = chosenDeviceId
      ? { audio: { deviceId: { exact: chosenDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
    jarvisVoiceVadTestStream = await navigator.mediaDevices.getUserMedia(constraints);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    jarvisVoiceVadTestCtx = new AudioCtx();
    const source = jarvisVoiceVadTestCtx.createMediaStreamSource(jarvisVoiceVadTestStream);
    const analyser = jarvisVoiceVadTestCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128; // 0..1
        if (v > peak) peak = v;
      }
      const bar = document.getElementById('jarvisVoiceVadLiveBar');
      if (bar) {
        const width = 24;
        const peakSlots = Math.min(width, Math.round(peak / 0.05 * (width / 2)));
        const threshSlot = Math.min(width - 1, Math.round(jarvisVoiceVad.silenceThreshold / 0.05 * (width / 2)));
        let cells = '';
        for (let i = 0; i < width; i++) {
          if (i === threshSlot) cells += '|';
          else if (i < peakSlots) cells += '█';
          else cells += '░';
        }
        const above = peak > jarvisVoiceVad.silenceThreshold;
        bar.innerHTML = '<span style="color:' + (above ? 'var(--success,#0a0)' : 'var(--muted)') + '">[' + cells + ']</span>'
          + ' peak ' + peak.toFixed(3) + ' / threshold ' + jarvisVoiceVad.silenceThreshold.toFixed(3)
          + ' <span style="color:var(--muted)">(| = threshold marker)</span>';
      }
      if (jarvisVoiceVadTestStream) jarvisVoiceVadTestRaf = requestAnimationFrame(tick);
    };
    jarvisVoiceVadTestRaf = requestAnimationFrame(tick);
  } catch (err) {
    const bar = document.getElementById('jarvisVoiceVadLiveBar');
    if (bar) bar.textContent = 'mic test failed: ' + (err && err.message ? err.message : err);
    jarvisVoiceVadStopTest();
  }
}
function jarvisVoiceVadStopTest() {
  if (jarvisVoiceVadTestRaf) cancelAnimationFrame(jarvisVoiceVadTestRaf);
  jarvisVoiceVadTestRaf = 0;
  if (jarvisVoiceVadTestStream) {
    try { jarvisVoiceVadTestStream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    jarvisVoiceVadTestStream = null;
  }
  if (jarvisVoiceVadTestCtx) {
    try { jarvisVoiceVadTestCtx.close(); } catch { /* noop */ }
    jarvisVoiceVadTestCtx = null;
  }
}

// Probes /api/jarvis/voice/health on page load and disables hands-free
// up front when the backend can't transcribe. Without this the user
// clicks 🎤 hands-free, talks, pauses … and nothing happens because the
// transcribe POST returns 503 — exactly the silent-failure mode that
// inspired this probe.
async function jarvisVoiceProbeHealth() {
  const btn = document.getElementById('jarvisHandsFreeBtn');
  const sttBtn = document.getElementById('jarvisLocalSttBtn');
  try {
    const res = await fetch('/api/jarvis/voice/health');
    const data = await res.json();
    if (!data.ok) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '🎤 hands-free unavailable';
        btn.title = 'Whisper not configured on the server. ' + (data.hint || '');
      }
      if (sttBtn) {
        sttBtn.disabled = true;
        sttBtn.title = '(server cannot transcribe) ' + (data.hint || '');
      }
      voiceShowStatus('🎙️ ❌ whisper not configured — ' + (data.hint || 'see server env vars'));
    } else if (btn) {
      btn.title = 'Hands-free mode (' + (data.mode || 'whisper') + ' — ' + (data.hint || '') + ')';
    }
  } catch (err) {
    // Server might not be ready yet on first paint; don't surface as error.
    console.warn('[voice] health probe failed:', err && err.message ? err.message : err);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', jarvisVoiceProbeHealth);
} else {
  jarvisVoiceProbeHealth();
}

function jarvisToggleHandsFree() {
  jarvisHandsFree = !jarvisHandsFree;
  try { localStorage.setItem('jarvisHandsFree', jarvisHandsFree ? '1' : '0'); } catch { /* noop */ }
  const btn = document.getElementById('jarvisHandsFreeBtn');
  if (btn) btn.textContent = jarvisHandsFree ? '🎤 hands-free on' : '🎤 hands-free off';
  if (jarvisHandsFree && !localSttRecording) {
    // Start immediately so the user doesn't have to also click STT.
    // When wake-word mode is also on, start the cheap recognizer instead
    // so the heavy whisper pipeline only runs after "jarvis" is heard.
    if (jarvisWakeMode) {
      jarvisWakeStart();
    } else {
      void jarvisLocalSttStart();
    }
  }
}

// Wake-word + stop-word mode: instead of the mic streaming continuously
// in hands-free mode, use the cheap browser SpeechRecognition to listen
// for a wake phrase ("jarvis") and only then start the heavy local-STT
// recording. Stop phrases ("done", "stop listening", "thanks jarvis")
// in the transcribed result disable hands-free instead of auto-sending.
//
// Cuts mic burn time by ~80% for sit-and-think workflows where you
// don't want every keyboard tap and chair creak captured.
let jarvisWakeMode = (() => { try { return localStorage.getItem('jarvisWakeMode') === '1'; } catch { return false; } })();
let jarvisWakeRecognizer = null;
const JARVIS_WAKE_PHRASES = ['jarvis', 'hey jarvis', 'okay jarvis'];
const JARVIS_STOP_PHRASES = ['stop listening', 'done jarvis', 'thanks jarvis', 'goodbye jarvis'];

function jarvisToggleWakeMode() {
  jarvisWakeMode = !jarvisWakeMode;
  try { localStorage.setItem('jarvisWakeMode', jarvisWakeMode ? '1' : '0'); } catch { /* noop */ }
  const btn = document.getElementById('jarvisWakeModeBtn');
  if (btn) btn.textContent = jarvisWakeMode ? '👂 wake-word on' : '👂 wake-word off';
  if (jarvisWakeMode && jarvisHandsFree && !localSttRecording) {
    jarvisWakeStart();
  } else if (!jarvisWakeMode) {
    jarvisWakeStop();
  }
}

function jarvisWakeStart() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voiceShowStatus('🎙️ ❌ wake-word needs Web Speech API (Chrome/Edge)');
    return;
  }
  if (jarvisWakeRecognizer) return;
  try {
    jarvisWakeRecognizer = new Recognition();
    jarvisWakeRecognizer.continuous = true;
    jarvisWakeRecognizer.interimResults = false;
    jarvisWakeRecognizer.lang = navigator.language || 'en-US';
    jarvisWakeRecognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (!r.isFinal) continue;
        const text = (r[0].transcript || '').toLowerCase().trim();
        if (!text) continue;
        if (JARVIS_WAKE_PHRASES.some((p) => text.includes(p))) {
          voiceShowStatus('🎙️ wake-word "' + text.slice(0, 30) + '" — opening mic');
          jarvisWakeStop();
          void jarvisLocalSttStart();
          return;
        }
      }
    };
    jarvisWakeRecognizer.onend = () => {
      // Browser timed out the recognizer; restart if still in wake mode.
      if (jarvisWakeMode && jarvisHandsFree && !localSttRecording) {
        setTimeout(() => { if (jarvisWakeMode && jarvisHandsFree && !localSttRecording) jarvisWakeStart(); }, 250);
      } else {
        jarvisWakeRecognizer = null;
      }
    };
    jarvisWakeRecognizer.onerror = (event) => {
      console.warn('[wake] recognition error:', event.error);
      // no-speech is normal; let onend handle the restart loop.
    };
    jarvisWakeRecognizer.start();
    voiceShowStatus('👂 listening for "jarvis"…');
  } catch (err) {
    voiceShowStatus('🎙️ ❌ wake-word start failed: ' + (err && err.message ? err.message : err));
    jarvisWakeRecognizer = null;
  }
}

function jarvisWakeStop() {
  if (!jarvisWakeRecognizer) return;
  try { jarvisWakeRecognizer.stop(); } catch { /* noop */ }
  jarvisWakeRecognizer = null;
}

// Inspects whisper transcripts for stop-phrases. When matched, hands-free
// mode is disabled (so the loop stops re-arming) and the partial
// transcript is NOT auto-sent.
function jarvisCheckStopPhrase(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return JARVIS_STOP_PHRASES.some((p) => lower.includes(p));
}

// Restore the hands-free button label on first paint to match the
// persisted toggle state. Without this the button always shows "off"
// after a refresh even though the mode is active.
function jarvisHandsFreeRestoreLabel() {
  const btn = document.getElementById('jarvisHandsFreeBtn');
  if (btn && !btn.disabled) {
    btn.textContent = jarvisHandsFree ? '🎤 hands-free on' : '🎤 hands-free off';
  }
  const wakeBtn = document.getElementById('jarvisWakeModeBtn');
  if (wakeBtn) wakeBtn.textContent = jarvisWakeMode ? '👂 wake-word on' : '👂 wake-word off';
  if (jarvisHandsFree && !localSttRecording) {
    // Auto-arm after reload so a persisted ON state actually keeps
    // listening. Health probe will already have disabled the button if
    // whisper is misconfigured, in which case we skip.
    if (!btn || !btn.disabled) {
      if (jarvisWakeMode) jarvisWakeStart();
      else void jarvisLocalSttStart();
    }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', jarvisHandsFreeRestoreLabel);
} else {
  jarvisHandsFreeRestoreLabel();
}

// When the assistant finishes speaking (TTS) or finalizes a reply (TTS off),
// re-arm the mic. Waits for the actual `jarvis-tts-ended` event when TTS
// is playing instead of a fixed delay — short replies don't waste time,
// long replies don't get clipped. When TTS is off (or unavailable), uses
// a short fixed delay because there's no audio that could feed back in.
document.addEventListener('jarvis-assistant-message', () => {
  if (!jarvisHandsFree) return;
  const rearm = () => {
    if (!jarvisHandsFree || localSttRecording) return;
    // In wake-word mode, go back to the cheap recognizer instead of
    // re-opening the heavy whisper pipeline. The user has to say "jarvis"
    // again before the next utterance is captured.
    if (jarvisWakeMode) jarvisWakeStart();
    else void jarvisLocalSttStart();
  };
  if (jarvisTtsPlaying) {
    // Wait for natural TTS end (or barge-in cancel). 200ms grace after
    // the event so the audio output settles before we open the mic.
    document.addEventListener('jarvis-tts-ended', () => setTimeout(rearm, 200), { once: true });
  } else {
    setTimeout(rearm, 400);
  }
});

async function jarvisLocalSttStart() {
  try {
    const chosenDeviceId = localStorage.getItem('jarvisMicDeviceId') || undefined;
    const constraints = chosenDeviceId
      ? { audio: { deviceId: { exact: chosenDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
    localSttStream = await navigator.mediaDevices.getUserMedia(constraints);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    localSttCtx = new AudioCtx();
    localSttSource = localSttCtx.createMediaStreamSource(localSttStream);
    // ScriptProcessor is deprecated but still works in every browser; the
    // AudioWorklet replacement requires a separate module file.
    const bufferSize = 4096;
    localSttProcessor = localSttCtx.createScriptProcessor(bufferSize, 1, 1);
    localSttBuffers = [];
    // Voice-activity tracking for silence-based auto-stop. We keep a running
    // peak per audio chunk; when peak stays below the silence threshold for
    // SILENCE_TIMEOUT_MS after at least one speech burst, we stop automatically.
    // Tunables come from jarvisVoiceVad so the UI sliders can adjust them
    // live without editing source. MAX_RECORD_MS stays a constant — it's a
    // safety cap, not a tunable.
    const SILENCE_THRESHOLD = jarvisVoiceVad.silenceThreshold;
    const SILENCE_TIMEOUT_MS = jarvisVoiceVad.silenceTimeoutMs;
    const MIN_SPEECH_MS = jarvisVoiceVad.minSpeechMs;
    const MAX_RECORD_MS = 30_000;        // hard cap so a stuck mic doesn't run forever
    let lastSpeechAt = 0;
    let speechMs = 0;
    const startedAt = performance.now();
    let silenceTimer = 0;

    localSttProcessor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      // Copy because the underlying buffer is reused
      localSttBuffers.push(new Float32Array(channel));
      // Track peak amplitude for silence detection
      let peak = 0;
      for (let i = 0; i < channel.length; i++) {
        const v = Math.abs(channel[i]);
        if (v > peak) peak = v;
      }
      const now = performance.now();
      const chunkMs = (channel.length / (localSttCtx ? localSttCtx.sampleRate : 48000)) * 1000;
      if (peak > SILENCE_THRESHOLD) {
        // Barge-in: if Jarvis is mid-reply when fresh user speech starts,
        // cancel TTS instantly so the user isn't talking over a fading
        // assistant voice (and so the silence detector doesn't time the
        // pause from end-of-TTS instead of end-of-user).
        if (jarvisTtsPlaying) jarvisBargeInCancelTts();
        lastSpeechAt = now;
        speechMs += chunkMs;
      }
      // Hard cap
      if (now - startedAt > MAX_RECORD_MS) {
        if (localSttRecording) jarvisLocalSttStop({ autoSend: speechMs > MIN_SPEECH_MS });
        return;
      }
      // Silence-based auto-stop
      if (speechMs > MIN_SPEECH_MS && lastSpeechAt > 0 && (now - lastSpeechAt) > SILENCE_TIMEOUT_MS) {
        if (silenceTimer === 0) {
          silenceTimer = 1;
          if (localSttRecording) jarvisLocalSttStop({ autoSend: true });
        }
      }
    };
    localSttSource.connect(localSttProcessor);
    localSttProcessor.connect(localSttCtx.destination);
    localSttRecording = true;
    voiceShowStatus('🎙️ recording — auto-stops after 1.5s silence');
    const btn = document.getElementById('jarvisLocalSttBtn');
    if (btn) { btn.textContent = '🟥 stop'; btn.classList.add('recording'); }
    voiceStartLevelMeter();
  } catch (err) {
    voiceShowStatus('🎙️ ❌ local STT start failed: ' + (err && err.message ? err.message : err));
  }
}

async function jarvisLocalSttStop(options) {
  if (!localSttRecording) return;
  const opts = options || {};
  localSttRecording = false;
  const btn = document.getElementById('jarvisLocalSttBtn');
  if (btn) { btn.textContent = '🎙️ local STT'; btn.classList.remove('recording'); }
  try {
    if (localSttProcessor) { localSttProcessor.disconnect(); localSttProcessor.onaudioprocess = null; }
    if (localSttSource) localSttSource.disconnect();
    if (localSttStream) localSttStream.getTracks().forEach((t) => t.stop());
  } catch { /* noop */ }
  voiceStopLevelMeter();
  voiceShowStatus('🎙️ encoding WAV and sending to whisper…');

  const sampleRate = localSttCtx ? localSttCtx.sampleRate : 48000;
  // Flatten Float32 chunks
  let totalLen = 0;
  for (const buf of localSttBuffers) totalLen += buf.length;
  const flat = new Float32Array(totalLen);
  let offset = 0;
  for (const buf of localSttBuffers) { flat.set(buf, offset); offset += buf.length; }
  localSttBuffers = [];

  if (localSttCtx) { try { localSttCtx.close(); } catch { /* noop */ } localSttCtx = null; }
  localSttStream = null;
  localSttProcessor = null;
  localSttSource = null;

  if (totalLen === 0) {
    voiceShowStatus('🎙️ ⚠️ nothing recorded');
    return;
  }

  // Resample to 16 kHz mono — whisper.cpp wants 16 kHz
  const downsampled = jarvisResampleTo16k(flat, sampleRate);
  const wav = jarvisEncodeWAV(downsampled, 16000);

  try {
    const response = await fetch('/api/jarvis/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      voiceShowStatus('🎙️ ❌ ' + (detail.error || response.status) + (detail.hint ? ' — ' + detail.hint : ''));
      return;
    }
    const data = await response.json();
    const text = (data.text || '').trim();
    if (!text) {
      voiceShowStatus('🎙️ ⚠️ whisper returned empty text');
      return;
    }
    const inp = document.getElementById('chatInput');
    // Stop-phrase wins over auto-send. If the user said "stop listening"
    // / "thanks jarvis" etc., disable hands-free so the loop stops re-arming
    // and DON'T paste the stop phrase into the chat box.
    if (jarvisCheckStopPhrase(text)) {
      voiceShowStatus('👂 stop-phrase heard — disabling hands-free');
      jarvisHandsFree = false;
      try { localStorage.setItem('jarvisHandsFree', '0'); } catch { /* noop */ }
      const hfBtn = document.getElementById('jarvisHandsFreeBtn');
      if (hfBtn && !hfBtn.disabled) hfBtn.textContent = '🎤 hands-free off';
      jarvisWakeStop();
      return;
    }
    if (inp) {
      const sep = inp.value && !/\s$/.test(inp.value) ? ' ' : '';
      inp.value = inp.value + sep + text;
      autoSize(inp);
      inp.focus();
    }
    // Auto-send when invoked by silence detection or hands-free mode.
    if (opts.autoSend && inp && inp.value.trim()) {
      try {
        sendMessage();
        voiceShowStatus('🎙️ ✅ sent — listening for next…');
      } catch (sendErr) {
        voiceShowStatus('🎙️ ⚠️ transcribed but auto-send failed: ' + (sendErr && sendErr.message ? sendErr.message : sendErr));
      }
    }
    voiceShowStatus('🎙️ ✅ transcribed: "' + text.slice(0, 60) + '"');
  } catch (err) {
    voiceShowStatus('🎙️ ❌ transcribe request failed: ' + (err && err.message ? err.message : err));
  }
}

function jarvisResampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

function jarvisEncodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────

function showKeyboardShortcuts() {
  const existing = document.getElementById('shortcutsModal');
  if (existing) { existing.remove(); return; }
  const shortcuts = [
    ['Enter', 'Send message'],
    ['Ctrl+Enter', 'Send message (alternative)'],
    ['Shift+Enter', 'New line in message'],
    ['Escape', 'Stop streaming / close panels'],
    ['/', 'Open slash command palette'],
    ['Ctrl+/', 'Open slash commands from anywhere'],
    ['Ctrl+Shift+K', 'Toggle kill switch (block all tools)'],
    ['?', 'Show this shortcuts guide'],
  ];
  const rows = shortcuts.map(([key, desc]) =>
    '<div class="shortcut-row">'
    + '<kbd class="shortcut-key">' + esc(key) + '</kbd>'
    + '<span class="shortcut-desc">' + esc(desc) + '</span>'
    + '</div>'
  ).join('');
  const modal = document.createElement('div');
  modal.id = 'shortcutsModal';
  modal.className = 'shortcuts-modal';
  modal.innerHTML = '<div class="shortcuts-dialog">'
    + '<div class="shortcuts-header"><h3>Keyboard Shortcuts</h3><button class="btn-sm" onclick="document.getElementById(\'shortcutsModal\').remove()">Close</button></div>'
    + rows
    + '</div>';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

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

// ─── Theme toggle ───────────────────────────────────────────────────

function toggleTheme() {
  const apply = () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('harness-theme', isLight ? 'light' : 'dark');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = isLight ? '☀️' : '🌙';
  };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduced) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

function restoreTheme() {
  const saved = localStorage.getItem('harness-theme');
  if (saved === 'light') {
    document.documentElement.classList.add('light');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = '☀️';
  }
  const accent = localStorage.getItem('harness-accent');
  if (accent) applyAccentColor(accent);
}

function setAccentColor(color) {
  applyAccentColor(color);
  localStorage.setItem('harness-accent', color);
}

function applyAccentColor(color) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-hover', color + 'cc');
  document.documentElement.style.setProperty('--accent-bg', color + '1a');
  document.querySelectorAll('.accent-pick').forEach((btn) => {
    btn.style.outline = btn.style.background === color ? '2px solid var(--text)' : 'none';
  });
}

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
  } catch (error) {
    showToast('Restore failed: ' + (error && error.message ? error.message : error));
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

// ─── Harness Controls ─────────────────────────────────────────────

// -- Run Profiles --
let currentRunProfile = '';
async function loadRunProfiles() {
  try {
    const res = await fetch('/api/profiles');
    const data = await res.json();
    const sel = document.getElementById('runProfileSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— None —</option>';
    for (const p of (data.profiles || [])) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === currentRunProfile) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) { /* silent */ }
}
async function applyRunProfile(name) {
  currentRunProfile = name;
  const desc = document.getElementById('runProfileDescription');
  if (!name) { if (desc) desc.textContent = ''; return; }
  try {
    const res = await fetch('/api/profiles/' + encodeURIComponent(name));
    const profile = await res.json();
    if (desc) desc.textContent = profile.description || '';
    showToast('Profile "' + name + '" selected');
  } catch (e) { showToast('Failed to load profile'); }
}

// -- Injection Defence --
let currentInjectionMode = 'off';
function setInjectionMode(mode, el) {
  currentInjectionMode = mode;
  document.querySelectorAll('.injection-mode-option').forEach(o => o.classList.remove('active'));
  if (el) el.classList.add('active');
  updateSetting('injectionDefence', { mode: mode });
}
function hydrateInjectionMode(mode) {
  currentInjectionMode = mode || 'off';
  const idx = mode === 'flag' ? 1 : mode === 'block' ? 2 : 0;
  document.querySelectorAll('.injection-mode-option').forEach((o, i) => {
    o.classList.toggle('active', i === idx);
  });
}

// -- Read-before-write gate --
let currentRbwMode = 'off';
function setRbwMode(mode, el) {
  currentRbwMode = mode;
  document.querySelectorAll('.rbw-mode-option').forEach(o => o.classList.remove('active'));
  if (el) el.classList.add('active');
  updateSetting('readBeforeWrite', { mode: mode });
}
function hydrateRbwMode(mode) {
  currentRbwMode = mode || 'off';
  const idx = mode === 'warn' ? 1 : mode === 'enforce' ? 2 : 0;
  document.querySelectorAll('.rbw-mode-option').forEach((o, i) => {
    o.classList.toggle('active', i === idx);
  });
}

// -- Repo Map --
async function refreshRepoMap(force) {
  const info = document.getElementById('repoMapInfo');
  if (info) info.innerHTML = 'Scanning…';
  try {
    const url = force ? '/api/repo-map?force=true' : '/api/repo-map';
    const res = await fetch(url);
    const map = await res.json();
    if (info) {
      const stack = (map.frameworks || []).join(', ');
      const pkgMgr = map.packageManager ? ' · ' + map.packageManager : '';
      const testCmd = map.testCommand ? '<br>Test: <code>' + esc(map.testCommand) + '</code>' : '';
      const checkCmd = map.checkCommand ? '<br>Check: <code>' + esc(map.checkCommand) + '</code>' : '';
      const doNotEdit = (map.doNotEdit || []).length;
      info.innerHTML = '<div class="repo-map-card"><strong>' + esc(stack) + '</strong>' + esc(pkgMgr) + testCmd + checkCmd + '<br><span style="color:var(--text-dim)">' + doNotEdit + ' do-not-edit paths</span></div>';
    }
    showToast(force ? 'Repo map rescanned' : 'Repo map loaded');
  } catch (e) {
    if (info) info.textContent = 'Failed to load';
    showToast('Failed to load repo map');
  }
}

// -- Memory Health --
async function checkMemoryHealth() {
  const info = document.getElementById('memoryHealthInfo');
  if (info) info.innerHTML = 'Checking…';
  try {
    const res = await fetch('/api/memory/stale');
    const data = await res.json();
    const stale = data.stale || {};
    const files = Object.keys(stale);
    if (files.length === 0) {
      if (info) info.innerHTML = '<span class="harness-badge fresh">✓ All fresh</span> No stale entries found';
    } else {
      let total = 0;
      for (const f of files) total += stale[f].length;
      const badges = files.map(f => '<span class="harness-badge stale">' + esc(f) + ': ' + stale[f].length + '</span>').join(' ');
      if (info) info.innerHTML = badges + '<br><span style="color:var(--text-dim)">' + total + ' stale section(s) across ' + files.length + ' file(s)</span>';
    }
  } catch (e) {
    if (info) info.textContent = 'Failed to check';
  }
}

// -- Task Contract --
function renderTaskContract(contract) {
  const info = document.getElementById('taskContractInfo');
  if (!info) return;
  if (!contract || !contract.goal) { info.textContent = 'No active contract'; return; }
  const lines = [];
  lines.push('Goal: ' + contract.goal);
  lines.push('Mode: ' + (contract.mode || '—'));
  if (contract.constraints && contract.constraints.length) lines.push('Constraints: ' + contract.constraints.join('; '));
  if (contract.blocked_paths && contract.blocked_paths.length) lines.push('Blocked: ' + contract.blocked_paths.join(', '));
  if (contract.validation && contract.validation.length) lines.push('Validation: ' + contract.validation.join(', '));
  lines.push('Max turns: ' + (contract.max_turns || '—'));
  lines.push('Approval: ' + (contract.approval_required ? 'Yes' : 'No'));
  info.textContent = lines.join('\n');
}

// ─── Evaluation & Prompts ─────────────────────────────────────────

// -- Confidence Calibration --
async function loadCalibrationReports() {
  const el = document.getElementById('calibrationReports');
  if (el) el.innerHTML = 'Loading…';
  try {
    const res = await fetch('/api/calibration/reports');
    const data = await res.json();
    const reports = data.reports || [];
    if (reports.length === 0) {
      if (el) el.innerHTML = '<span class="harness-badge info">No data yet</span> Record samples via the API to see calibration.';
      return;
    }
    let html = '';
    for (const r of reports) {
      const brierPct = (r.brierScore * 100).toFixed(1);
      const ecePct = (r.ece * 100).toFixed(1);
      const overPct = (r.overconfidenceRatio * 100).toFixed(0);
      const barWidth = Math.max(2, Math.min(100, 100 - r.brierScore * 200));
      html += '<div style="margin:4px 0;padding:6px 0;border-bottom:1px solid var(--border)">';
      html += '<strong>' + esc(r.model) + '</strong> <span style="color:var(--text-dim)">(' + r.totalSamples + ' samples)</span>';
      html += '<div class="calibration-bar"><span>Brier: ' + brierPct + '%</span><div class="calibration-bar-track"><div class="calibration-bar-fill" style="width:' + barWidth + '%"></div></div></div>';
      html += '<span style="font-size:10px;color:var(--text-dim)">ECE: ' + ecePct + '% · Overconfidence: ' + overPct + '%</span>';
      html += '</div>';
    }
    if (el) el.innerHTML = html;
  } catch (e) {
    if (el) el.textContent = 'Failed to load';
  }
}

// -- Golden Traces --
async function loadGoldenTraces() {
  const el = document.getElementById('goldenTracesList');
  if (el) el.innerHTML = 'Loading…';
  try {
    const res = await fetch('/api/golden-traces');
    const data = await res.json();
    const traces = data.traces || [];
    if (traces.length === 0) {
      if (el) el.innerHTML = '<span class="harness-badge info">No traces</span> Capture golden traces via the API.';
      return;
    }
    let html = '';
    for (const t of traces) {
      const tags = (t.tags || []).map(tag => '<span class="harness-badge info">' + esc(tag) + '</span>').join(' ');
      html += '<div class="golden-trace-item" title="' + esc(t.id) + '">';
      html += '<strong>' + esc(t.name) + '</strong> <span style="color:var(--text-dim)">' + esc(t.model) + '</span>';
      if (tags) html += '<div style="margin-top:2px">' + tags + '</div>';
      html += '<div style="color:var(--text-dim);font-size:10px">' + esc(t.capturedAt || '') + ' · ' + (t.expectedToolCalls || []).length + ' tools · ' + (t.expectedFiles || []).length + ' files</div>';
      html += '</div>';
    }
    if (el) el.innerHTML = html;
  } catch (e) {
    if (el) el.textContent = 'Failed to load';
  }
}

// -- Versioned Prompts --
async function loadPromptRegistries() {
  try {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    const sel = document.getElementById('promptRegistrySelect');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Select —</option>';
    for (const name of (data.prompts || [])) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === prev) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) { /* silent */ }
}
async function loadPromptRegistry(name) {
  const el = document.getElementById('promptVersionInfo');
  if (!name) { if (el) el.textContent = 'Select a registry'; return; }
  try {
    const res = await fetch('/api/prompts/' + encodeURIComponent(name));
    const registry = await res.json();
    if (!registry || !registry.versions) { if (el) el.textContent = 'Not found'; return; }
    let html = '<div style="margin-bottom:4px"><strong>Active: v' + registry.activeVersion + '</strong> · ' + registry.versions.length + ' version(s)</div>';
    for (const v of registry.versions.slice().reverse().slice(0, 5)) {
      const isActive = v.version === registry.activeVersion;
      html += '<div class="prompt-version-item' + (isActive ? ' active-version' : '') + '">';
      html += '<strong>v' + v.version + '</strong> ' + esc(v.label || '(no label)');
      html += ' <span style="color:var(--text-dim)">' + esc(v.createdAt || '') + '</span>';
      if (v.changelog) html += '<div style="color:var(--text-dim);font-size:10px;margin-top:2px">' + esc(v.changelog) + '</div>';
      if (!isActive) html += ' <a href="#" onclick="activatePromptVersion(\'' + esc(name) + '\',' + v.version + ');event.preventDefault()" style="font-size:10px">activate</a>';
      html += '</div>';
    }
    if (registry.versions.length > 5) html += '<div style="color:var(--text-dim);font-size:10px">… and ' + (registry.versions.length - 5) + ' more</div>';
    if (el) el.innerHTML = html;
  } catch (e) {
    if (el) el.textContent = 'Failed to load';
  }
}
async function activatePromptVersion(name, version) {
  try {
    await fetch('/api/prompts/' + encodeURIComponent(name) + '/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: version }),
    });
    showToast('Activated v' + version);
    loadPromptRegistry(name);
  } catch (e) { showToast('Failed to activate version'); }
}
async function rollbackActivePrompt() {
  const sel = document.getElementById('promptRegistrySelect');
  const name = sel ? sel.value : '';
  if (!name) { showToast('Select a prompt registry first'); return; }
  try {
    const res = await fetch('/api/prompts/' + encodeURIComponent(name) + '/rollback', { method: 'POST' });
    if (!res.ok) { const err = await res.json(); showToast(err.error || 'Cannot rollback'); return; }
    const prev = await res.json();
    showToast('Rolled back to v' + prev.version);
    loadPromptRegistry(name);
  } catch (e) { showToast('Rollback failed'); }
}
async function saveNewPromptVersion() {
  const sel = document.getElementById('promptRegistrySelect');
  const name = sel ? sel.value : '';
  if (!name) { showToast('Select a prompt registry first'); return; }
  const sysPrompt = document.getElementById('sysPrompt');
  const content = sysPrompt ? sysPrompt.value : '';
  if (!content.trim()) { showToast('System prompt is empty'); return; }
  const label = 'v' + Date.now();
  try {
    const res = await fetch('/api/prompts/' + encodeURIComponent(name) + '/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, label: label, changelog: 'Saved from UI' }),
    });
    const version = await res.json();
    showToast('Saved prompt v' + version.version);
    loadPromptRegistry(name);
  } catch (e) { showToast('Failed to save version'); }
}

// ─── Injection warning in chat ────────────────────────────────────

// Patch: scan outgoing messages for injection patterns and show inline warning
const _originalSendChat = typeof sendChat === 'function' ? sendChat : null;
// We don't patch sendChat since it's complex; instead show warning on injection match in the message area.

// ─── Init: load on settings open ─────────────────────────────────
// Hook into loadSettings to hydrate our new controls
const _originalHydrateEnd = typeof refreshWalkthroughChecklist === 'function' ? refreshWalkthroughChecklist : null;
const _patchedRefreshWalkthroughChecklist = function() {
  if (_originalHydrateEnd) _originalHydrateEnd();
  // Hydrate harness controls from current settings
  try {
    loadRunProfiles();
    loadPromptRegistries();
    // Injection / RBW mode will be hydrated from settings when we have them
  } catch(e) {}
};
// Override — if refreshWalkthroughChecklist exists, wrap it
if (typeof refreshWalkthroughChecklist === 'function') {
  window.refreshWalkthroughChecklist = _patchedRefreshWalkthroughChecklist;
}