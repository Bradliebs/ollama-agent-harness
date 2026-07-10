import { compressToolOutput, compressToolResult, DEFAULT_RULES } from './outputCompression';
import { ToolDispatcher } from './dispatcher';
import type { Tool, ToolResult } from '../types';

function makeTool(name: string, output: string, isReadOnly = true): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    isReadOnly,
    execute: async (): Promise<ToolResult> => ({ success: true, output }),
  };
}

describe('compressToolOutput', () => {
  it('dedupes consecutive identical lines', () => {
    const input = Array(100).fill('connection retry...').join('\n');
    const { output, rulesApplied } = compressToolOutput('bash', input);
    expect(rulesApplied).toContain('dedupe-lines');
    expect(output).toContain('connection retry...');
    expect(output).toContain('identical line');
    expect(Array.from(output).length).toBeLessThan(Array.from(input).length);
  });

  it('strips HTML for web tools and leaves no tags', () => {
    const html = '<html><body><p>Hello</p><script>evil()</script><p>World</p></body></html>';
    const { output, rulesApplied } = compressToolOutput('web_fetch', html);
    expect(rulesApplied).toContain('html-to-text');
    expect(output).not.toMatch(/<[^>]+>/);
    expect(output).toContain('Hello');
    expect(output).toContain('World');
    expect(output).not.toContain('evil()');
  });

  it('does not strip HTML for non-web tools', () => {
    const html = '<p>literal markup in a file</p>';
    const { rulesApplied } = compressToolOutput('file_read', html);
    expect(rulesApplied).not.toContain('html-to-text');
  });

  it('head-tail clamp keeps both ends and reports elided count', () => {
    const input = 'A'.repeat(5000) + 'B'.repeat(5000) + 'C'.repeat(5000);
    const { output, rulesApplied } = compressToolOutput('file_read', input, { maxChars: 2000 });
    expect(rulesApplied).toContain('head-tail-clamp');
    expect(output.startsWith('A')).toBe(true);
    expect(output.endsWith('C')).toBe(true);
    expect(output).toMatch(/\[\d+ characters elided\]/);
    expect(Array.from(output).length).toBeLessThanOrEqual(2000);
  });

  it('passes JSON payloads through byte-identical', () => {
    const json = JSON.stringify({ items: [1, 2, 3], nested: { a: '  spaced  ', dup: 'x\nx\nx' } });
    const { output, rulesApplied } = compressToolOutput('web_search', json);
    expect(output).toBe(json);
    expect(rulesApplied).toHaveLength(0);
  });

  it('preserves multi-byte / emoji / CJK graphemes through the clamp', () => {
    const unit = '日本語🎉漢字';
    const input = unit.repeat(2000);
    const { output } = compressToolOutput('file_read', input, { maxChars: 500 });
    // No replacement characters from split surrogate pairs.
    expect(output).not.toContain('\uFFFD');
    expect(output).toContain('🎉');
  });

  it('never inflates output', () => {
    const inputs = ['', 'short', 'a\nb\nc', '<p>x</p>', JSON.stringify({ a: 1 })];
    for (const input of inputs) {
      const { originalChars, compressedChars } = compressToolOutput('bash', input);
      expect(compressedChars).toBeLessThanOrEqual(originalChars);
    }
  });

  it('rules are idempotent', () => {
    const input = '<p>Hi</p>\n\n\n\nsame\nsame\nsame';
    const once = compressToolOutput('web_fetch', input).output;
    const twice = compressToolOutput('web_fetch', once).output;
    expect(twice).toBe(once);
  });

  it('exposes a non-empty default rule overlay', () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
  });
});

describe('compressToolResult', () => {
  it('passes through failed results untouched', () => {
    const failed: ToolResult = { success: false, output: 'x\nx\nx\nx', error: 'boom' };
    const { result, saved } = compressToolResult('bash', failed);
    expect(result).toBe(failed);
    expect(saved).toBe(0);
  });

  it('reports characters saved on shrink', () => {
    const verbose = Array(50).fill('dup line').join('\n');
    const { saved } = compressToolResult('bash', { success: true, output: verbose });
    expect(saved).toBeGreaterThan(0);
  });
});

describe('ToolDispatcher compression gating', () => {
  const verbose = Array(50).fill('dup line').join('\n');

  it('leaves output raw when compression is disabled (default)', async () => {
    const dispatcher = new ToolDispatcher([makeTool('grep', verbose)]);
    const [{ result }] = await dispatcher.dispatch([{ name: 'grep', input: {} }]);
    expect(result.output).toBe(verbose);
  });

  it('compresses output when compressOutput is set', async () => {
    const dispatcher = new ToolDispatcher([makeTool('grep', verbose)]);
    const [{ result }] = await dispatcher.dispatch(
      [{ name: 'grep', input: {} }],
      undefined,
      undefined,
      { compressOutput: true },
    );
    expect(result.output).not.toBe(verbose);
    expect(result.output).toContain('identical line');
  });
});
