import type { Message } from 'ollama';

/**
 * Strip lone UTF-16 surrogate code points (U+D800–U+DFFF) from message
 * content before it reaches `JSON.stringify` on the wire. Reasoning models
 * (Kimi, GLM, Mimo, some local llama.cpp builds) occasionally emit lone
 * surrogates inside reasoning blocks; the next turn's request-body
 * serialisation then throws `Invalid string length` / `Invalid Unicode`
 * errors and the entire conversation aborts. This module mirrors the
 * Hermes `message_sanitization.py` walk: scan strings AND nested
 * structured fields, remove lone surrogates, leave well-formed surrogate
 * PAIRS (real emoji and CJK supplementary characters) intact.
 *
 * The default replacement is U+FFFD (REPLACEMENT CHARACTER) so a
 * sanitised message remains visually distinguishable in logs without
 * collapsing whitespace or shifting token offsets in surprising ways.
 *
 * Idempotent: a sanitised string contains no lone surrogates, so a second
 * pass produces the same output. Stateless: no module-level mutation.
 */

const REPLACEMENT_CHAR = '\uFFFD';
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

/** True if the input string contains at least one lone surrogate. */
export function hasLoneSurrogate(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      // Expect a low surrogate to follow.
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (next < LOW_SURROGATE_START || next > LOW_SURROGATE_END) return true;
      i += 1;
      continue;
    }
    if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      // Lone low surrogate without a preceding high.
      return true;
    }
  }
  return false;
}

/**
 * Remove lone surrogates from `input`, replacing each with `replacement`
 * (default U+FFFD). Well-formed surrogate pairs are preserved so emoji and
 * supplementary-plane characters survive the walk.
 */
export function stripLoneSurrogates(input: string, replacement: string = REPLACEMENT_CHAR): string {
  if (!hasLoneSurrogate(input)) return input;
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) {
        out += input.charAt(i) + input.charAt(i + 1);
        i += 1;
        continue;
      }
      out += replacement;
      continue;
    }
    if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      out += replacement;
      continue;
    }
    out += input.charAt(i);
  }
  return out;
}

/**
 * Walk a `Message[]` array and strip lone surrogates from `content` and
 * any nested string fields callers commonly attach (`reasoning`,
 * `reasoning_details`, `tool_calls[].function.arguments`). Unknown fields
 * are passed through unchanged so this is safe to chain ahead of any
 * provider-specific transform.
 *
 * Returns a new array only when at least one message changed; otherwise
 * returns the input reference (cheap no-op for the common case).
 */
export function sanitizeMessages(messages: Message[]): Message[] {
  let mutated = false;
  const out = messages.map((msg) => {
    const next = sanitizeOneMessage(msg);
    if (next !== msg) mutated = true;
    return next;
  });
  return mutated ? out : messages;
}

function sanitizeOneMessage(msg: Message): Message {
  let mutated = false;
  let nextContent = msg.content;
  if (typeof msg.content === 'string' && hasLoneSurrogate(msg.content)) {
    nextContent = stripLoneSurrogates(msg.content);
    mutated = true;
  }

  // Walk known structured side-fields. We only touch fields whose values are
  // strings or arrays of strings; objects of unknown shape are passed
  // through so this stays a sanitiser, not a normaliser.
  const extras = msg as unknown as Record<string, unknown>;
  const nextExtras: Record<string, unknown> = {};
  for (const key of Object.keys(extras)) {
    if (key === 'role' || key === 'content') continue;
    const value = extras[key];
    if (typeof value === 'string' && hasLoneSurrogate(value)) {
      nextExtras[key] = stripLoneSurrogates(value);
      mutated = true;
    } else if (Array.isArray(value)) {
      let arrMutated = false;
      const sanitisedArr = value.map((entry) => {
        if (typeof entry === 'string' && hasLoneSurrogate(entry)) {
          arrMutated = true;
          return stripLoneSurrogates(entry);
        }
        return entry;
      });
      if (arrMutated) {
        nextExtras[key] = sanitisedArr;
        mutated = true;
      }
    }
  }

  if (!mutated) return msg;
  return { ...msg, content: nextContent ?? '', ...nextExtras } as Message;
}
