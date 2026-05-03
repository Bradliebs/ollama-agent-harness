import { buildTelegramEmptyModelResponse } from './telegram';

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
});
