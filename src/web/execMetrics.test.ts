import * as path from 'path';

const execMetrics = require(path.join(process.cwd(), 'ui', 'execMetrics.js')) as {
  formatExecMetrics: (usage: unknown) => string;
  formatMs: (ms: number) => string;
};

describe('ui exec metrics footer chips', () => {
  describe('formatExecMetrics', () => {
    it('emits a time-to-first-token chip when latency is present', () => {
      const html = execMetrics.formatExecMetrics({ firstTokenLatencyMs: 850 });
      expect(html).toContain('to first token');
      expect(html).toContain('850ms');
    });

    it('emits a tool-count chip with correct pluralization', () => {
      expect(execMetrics.formatExecMetrics({ toolCallCount: 1 })).toContain('1 tool</span>');
      expect(execMetrics.formatExecMetrics({ toolCallCount: 3 })).toContain('3 tools</span>');
    });

    it('renders both chips together when both metrics are present', () => {
      const html = execMetrics.formatExecMetrics({ firstTokenLatencyMs: 1200, toolCallCount: 2 });
      expect(html).toContain('to first token');
      expect(html).toContain('2 tools');
    });

    it('stays silent when metrics are absent or non-positive', () => {
      expect(execMetrics.formatExecMetrics({})).toBe('');
      expect(execMetrics.formatExecMetrics({ firstTokenLatencyMs: 0, toolCallCount: 0 })).toBe('');
      expect(execMetrics.formatExecMetrics({ firstTokenLatencyMs: -5 })).toBe('');
      expect(execMetrics.formatExecMetrics(null)).toBe('');
      expect(execMetrics.formatExecMetrics(undefined)).toBe('');
    });

    it('ignores non-numeric metric values', () => {
      expect(execMetrics.formatExecMetrics({ firstTokenLatencyMs: 'fast', toolCallCount: 'lots' })).toBe('');
    });
  });

  describe('formatMs', () => {
    it('formats sub-second, second, and minute ranges', () => {
      expect(execMetrics.formatMs(450)).toBe('450ms');
      expect(execMetrics.formatMs(2500)).toBe('2.5s');
      expect(execMetrics.formatMs(65000)).toBe('1m5s');
    });

    it('returns 0s for falsy or negative input', () => {
      expect(execMetrics.formatMs(0)).toBe('0s');
      expect(execMetrics.formatMs(-10)).toBe('0s');
    });
  });
});
