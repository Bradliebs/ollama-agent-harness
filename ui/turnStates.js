// Turn state strips for chat replies.
//
// Every turn that does not end with a normal answer gets one consistent strip
// under it: what happened, and a Retry button that re-runs the same prompt.
// Before this, failures showed ad-hoc text, a turn that returned nothing showed
// nothing at all, and reopening an interrupted chat gave no hint it was cut off.
(function () {
  const STATES = {
    failed: { icon: '⚠️', label: 'Reply failed' },
    cancelled: { icon: '⏹', label: 'Stopped' },
    interrupted: { icon: '⏸', label: 'Reply interrupted' },
    empty: { icon: '∅', label: 'No reply' },
  };

  /** Map how a turn ended to a state name, or null when it ended normally. */
  function classifyTurn(outcome) {
    if (outcome.stopped) return 'cancelled';
    if (outcome.failed) return 'failed';
    if (outcome.doneReason === 'inactivity_timeout' || outcome.doneReason === 'aborted') return 'interrupted';
    if (!outcome.hasText) return 'empty';
    return null;
  }

  function describeDetail(state, doneReason) {
    if (state === 'interrupted' && doneReason === 'inactivity_timeout') return 'The model stopped responding before it finished.';
    if (state === 'interrupted') return 'The run ended before a final answer was written.';
    if (state === 'empty') return 'The model returned no text.';
    if (state === 'cancelled') return 'You stopped this reply.';
    return 'Something went wrong while generating this reply.';
  }

  /**
   * Append (or replace) a state strip under a message element.
   * `onRetry` is optional; without it no button is shown.
   */
  function appendTurnState(msgEl, state, options) {
    if (!msgEl || !STATES[state]) return null;
    const opts = options || {};
    const body = msgEl.querySelector('.msg-body') || msgEl;
    const existing = body.querySelector('.turn-state');
    if (existing) existing.remove();
    const strip = document.createElement('div');
    strip.className = 'turn-state turn-state-' + state;
    strip.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'turn-state-text';
    text.textContent = STATES[state].icon + ' ' + STATES[state].label + ' — ' + (opts.detail || describeDetail(state, opts.doneReason));
    strip.appendChild(text);
    if (typeof opts.onRetry === 'function') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'msg-action-btn turn-state-retry';
      retry.textContent = '🔁 Retry';
      retry.title = 'Run the same prompt again';
      retry.addEventListener('click', () => {
        retry.disabled = true;
        opts.onRetry();
      });
      strip.appendChild(retry);
    }
    body.appendChild(strip);
    return strip;
  }

  if (typeof window !== 'undefined') {
    window.classifyTurn = classifyTurn;
    window.appendTurnState = appendTurnState;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { classifyTurn, describeDetail };
})();
