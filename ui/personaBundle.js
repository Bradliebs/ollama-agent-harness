(function attachPersonaBundle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessPersonaBundle = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createPersonaBundleApi() {
  // Persona bundles extend the existing agent-profile concept (system prompt
  // + model + identity) with the *names* of the skills and MCP servers a
  // use-case relies on. Storing names — not state — keeps this purely
  // additive: applying a profile never auto-pins skills or starts MCP
  // processes (those carry capability/safety side effects). Instead, loading
  // a profile produces a non-destructive "staging plan" the user acts on.
  //
  // Everything here is pure (no DOM, no fetch) so it is require-able and
  // unit-testable, mirroring followUps.js / execMetrics.js.

  function uniqSorted(values) {
    const seen = new Set();
    const out = [];
    for (const v of values) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  // From the runtime skills list (each `{ name, pinned }`), return the sorted
  // distinct names of the pinned ones. Pinned skills are the ones the user
  // has deliberately kept, so they best represent a use-case's skill set.
  function extractPinnedSkillNames(skills) {
    if (!Array.isArray(skills)) return [];
    return uniqSorted(skills.filter((s) => s && s.pinned).map((s) => (s && s.name) || ''));
  }

  // From the MCP runtime server list, return sorted distinct identifiers,
  // preferring `id`, then `catalogName`, then `name`.
  function extractMcpServerNames(servers) {
    if (!Array.isArray(servers)) return [];
    return uniqSorted(servers.map((s) => (s && (s.id || s.catalogName || s.name)) || ''));
  }

  // Compute what is missing to make the current environment match a saved
  // bundle. Returns the bundle items NOT already present in `current`.
  // Never lists anything to remove — staging is additive and opt-in.
  function computeStagingPlan(bundle, current) {
    const b = bundle || {};
    const c = current || {};
    const havePinned = new Set(Array.isArray(c.pinnedSkills) ? c.pinnedSkills : []);
    const haveMcp = new Set(Array.isArray(c.mcpServers) ? c.mcpServers : []);
    const wantSkills = Array.isArray(b.skills) ? b.skills : [];
    const wantMcp = Array.isArray(b.mcp) ? b.mcp : [];
    const skillsToPin = uniqSorted(wantSkills).filter((name) => !havePinned.has(name));
    const mcpToStage = uniqSorted(wantMcp).filter((name) => !haveMcp.has(name));
    return {
      skillsToPin,
      mcpToStage,
      satisfied: skillsToPin.length === 0 && mcpToStage.length === 0,
    };
  }

  // One-line, user-facing summary of a staging plan. Empty string when the
  // bundle carried no skills/MCP or the environment already satisfies it, so
  // callers can skip showing a toast.
  function summarizeStagingPlan(plan) {
    if (!plan || plan.satisfied) return '';
    const parts = [];
    if (plan.skillsToPin.length > 0) {
      parts.push('pin ' + plan.skillsToPin.length + ' skill(s): ' + plan.skillsToPin.join(', '));
    }
    if (plan.mcpToStage.length > 0) {
      parts.push('start ' + plan.mcpToStage.length + ' MCP server(s): ' + plan.mcpToStage.join(', '));
    }
    if (parts.length === 0) return '';
    return 'To match this profile, ' + parts.join(' · ') + '.';
  }

  return {
    extractPinnedSkillNames,
    extractMcpServerNames,
    computeStagingPlan,
    summarizeStagingPlan,
  };
});
