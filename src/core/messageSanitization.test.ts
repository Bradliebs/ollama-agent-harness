import type { Message } from 'ollama';
import { hasLoneSurrogate, sanitizeMessages, stripLoneSurrogates } from './messageSanitization';

describe('hasLoneSurrogate', () => {
  it('returns false for plain ASCII', () => {
    expect(hasLoneSurrogate('hello world')).toBe(false);
  });

  it('returns false for well-formed emoji (surrogate pair)', () => {
    // U+1F600 (grinning face) encodes as D83D DE00 — a valid pair.
    expect(hasLoneSurrogate('\uD83D\uDE00')).toBe(false);
  });

  it('returns true for a lone high surrogate', () => {
    // High surrogate followed by a non-low character.
    expect(hasLoneSurrogate('a\uD83Db')).toBe(true);
    expect(hasLoneSurrogate('end\uD83D')).toBe(true);
  });

  it('returns true for a lone low surrogate', () => {
    expect(hasLoneSurrogate('a\uDE00b')).toBe(true);
    expect(hasLoneSurrogate('\uDE00')).toBe(true);
  });
});

describe('stripLoneSurrogates', () => {
  it('returns input unchanged when no lone surrogates exist', () => {
    const input = 'hello \uD83D\uDE00 world';
    expect(stripLoneSurrogates(input)).toBe(input);
  });

  it('replaces a lone high surrogate with U+FFFD by default', () => {
    expect(stripLoneSurrogates('a\uD83Db')).toBe('a\uFFFDb');
  });

  it('replaces a lone low surrogate with U+FFFD by default', () => {
    expect(stripLoneSurrogates('a\uDE00b')).toBe('a\uFFFDb');
  });

  it('preserves well-formed surrogate pairs around lone surrogates', () => {
    // Valid emoji (D83D DE00) + lone high (D83D) + valid emoji (D83D DE03)
    const input = '\uD83D\uDE00\uD83D\uD83D\uDE03';
    expect(stripLoneSurrogates(input)).toBe('\uD83D\uDE00\uFFFD\uD83D\uDE03');
  });

  it('accepts a custom replacement string', () => {
    expect(stripLoneSurrogates('a\uD83Db', '?')).toBe('a?b');
    expect(stripLoneSurrogates('a\uDE00b', '')).toBe('ab');
  });

  it('is idempotent', () => {
    const dirty = 'x\uD83Dy\uDE00z';
    const once = stripLoneSurrogates(dirty);
    const twice = stripLoneSurrogates(once);
    expect(twice).toBe(once);
  });

  it('survives JSON.stringify after sanitisation', () => {
    const dirty = 'reasoning: \uD83D...continues';
    const clean = stripLoneSurrogates(dirty);
    // The dirty string should round-trip via JSON without throwing once
    // sanitised; that's the whole point of the helper.
    expect(() => JSON.parse(JSON.stringify({ s: clean }))).not.toThrow();
  });
});

describe('sanitizeMessages', () => {
  it('returns the same array reference when nothing needs cleaning', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi \uD83D\uDE00' },
    ];
    expect(sanitizeMessages(messages)).toBe(messages);
  });

  it('strips lone surrogates from content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'clean' },
      { role: 'assistant', content: 'dirty \uD83D end' },
    ];
    const out = sanitizeMessages(messages);
    expect(out).not.toBe(messages);
    expect(out[0].content).toBe('clean');
    expect(out[1].content).toBe('dirty \uFFFD end');
  });

  it('strips lone surrogates from string side-fields like reasoning', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'visible',
        reasoning: 'inner \uDE00 monologue',
      },
    ] as unknown as Message[];
    const out = sanitizeMessages(messages);
    expect((out[0] as unknown as { reasoning: string }).reasoning).toBe('inner \uFFFD monologue');
    expect(out[0].content).toBe('visible');
  });

  it('strips lone surrogates from string array side-fields', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'visible',
        reasoning_details: ['fine', 'broken \uD83D piece'],
      },
    ] as unknown as Message[];
    const out = sanitizeMessages(messages);
    const details = (out[0] as unknown as { reasoning_details: string[] }).reasoning_details;
    expect(details[0]).toBe('fine');
    expect(details[1]).toBe('broken \uFFFD piece');
  });

  it('leaves unknown structured side-fields untouched', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'visible',
        tool_calls: [{ id: '1', function: { name: 'x', arguments: '{}' } }],
      },
    ] as unknown as Message[];
    const out = sanitizeMessages(messages);
    expect(out).toBe(messages);
  });
});
