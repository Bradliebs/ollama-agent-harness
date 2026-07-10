(function attachExecMetrics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessExecMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createExecMetricsApi() {
  // Self-contained compact duration formatter so this module stays
  // dependency-free and require-able in tests. Mirrors app.js's
  // formatDurationCompact for visual consistency in the footer.
  function formatMs(ms) {
    if (!ms || ms < 0) return '0s';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + 'm' + (s ? s + 's' : '');
  }

  // Build the extra footer chips kratos surfaces that the harness footer
  // lacked: time-to-first-token (responsiveness) and tool count (how much
  // work this turn did). Both are derived client-side; absent data emits
  // nothing rather than a misleading zero. Numeric-only inputs, so no
  // HTML escaping is required.
  function formatExecMetrics(usage) {
    if (!usage || typeof usage !== 'object') return '';
    const chips = [];
    const ttft = Number(usage.firstTokenLatencyMs);
    if (Number.isFinite(ttft) && ttft > 0) {
      chips.push(
        '<span class="meta-sep">·</span>'
        + '<span title="Time from request to the first streamed token">⏱ '
        + formatMs(ttft) + ' to first token</span>',
      );
    }
    const tools = Number(usage.toolCallCount);
    if (Number.isFinite(tools) && tools > 0) {
      chips.push(
        '<span class="meta-sep">·</span>'
        + '<span title="Tool calls completed during this turn">🔧 '
        + tools + (tools === 1 ? ' tool' : ' tools') + '</span>',
      );
    }
    return chips.join('');
  }

  return { formatExecMetrics, formatMs };
});
