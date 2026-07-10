// Minimal in-house template engine for structured prompt rendering.
//
// Supports three constructs (Mustache-flavoured, deliberately small):
//   {{key}}              — substitute the value bound to `key` (key chars: A-Z, a-z, 0-9, _, -)
//   {{#if key}}…{{/if}}  — emit body when `key` is truthy (non-empty string, true, non-zero number, non-empty array/object)
//   {{#unless key}}…{{/unless}}  — emit body when `key` is falsy or missing
//
// Unbound `{{key}}` placeholders are left in place (matches renderSubAgentPrompt's
// existing behaviour — the LLM sees the literal placeholder, which is more
// debuggable than a silent drop).
//
// No loops, no nested helpers, no expression language. If a future caller needs
// `{{#each}}`, add it explicitly with tests. We deliberately do NOT pull in
// Mustache/Handlebars/Minijinja — keeps the dependency surface clean and
// matches the harness's in-house-parser convention (see parseSimpleYaml).

/** Context value any template variable may carry. */
export type TemplateValue = string | number | boolean | null | undefined | TemplateContext | TemplateValue[];

/** Flat or nested context map passed to renderTemplate. */
export type TemplateContext = { [key: string]: TemplateValue };

/** Result of a template render — includes the list of placeholders that
 * could not be resolved so callers can decide whether to warn. */
export interface RenderResult {
  output: string;
  unresolved: string[];
}

const KEY_PATTERN = '[A-Za-z_][\\w-]*';
const VAR_RE = new RegExp(`\\{\\{\\s*(${KEY_PATTERN})\\s*\\}\\}`, 'g');
const BLOCK_RE = new RegExp(
  `\\{\\{\\s*#(if|unless)\\s+(${KEY_PATTERN})\\s*\\}\\}([\\s\\S]*?)\\{\\{\\s*/\\1\\s*\\}\\}`,
  'g',
);

function isTruthy(value: TemplateValue): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function stringify(value: TemplateValue): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Arrays/objects render as JSON; callers wanting per-element formatting should
  // pre-stringify before binding. Keeps engine surface tiny.
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Render `template` against `context`. Substitutes {{key}}, evaluates
 * {{#if key}}…{{/if}} and {{#unless key}}…{{/unless}} blocks. Block
 * resolution runs first (outer-to-inner via repeated passes) so nested
 * blocks work as long as their outer wrapper is itself a block.
 */
export function renderTemplate(template: string, context: TemplateContext = {}): string {
  return renderTemplateDetailed(template, context).output;
}

/** Variant returning unresolved placeholders alongside the rendered text. */
export function renderTemplateDetailed(template: string, context: TemplateContext = {}): RenderResult {
  if (typeof template !== 'string' || template.length === 0) {
    return { output: template ?? '', unresolved: [] };
  }
  // Resolve blocks iteratively so nested blocks of the same kind collapse
  // outer-first. A bounded loop guards against pathological input that
  // could otherwise spin if the regex ever misbehaves.
  let working = template;
  for (let pass = 0; pass < 16; pass++) {
    const next = working.replace(BLOCK_RE, (_match, kind: string, key: string, body: string) => {
      const truthy = isTruthy(context[key]);
      const keep = kind === 'if' ? truthy : !truthy;
      return keep ? body : '';
    });
    if (next === working) break;
    working = next;
  }
  // Then substitute simple variables, recording any that go unresolved.
  const unresolved: string[] = [];
  const output = working.replace(VAR_RE, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      unresolved.push(key);
      return match;
    }
    return stringify(context[key]);
  });
  return { output, unresolved };
}
