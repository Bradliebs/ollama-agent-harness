import { withRetry, HarnessError, PermissionDeniedError, errorToToolResult } from './errors';

describe('Error Recovery', () => {
  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await withRetry(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failure then succeeds', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce('ok');
      const result = await withRetry(fn, 3, 10);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws after max attempts exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('connection refused persistently'));
      await expect(withRetry(fn, 2, 10)).rejects.toThrow('connection refused');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-recoverable errors', async () => {
      const fn = jest.fn().mockRejectedValue(
        new PermissionDeniedError('bash', 'denied'),
      );
      await expect(withRetry(fn, 3, 10)).rejects.toThrow('Permission denied');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry unclassified errors (no implicit retry)', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('something weird happened'));
      await expect(withRetry(fn, 3, 10)).rejects.toThrow('something weird');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('errorToToolResult', () => {
    it('formats HarnessError with code', () => {
      const err = new HarnessError('test error', 'TEST_CODE');
      const result = errorToToolResult(err);
      expect(result.success).toBe(false);
      expect(result.output).toContain('TEST_CODE');
      expect(result.output).toContain('test error');
    });

    it('formats plain Error', () => {
      const result = errorToToolResult(new Error('oops'));
      expect(result.output).toContain('oops');
    });

    it('formats string error', () => {
      const result = errorToToolResult('string error');
      expect(result.output).toContain('string error');
    });
  });
});
