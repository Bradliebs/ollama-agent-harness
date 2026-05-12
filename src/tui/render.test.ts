import {
  formatActiveSubagentsBar,
  formatChatEntry,
  formatStatusLine,
  parseSseChunk,
  stripAnsi,
  wrapText,
} from './render';

describe('tui/render', () => {
  describe('wrapText', () => {
    it('preserves explicit newlines', () => {
      expect(wrapText('a\nb', 80)).toEqual(['a', 'b']);
    });

    it('greedy-wraps long lines', () => {
      const lines = wrapText('the quick brown fox', 10);
      // We accept any wrap that fits within 10 chars per line and reassembles.
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
      expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe('the quick brown fox');
    });

    it('hard-breaks tokens longer than the width', () => {
      const lines = wrapText('aaaaaaaaaaaa', 4);
      expect(lines).toEqual(['aaaa', 'aaaa', 'aaaa']);
    });

    it('is safe with width <= 0', () => {
      expect(wrapText('hello', 0)).toEqual(['hello']);
    });
  });

  describe('formatChatEntry', () => {
    it('renders without color when useColor is false', () => {
      const lines = formatChatEntry({ role: 'user', text: 'hi' }, 80, false);
      expect(lines[0]).toBe('you hi');
    });

    it('indents continuation lines to align with the role label', () => {
      const lines = formatChatEntry({ role: 'assistant', text: 'one\ntwo' }, 80, false);
      expect(lines[0]).toBe('asst one');
      expect(lines[1].startsWith(' '.repeat('asst '.length))).toBe(true);
    });

    it('emits ANSI codes when useColor is true', () => {
      const [first] = formatChatEntry({ role: 'user', text: 'hi' }, 80, true);
      expect(first).toMatch(/\x1b\[/);
      expect(stripAnsi(first)).toBe('you hi');
    });
  });

  describe('formatActiveSubagentsBar', () => {
    it('returns an empty string when no sub-agents are active', () => {
      expect(formatActiveSubagentsBar([], false)).toBe('');
    });

    it('formats one pill per sub-agent with name, age, and short id', () => {
      const out = formatActiveSubagentsBar(
        [
          { id: 'abcdef0123', name: 'researcher', durationMs: 12_000 },
          { id: 'qrstuv4567', name: 'developer', durationMs: 1_500 },
        ],
        false,
      );
      expect(out).toContain('Active sub-agents (2)');
      expect(out).toContain('researcher 12s');
      expect(out).toContain('[abcdef01]');
      expect(out).toContain('developer 2s');
    });
  });

  describe('formatStatusLine', () => {
    it('shows a filled dot when connected', () => {
      const out = formatStatusLine({ connected: true, model: 'llama3.1:8b' }, false);
      expect(out).toContain('●');
      expect(out).toContain('llama3.1:8b');
    });

    it('shows an empty dot and hint when disconnected', () => {
      const out = formatStatusLine({ connected: false, model: '', hint: 'reconnecting' }, false);
      expect(out).toContain('○');
      expect(out).toContain('no model');
      expect(out).toContain('reconnecting');
    });
  });

  describe('parseSseChunk', () => {
    it('parses one or more data: lines into JSON payloads', () => {
      const buffer = 'data: {"type":"text","content":"hi"}\n\ndata: {"type":"done"}\n';
      const result = parseSseChunk(buffer);
      expect(result.events).toHaveLength(2);
      expect(result.events[0].payload).toEqual({ type: 'text', content: 'hi' });
      expect(result.events[1].payload).toEqual({ type: 'done' });
      expect(result.remainder).toBe('');
    });

    it('returns the unconsumed remainder when the buffer ends mid-line', () => {
      const result = parseSseChunk('data: {"type":"text","content":"');
      expect(result.events).toHaveLength(0);
      expect(result.remainder).toBe('data: {"type":"text","content":"');
    });

    it('skips malformed lines without throwing', () => {
      const result = parseSseChunk('data: not-json\ndata: {"type":"text","content":"a"}\n');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].payload).toEqual({ type: 'text', content: 'a' });
    });

    it('treats [DONE] as a synthetic done event', () => {
      const result = parseSseChunk('data: [DONE]\n');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].payload).toEqual({ type: 'done' });
    });
  });
});
