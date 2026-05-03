(function attachToolActivity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessToolActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createToolActivityApi() {
  function summaryText(count, errorCount) {
    return errorCount > 0
      ? 'Tool activity: ' + count + ' event(s), ' + errorCount + ' need attention'
      : 'Tool activity: ' + count + ' event(s)';
  }

  function createToolActivityBox(documentRef, chatArea) {
    const shell = documentRef.createElement('details');
    shell.className = 'tool-activity';
    shell.dataset.toolCount = '0';
    shell.dataset.errorCount = '0';
    const summary = documentRef.createElement('summary');
    summary.textContent = 'Tool activity';
    const box = documentRef.createElement('div');
    box.className = 'tool-activity-items';
    shell.appendChild(summary);
    shell.appendChild(box);
    chatArea.appendChild(shell);
    return box;
  }

  function updateToolActivitySummary(toolBox, isError) {
    const shell = toolBox.closest('.tool-activity');
    if (!shell) return;
    const count = Number(shell.dataset.toolCount || '0') + 1;
    const errorCount = Number(shell.dataset.errorCount || '0') + (isError ? 1 : 0);
    shell.dataset.toolCount = String(count);
    shell.dataset.errorCount = String(errorCount);
    if (isError) {
      shell.open = true;
      shell.classList.add('has-error');
    }
    const summary = shell.querySelector('summary');
    if (summary) summary.textContent = summaryText(count, errorCount);
  }

  return {
    createToolActivityBox,
    summaryText,
    updateToolActivitySummary,
  };
});