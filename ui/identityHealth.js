// Topbar persona badge.
//
// Fetches /api/identity/health and (1) shows the persona name from SOUL.md in
// the topbar when no display name is set, and (2) shows a badge when SOUL.md is
// missing, a placeholder, or a proposal is waiting for review. A test run once
// replaced SOUL.md with fixture text and nothing on screen showed it for weeks.
(function () {
  const BADGE_ID = 'identityHealthBadge';
  const RECHECK_MS = 10 * 60 * 1000;
  let lastCheck = 0;

  function describe(health) {
    if (health.issue === 'missing') {
      return { level: 'error', label: '⚠ Persona missing', title: 'SOUL.md is missing, so the assistant has no persona. Open Identity to restore it from history.' };
    }
    if (health.issue === 'placeholder') {
      return { level: 'error', label: '⚠ Persona is placeholder text', title: 'SOUL.md holds placeholder or test text instead of a persona. Open Identity to restore a snapshot from history.' };
    }
    if (health.issue === 'too-short') {
      return { level: 'warning', label: '⚠ Persona looks empty', title: 'SOUL.md has only ' + health.soulChars + ' characters. Open Identity to review it.' };
    }
    if (health.proposalPending && health.proposalStale) {
      return { level: 'warning', label: 'Outdated persona proposal', title: 'A SOUL.md proposal is waiting, but SOUL.md changed after it was generated. Review it carefully or discard it in Identity.' };
    }
    if (health.proposalPending) {
      return { level: 'info', label: 'Persona update to review', title: 'A proposed SOUL.md update is waiting. Accept or discard it in Identity.' };
    }
    return null;
  }

  function renderBadge(state) {
    let badge = document.getElementById(BADGE_ID);
    if (!state) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      const logo = document.getElementById('topbarLogo');
      if (!logo || !logo.parentNode) return;
      badge = document.createElement('button');
      badge.id = BADGE_ID;
      badge.type = 'button';
      badge.addEventListener('click', () => {
        if (typeof window.selectFromMore === 'function') window.selectFromMore('identity');
      });
      logo.parentNode.insertBefore(badge, logo.nextSibling);
    }
    badge.className = 'identity-health-badge identity-health-' + state.level;
    badge.textContent = state.label;
    badge.title = state.title;
    badge.setAttribute('aria-label', state.title);
  }

  async function checkIdentityHealth() {
    lastCheck = Date.now();
    try {
      const response = await fetch('/api/identity/health');
      if (!response.ok) return;
      const health = await response.json();
      window.harnessPersonaName = health.name || '';
      if (health.name && typeof updateTopbarName === 'function' && typeof currentAgentName !== 'undefined' && !currentAgentName) {
        updateTopbarName('');
        document.title = health.name + ' — Ollama Agent Harness';
      }
      renderBadge(describe(health));
    } catch (_) {
      // Server unreachable: the status pill already reports that.
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { describe };
  if (typeof window === 'undefined') return;
  window.checkIdentityHealth = checkIdentityHealth;
  window.describeIdentityHealth = describe;
  document.addEventListener('DOMContentLoaded', () => {
    checkIdentityHealth();
    window.addEventListener('focus', () => {
      if (Date.now() - lastCheck > RECHECK_MS) checkIdentityHealth();
    });
  });
})();
