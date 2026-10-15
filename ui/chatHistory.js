(function attachChatHistory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessChatHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createChatHistoryApi() {
  const CHAT_SESSION_KEY = 'harness.chatSession';
  const CHAT_SESSION_VERSION = 1;
  const MAX_STORED_CHAT_MESSAGES = 50;
  const MAX_STORED_MESSAGE_CHARS = 200000;
  const MAX_OUTBOUND_HISTORY_BYTES = 750000;

  // Optional per-reply extras: a one-line summary of the tools used (sent with
  // the history so the model remembers what it did, not just what it said),
  // and the run id and changed files that let the UI undo that reply's edits.
  function replyExtras(message) {
    const extras = {};
    if (message.role !== 'assistant') return extras;
    if (typeof message.activity === 'string' && message.activity) extras.activity = message.activity.slice(0, 600);
    if (typeof message.runId === 'string' && /^[\w.-]{1,80}$/.test(message.runId)) extras.runId = message.runId;
    if (Array.isArray(message.fileChanges)) extras.fileChanges = message.fileChanges.filter((f) => typeof f === 'string').slice(0, 20).map((f) => f.slice(0, 300));
    return extras;
  }

  function sanitizedMessages(messages) {
    return messages.slice(-MAX_STORED_CHAT_MESSAGES).map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content.slice(0, MAX_STORED_MESSAGE_CHARS) : '',
      ...replyExtras(message),
    })).filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content);
  }

  function saveChatSession({ chatMessages, currentChatId, storage = localStorage }) {
    try {
      if (chatMessages.length === 0 && !currentChatId) {
        storage.removeItem(CHAT_SESSION_KEY);
        return;
      }
      storage.setItem(CHAT_SESSION_KEY, JSON.stringify({
        version: CHAT_SESSION_VERSION,
        currentChatId,
        messages: sanitizedMessages(chatMessages),
      }));
    } catch {}
  }

  function loadPersistedChatSession(storage = localStorage) {
    try {
      const raw = storage.getItem(CHAT_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CHAT_SESSION_VERSION || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch { return null; }
  }

  function outboundChatHistory(chatMessages, BlobCtor = Blob) {
    let bytes = 2;
    const selected = [];
    const prior = chatMessages.slice(0, -1).filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content);
    for (let i = prior.length - 1; i >= 0; i--) {
      const message = {
        role: prior[i].role,
        content: prior[i].content.slice(0, MAX_STORED_MESSAGE_CHARS),
      };
      const activity = replyExtras(prior[i]).activity;
      if (activity) message.activity = activity;
      const serialized = JSON.stringify(message);
      const nextBytes = bytes + new BlobCtor([serialized]).size + (selected.length > 0 ? 1 : 0);
      if (nextBytes > MAX_OUTBOUND_HISTORY_BYTES) break;
      selected.unshift(message);
      bytes = nextBytes;
    }
    return selected;
  }

  return {
    CHAT_SESSION_KEY,
    CHAT_SESSION_VERSION,
    MAX_STORED_CHAT_MESSAGES,
    MAX_STORED_MESSAGE_CHARS,
    MAX_OUTBOUND_HISTORY_BYTES,
    loadPersistedChatSession,
    outboundChatHistory,
    saveChatSession,
    sanitizedMessages,
  };
});