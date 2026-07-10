(function attachFollowUps(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessFollowUps = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createFollowUpsApi() {
  const FILE_RE = /[\w./-]+\.(?:ts|tsx|js|jsx|py|md|json|yml|yaml|sh|html|css|sql)\b/g;

  // Pull the distinct filenames an assistant reply mentions so a follow-up
  // can reference one concretely ("Show a diff of foo.ts") instead of the
  // vague "the changes". Deduped on basename to stay short.
  function extractFiles(text) {
    const matches = String(text || '').match(FILE_RE) || [];
    const seen = new Set();
    const files = [];
    for (const m of matches) {
      const base = m.split('/').pop();
      if (!base || seen.has(base)) continue;
      seen.add(base);
      files.push(base);
    }
    return files;
  }

  // Heuristic, offline, zero-latency follow-up suggestions. Pattern-matches
  // the reply and the user's question, prefers concrete suggestions, then
  // falls back to generic ones. Returns up to `max` (default 3) deduped
  // strings. Pure — no DOM — so it is require-able and testable.
  function computeFollowUps(userText, assistantText, max) {
    const cap = Number.isFinite(max) && max > 0 ? max : 3;
    const out = [];
    const ut = (userText || '').toLowerCase();
    const at = assistantText || '';
    const files = extractFiles(at);
    const hasCode = /```[\s\S]+?```/.test(at);
    const hasError = /(error|failed|exception|stack trace)/i.test(at);
    const hasNumbers = /\d{2,}/.test(at);
    const askedHow = /\b(how|why|explain|what)\b/.test(ut);

    if (hasError) out.push('Diagnose the error and propose a fix.');
    if (hasCode && !hasError) out.push('Add tests for that code.');
    if (files.length === 1) out.push('Show a diff of ' + files[0] + '.');
    else if (files.length > 1) out.push('Show a diff of the changes.');
    if (askedHow) out.push('Give me a worked example.');
    if (hasNumbers) out.push('Where do those numbers come from?');
    // Generic fallbacks always offered last.
    out.push('Summarize this in 3 bullets.');
    out.push('What would you do differently next?');

    // Dedup + cap.
    const seen = new Set();
    const final = [];
    for (const s of out) {
      if (seen.has(s)) continue;
      seen.add(s);
      final.push(s);
      if (final.length >= cap) break;
    }
    return final;
  }

  return { computeFollowUps, extractFiles };
});
