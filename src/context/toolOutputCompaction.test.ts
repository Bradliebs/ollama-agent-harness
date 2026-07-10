import {
  TRUNCATION_MARKER,
  stripAnsiCodes,
  collapseCarriageReturns,
  collapseBlankRuns,
  headTailTruncate,
  compactToolOutput,
} from './toolOutputCompaction';

describe('stripAnsiCodes', () => {
  it('removes color and cursor escape sequences', () => {
    const input = '\u001b[31mred\u001b[0m \u001b[1mbold\u001b[22m done';
    expect(stripAnsiCodes(input)).toBe('red bold done');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsiCodes('no escapes here')).toBe('no escapes here');
  });

  it('does not alter URLs or JSON', () => {
    const input = '{"url":"https://example.com/a?b=1&c=2","n":3}';
    expect(stripAnsiCodes(input)).toBe(input);
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps only the final segment of a carriage-return run', () => {
    expect(collapseCarriageReturns('10%\r50%\r100%')).toBe('100%');
  });

  it('handles carriage returns independently per line', () => {
    expect(collapseCarriageReturns('a\rb\nc\rd')).toBe('b\nd');
  });

  it('leaves lines without carriage returns unchanged', () => {
    expect(collapseCarriageReturns('line one\nline two')).toBe('line one\nline two');
  });
});

describe('collapseBlankRuns', () => {
  it('collapses multiple blank lines to one by default', () => {
    expect(collapseBlankRuns('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('respects a custom maxBlank', () => {
    expect(collapseBlankRuns('a\n\n\n\nb', 0)).toBe('a\nb');
  });

  it('treats whitespace-only lines as blank', () => {
    expect(collapseBlankRuns('a\n   \n\t\nb')).toBe('a\n   \nb');
  });
});

describe('headTailTruncate', () => {
  it('returns input unchanged when within budget', () => {
    expect(headTailTruncate('short', 100)).toBe('short');
  });

  it('keeps head and tail and is shorter than the input', () => {
    const text = 'HEAD' + 'x'.repeat(2000) + 'TAILMARKER';
    const out = headTailTruncate(text, 500);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAILMARKER')).toBe(true);
  });

  it('reports the number of omitted characters', () => {
    const text = 'a'.repeat(5000);
    const out = headTailTruncate(text, 400);
    expect(out).toMatch(/\[\d+ chars omitted\]/);
  });

  it('still marks truncation when the budget is tiny', () => {
    const out = headTailTruncate('a'.repeat(100), 20);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});

describe('compactToolOutput', () => {
  it('returns content untouched when it already fits', () => {
    const result = compactToolOutput('short result', 500);
    expect(result.content).toBe('short result');
    expect(result.freedChars).toBe(0);
  });

  it('returns the full cleaned form when noise removal fits the budget', () => {
    // Each line is ANSI-wrapped (18 chars); stripping yields 9 chars/line.
    // 60 lines: 1080 original -> 540 cleaned, fits a 600 budget without a cut.
    const noisy = '\u001b[32mlog line\u001b[0m\n'.repeat(60);
    const result = compactToolOutput(noisy, 600);
    expect(result.content).not.toContain('\u001b[');
    expect(result.content).not.toContain(TRUNCATION_MARKER);
    expect(result.freedChars).toBeGreaterThan(0);
  });

  it('falls back to head+tail truncation when noise removal is insufficient', () => {
    const content = 'x'.repeat(10_000);
    const result = compactToolOutput(content, 500);
    expect(result.content.length).toBeLessThan(content.length);
    expect(result.content).toContain(TRUNCATION_MARKER);
    expect(result.freedChars).toBeGreaterThan(0);
  });

  it('preserves the tail of a log where errors live', () => {
    const content = 'start\n' + 'noise\n'.repeat(2000) + 'FATAL: build failed';
    const result = compactToolOutput(content, 500);
    expect(result.content).toContain('FATAL: build failed');
    expect(result.content.startsWith('start')).toBe(true);
  });
});
