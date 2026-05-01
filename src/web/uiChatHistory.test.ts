import * as path from 'path';

const chatHistory = require(path.join(process.cwd(), 'ui', 'chatHistory.js')) as {
  CHAT_SESSION_KEY: string;
  CHAT_SESSION_VERSION: number;
  MAX_OUTBOUND_HISTORY_BYTES: number;
  MAX_STORED_CHAT_MESSAGES: number;
  MAX_STORED_MESSAGE_CHARS: number;
  loadPersistedChatSession: (storage?: StorageLike) => { version: number; currentChatId?: string; messages: Array<{ role: string; content: string }> } | null;
  outboundChatHistory: (messages: Array<{ role: string; content: string }>, BlobCtor?: typeof Blob) => Array<{ role: string; content: string }>;
  saveChatSession: (args: { chatMessages: Array<{ role: string; content: unknown }>; currentChatId: string | null; storage?: StorageLike }) => void;
  sanitizedMessages: (messages: Array<{ role: string; content: unknown }>) => Array<{ role: string; content: string }>;
};

type StorageLike = {
  getItem: jest.Mock<string | null, [string]>;
  removeItem: jest.Mock<void, [string]>;
  setItem: jest.Mock<void, [string, string]>;
};

function createStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    removeItem: jest.fn((key: string) => { values.delete(key); }),
    setItem: jest.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

describe('ui outbound chat history budget', () => {
  it('keeps newest prior turns within the outbound byte budget', async () => {
    const chatMessages = [
      { role: 'user', content: 'old-a ' + 'a'.repeat(400_000) },
      { role: 'assistant', content: 'old-b ' + 'b'.repeat(400_000) },
      { role: 'user', content: 'old-c ' + 'c'.repeat(400_000) },
      { role: 'assistant', content: 'middle ' + 'y'.repeat(400_000) },
      { role: 'user', content: 'new ' + 'z'.repeat(10_000) },
      { role: 'assistant', content: 'current turn' },
    ];

    const history = chatHistory.outboundChatHistory(chatMessages, Blob);
    const bytes = new Blob([JSON.stringify(history)]).size;

    expect(bytes).toBeLessThanOrEqual(chatHistory.MAX_OUTBOUND_HISTORY_BYTES);
    expect(history.map((message) => message.content.slice(0, 6))).toEqual(['old-b ', 'old-c ', 'middle', 'new zz']);
    expect(history.some((message) => message.content.startsWith('old-a'))).toBe(false);
    expect(history.some((message) => message.content.startsWith('current turn'))).toBe(false);
  });

  it('sanitizes and truncates saved chat sessions', () => {
    const storage = createStorage();
    const chatMessages = [
      { role: 'system', content: 'drop me' },
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: 'a'.repeat(chatHistory.MAX_STORED_MESSAGE_CHARS + 5) },
      { role: 'assistant', content: '' },
      ...Array.from({ length: chatHistory.MAX_STORED_CHAT_MESSAGES + 5 }, (_, index) => ({
        role: 'user',
        content: index === chatHistory.MAX_STORED_CHAT_MESSAGES + 4 ? 'z'.repeat(chatHistory.MAX_STORED_MESSAGE_CHARS + 5) : `recent-${index}`,
      })),
    ];

    chatHistory.saveChatSession({ chatMessages, currentChatId: 'chat-1', storage });

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const [, raw] = storage.setItem.mock.calls[0];
    const saved = JSON.parse(raw) as { version: number; currentChatId: string; messages: Array<{ role: string; content: string }> };
    expect(saved).toMatchObject({ version: chatHistory.CHAT_SESSION_VERSION, currentChatId: 'chat-1' });
    expect(saved.messages).toHaveLength(chatHistory.MAX_STORED_CHAT_MESSAGES);
    expect(saved.messages[0].content).toBe('recent-5');
    expect(saved.messages.at(-1)?.content).toBe('z'.repeat(chatHistory.MAX_STORED_MESSAGE_CHARS));
    expect(saved.messages.every((message) => message.role === 'user' || message.role === 'assistant')).toBe(true);
  });

  it('removes empty sessions without writing storage', () => {
    const storage = createStorage();

    chatHistory.saveChatSession({ chatMessages: [], currentChatId: null, storage });

    expect(storage.removeItem).toHaveBeenCalledWith(chatHistory.CHAT_SESSION_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('loads only valid persisted sessions', () => {
    const valid = createStorage({
      [chatHistory.CHAT_SESSION_KEY]: JSON.stringify({ version: chatHistory.CHAT_SESSION_VERSION, currentChatId: 'chat-2', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(chatHistory.loadPersistedChatSession(valid)).toMatchObject({ currentChatId: 'chat-2' });

    const invalidJson = createStorage({ [chatHistory.CHAT_SESSION_KEY]: '{' });
    expect(chatHistory.loadPersistedChatSession(invalidJson)).toBeNull();

    const wrongVersion = createStorage({
      [chatHistory.CHAT_SESSION_KEY]: JSON.stringify({ version: chatHistory.CHAT_SESSION_VERSION + 1, messages: [] }),
    });
    expect(chatHistory.loadPersistedChatSession(wrongVersion)).toBeNull();

    const missingMessages = createStorage({
      [chatHistory.CHAT_SESSION_KEY]: JSON.stringify({ version: chatHistory.CHAT_SESSION_VERSION }),
    });
    expect(chatHistory.loadPersistedChatSession(missingMessages)).toBeNull();
  });
});