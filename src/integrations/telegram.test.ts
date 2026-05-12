import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TelegramBot, buildTelegramEmptyModelResponse, getTelegramPollingLockInfo, normalizeTelegramChatText, summarizeTelegramToolResult } from './telegram';

describe('Telegram bridge responses', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses Telegram API endpoints for send/edit/delete and file links', async () => {
    const fetchMock = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop();
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (method === 'sendMessage') {
        expect(body).toMatchObject({ chat_id: 123, text: 'hello', parse_mode: 'Markdown' });
        return telegramResponse({ message_id: 9, chat: { id: 123 }, text: 'hello' });
      }
      if (method === 'sendChatAction') {
        expect(body).toMatchObject({ chat_id: 123, action: 'typing' });
        return telegramResponse(true);
      }
      if (method === 'getFile') return telegramResponse({ file_path: 'documents/test.pdf' });
      if (method === 'editMessageText') {
        expect(body).toMatchObject({ chat_id: 123, message_id: 9, text: 'updated' });
        return telegramResponse(true);
      }
      if (method === 'deleteMessage') {
        expect(body).toMatchObject({ chat_id: 123, message_id: 9 });
        return telegramResponse(true);
      }
      throw new Error(`Unexpected method ${method}`);
    }) as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;

    const bot = new TelegramBot('token');

    await expect(bot.sendMessage(123, 'hello', { parse_mode: 'Markdown' })).resolves.toMatchObject({ message_id: 9 });
    await expect(bot.sendChatAction(123, 'typing')).resolves.toBeUndefined();
    await expect(bot.getFileLink('file-1')).resolves.toBe('https://api.telegram.org/file/bottoken/documents/test.pdf');
    await expect(bot.editMessageText('updated', { chat_id: 123, message_id: 9 })).resolves.toBeUndefined();
    await expect(bot.deleteMessage(123, 9)).resolves.toBeUndefined();
  });

  it('surfaces Telegram API errors', async () => {
    global.fetch = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) => telegramResponse(null, false, 400, 'Bad Request')) as jest.MockedFunction<typeof fetch>;

    const bot = new TelegramBot('token');

    await expect(bot.sendMessage(123, 'hello')).rejects.toThrow('Bad Request');
  });

  it('aborts polling when stopped', async () => {
    let capturedSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as jest.MockedFunction<typeof fetch>;

    const bot = new TelegramBot('token', { polling: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedSignal?.aborted).toBe(false);
    bot.stopPolling();
    await new Promise((resolve) => setImmediate(resolve));
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('summarizes successful tool results when the model returns empty final text', () => {
    const result = buildTelegramEmptyModelResponse({
      toolCalls: 1,
      toolNames: ['file_write'],
      toolSummaries: ['✅ file_write: Wrote 123 chars to bullet-journal.md'],
      errors: [],
      doneReason: 'completed',
    });

    expect(result).toContain('✅ Done.');
    expect(result).toContain('Wrote 123 chars');
    expect(result).not.toContain('No response from the model');
  });

  it('surfaces stream errors before empty-response fallback text', () => {
    const result = buildTelegramEmptyModelResponse({
      toolCalls: 0,
      toolNames: [],
      toolSummaries: [],
      errors: ['Model call failed'],
      doneReason: 'error',
    });

    expect(result).toContain('Harness reported an error');
    expect(result).toContain('Model call failed');
  });

  it('returns concise message for max_turns_synthesized with no visible text', () => {
    const result = buildTelegramEmptyModelResponse({
      toolCalls: 5,
      toolNames: ['web_search', 'web_read'],
      toolSummaries: [],
      errors: [],
      doneReason: 'max_turns_synthesized',
    });

    expect(result).toContain('Done');
    expect(result).toContain('synthesis');
    expect(result).not.toContain('did not return a readable final message');
  });

  it('normalizes journal slash commands into readable chat requests', () => {
    expect(normalizeTelegramChatText('/add cut up decking')).toContain('Add a task to my bullet journal to cut up decking');
    expect(normalizeTelegramChatText('/complete cut up decking')).toContain('Close task cut up decking');
    expect(normalizeTelegramChatText('/log')).toContain('concise, readable summary');
  });

  it('hides noisy internal tool output from Telegram fallbacks', () => {
    expect(summarizeTelegramToolResult('list_files', true, '[file] journal.md')).toBe('');
    expect(summarizeTelegramToolResult('bash', true, 'STDOUT: + Task added: Cut up decking')).toBe('✅ Added task: Cut up decking');
    expect(summarizeTelegramToolResult('bash', true, 'STDOUT: [OK] Telegram message sent successfully!')).toBe('');
  });

  it('reports active Telegram poller lock ownership', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-telegram-lock-'));
    await fs.mkdir(path.join(projectDir, '.harness'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.harness', 'telegram-poller.lock.json'), JSON.stringify({ pid: process.pid }), 'utf-8');

    expect(getTelegramPollingLockInfo(projectDir)).toMatchObject({
      pid: process.pid,
      active: true,
      ownedByCurrentProcess: true,
    });
  });
});

function telegramResponse(result: unknown, ok = true, status = 200, description?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ ok, result, description }),
  } as Response;
}
