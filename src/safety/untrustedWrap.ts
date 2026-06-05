// Untrusted-content envelope — the structural half of the harness's
// indirect-prompt-injection (OWASP LLM01) defense.
//
// `injectionDefence.ts` is the *detection* tripwire that scans inbound text
// for known attack patterns. This module is the complementary *structural*
// defense: it wraps any content the harness fetched from the outside world
// (web pages, PDFs, emails, chat-platform messages) in `<external_content>`
// tags before that content enters the model context. The system prompt tells
// the model to treat anything inside those tags as data, never instructions.
//
// What this does NOT promise:
//   - It is a deterministic envelope, not a probabilistic shield. The model
//     may still occasionally honor an injection — permission gates, the
//     confirmation broker, and the autonomy budget are the rest of the answer.
//   - The closing-tag escape defends the common breakout vectors (exact,
//     case, whitespace, attribute-bearing closing tags). It does not claim to
//     defeat every unicode-normalization or token-encoding attack.

export const EXTERNAL_CONTENT_TAG = 'external_content';

/**
 * Provenance labels for wrapped content. Keep this a closed union so callers
 * can't invent ad-hoc sources that the system prompt doesn't account for.
 */
export type UntrustedSource =
  | 'web'
  | 'pdf'
  | 'email'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | 'webhook'
  | 'file';

const MAX_LABEL_ATTR_LENGTH = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a function that neutralizes any closing-tag variant of `tagName` in a
 * body. Matches optional surrounding whitespace, any case, and a trailing
 * attribute tail so `</external_content foo="bar">` can't break the envelope.
 */
function makeClosingTagEscaper(tagName: string): (body: string) => string {
  const closeTagRe = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  return (body) => body.replace(closeTagRe, () => `<\\/${tagName}>`);
}

const escapeExternalContentClosingTag = makeClosingTagEscaper(EXTERNAL_CONTENT_TAG);

/**
 * Sanitize a free-form provenance detail (e.g. a sender handle or URL) for use
 * as a model-visible XML-like attribute value. Strips control characters and
 * the characters that could break out of the attribute, then caps length.
 */
function sanitizeAttr(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || char === '<' || char === '>' || char === '"' || char === '&') {
      continue;
    }
    result += char;
    if (result.length >= MAX_LABEL_ATTR_LENGTH) break;
  }
  return result;
}

export interface WrapOptions {
  /**
   * Optional provenance detail surfaced as a `label="..."` attribute — e.g. a
   * source URL, sender handle, or filename. Sanitized before use.
   */
  label?: string;
}

/**
 * Wrap untrusted `body` in `<external_content source="...">` tags, escaping
 * any embedded closing-tag variants so the envelope can't be broken out of.
 *
 * Empty bodies intentionally produce an empty envelope so callers can rely on
 * "external input is always wrapped" without special-casing blanks.
 */
export function wrapUntrusted(source: UntrustedSource, body: string, opts: WrapOptions = {}): string {
  const safe = escapeExternalContentClosingTag(body ?? '');

  let attrs = `source="${source}"`;
  if (opts.label !== undefined) {
    const label = sanitizeAttr(opts.label);
    if (label) attrs += ` label="${label}"`;
  }

  return `<${EXTERNAL_CONTENT_TAG} ${attrs}>\n${safe}\n</${EXTERNAL_CONTENT_TAG}>`;
}
