import { buildTelegramEmptyModelResponse, normalizeTelegramChatText, summarizeTelegramToolResult } from './telegram';

describe('Telegram bridge responses', () => {
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

  it('normalizes journal slash commands into readable chat requests', () => {
    expect(normalizeTelegramChatText('/add cut up decking')).toContain('Add a task to my bullet journal to cut up decking');
    expect(normalizeTelegramChatText('/log')).toContain('concise, readable summary');
  });

  it('hides noisy internal tool output from Telegram fallbacks', () => {
    expect(summarizeTelegramToolResult('list_files', true, '[file] journal.md')).toBe('');
    expect(summarizeTelegramToolResult('bash', true, 'STDOUT: + Task added: Cut up decking')).toBe('✅ Added task: Cut up decking');
    expect(summarizeTelegramToolResult('bash', true, 'STDOUT: [OK] Telegram message sent successfully!')).toBe('');
  });
});
