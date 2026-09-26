import { SourceLedger, appendSourcesFooter, guessedUrlHint, SOURCES_FOOTER_HEADING } from './sourceLedger';
import type { ToolCall, ToolResult } from '../types';

const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `c-${name}`, name, input });
const ok = (output: string): ToolResult => ({ success: true, output });
const fail = (output: string, error: string): ToolResult => ({ success: false, output, error });

describe('SourceLedger', () => {
  it('records successful reads once, with a sanitised title', () => {
    const ledger = new SourceLedger();
    const output = 'Content from https://example.com/a:\n\n<external_content source="web">\n## Big [News] *today* here\nbody\n</external_content>';
    ledger.recordRead(call('web_read', { url: 'https://example.com/a#frag' }), ok(output));
    ledger.recordRead(call('web_read', { url: 'https://www.example.com/a/' }), ok(output));
    ledger.recordRead(call('web_read', { url: 'https://example.com/b' }), fail('HTTP 403 Forbidden', 'HTTP 403'));
    expect(ledger.list()).toEqual([{ url: 'https://example.com/a', title: 'Big News today here' }]);
  });

  it('falls back to the hostname when no usable title line exists', () => {
    const ledger = new SourceLedger();
    ledger.recordRead(call('web_fetch', { url: 'https://www.bbc.co.uk/x' }), ok('<x>\nok\n</x>'));
    expect(ledger.list()[0].title).toBe('bbc.co.uk');
  });

  it('ignores non-web tools and non-http urls', () => {
    const ledger = new SourceLedger();
    ledger.recordRead(call('file_read', { url: 'https://example.com' }), ok('x'));
    ledger.recordRead(call('web_read', { url: 'file:///etc/passwd' }), ok('x'));
    expect(ledger.list()).toEqual([]);
  });
});

describe('guessedUrlHint', () => {
  it('flags a 404 on a URL that web_search never returned', () => {
    const ledger = new SourceLedger();
    ledger.recordSearchResults(call('web_search', { query: 'q' }), ok('1. Title\n   https://news.example.com/real-story\n   snippet'));
    const hint = guessedUrlHint(call('web_read', { url: 'https://news.example.com/made-up-slug' }), fail('HTTP 404 Not Found', 'HTTP 404'), ledger);
    expect(hint).toMatch(/probably guessed/);
  });

  it('stays quiet when the 404 URL came from search results', () => {
    const ledger = new SourceLedger();
    ledger.recordSearchResults(call('web_search', { query: 'q' }), ok('see https://news.example.com/real-story.'));
    expect(guessedUrlHint(call('web_read', { url: 'http://www.news.example.com/real-story/' }), fail('HTTP 404 Not Found', 'HTTP 404'), ledger)).toBeNull();
  });

  it('stays quiet for non-404 failures and successes', () => {
    const ledger = new SourceLedger();
    expect(guessedUrlHint(call('web_read', { url: 'https://a.example/x' }), fail('HTTP 403 Forbidden', 'HTTP 403'), ledger)).toBeNull();
    expect(guessedUrlHint(call('web_read', { url: 'https://a.example/x' }), ok('fine'), ledger)).toBeNull();
  });
});

describe('appendSourcesFooter', () => {
  const sources = [
    { url: 'https://a.example/1', title: 'First source' },
    { url: 'https://b.example/(x)', title: 'Second source' },
  ];

  it('appends a numbered list when the answer has no links', () => {
    const result = appendSourcesFooter('The answer.\n', sources);
    expect(result).toBe(`The answer.\n\n${SOURCES_FOOTER_HEADING}\n1. [First source](https://a.example/1)\n2. [Second source](https://b.example/%28x%29)`);
  });

  it('leaves answers that already link sources untouched', () => {
    expect(appendSourcesFooter('See https://a.example/1 for more.', sources)).toBe('See https://a.example/1 for more.');
  });

  it('leaves empty answers and source-less runs untouched', () => {
    expect(appendSourcesFooter('', sources)).toBe('');
    expect(appendSourcesFooter('Answer', [])).toBe('Answer');
  });

  it('caps the list at 8 sources', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://s${i}.example/`, title: `Source ${i}` }));
    const lines = appendSourcesFooter('Answer', many).split('\n').filter((line) => /^\d+\. /.test(line));
    expect(lines).toHaveLength(8);
  });
});
