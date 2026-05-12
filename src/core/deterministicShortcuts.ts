// Deterministic Shortcuts — bypass model calls for simple computations.
//
// Before routing a task to any model, check if the task can be handled
// by deterministic code. Date calculations, sorting, grouping, filtering,
// CSV/JSON parsing, regex extraction, statistics, unit conversion, and
// dependency analysis all have exact solutions that don't need LLM reasoning.
//
// This is Tier 0 of the Small Model Autopilot: rules/code first,
// model only when computation can't solve it.

// ─── Types ──────────────────────────────────────────────────────────

export interface ShortcutResult {
  handled: boolean;
  type?: string;
  output?: unknown;
  explanation?: string;
}

// ─── Patterns ───────────────────────────────────────────────────────

interface ShortcutPattern {
  type: string;
  /** Return true if this shortcut can handle the input. */
  match: (input: string) => boolean;
  /** Execute the shortcut and return the result. */
  execute: (input: string) => unknown;
}

const SHORTCUT_PATTERNS: ShortcutPattern[] = [
  // ── Date calculations ─────────────────────────────────────────
  {
    type: 'date_calculation',
    match: (input) => /(?:what|when)\s+(?:is|was|will)\s+(?:the\s+)?(?:date|day|time)/i.test(input)
      || /(?:what\s+day\s+is)/i.test(input)
      || /(?:days?\s+(?:from|until|since|between|ago))|(?:(?:add|subtract)\s+\d+\s+days?)/i.test(input)
      || /(?:how many days|date difference|days? between)/i.test(input),
    execute: (input) => {
      const now = new Date();
      // "X days from now" / "X days ago"
      const daysFromMatch = input.match(/(\d+)\s+days?\s+(from\s+now|from\s+today|ahead)/i);
      if (daysFromMatch) {
        const days = parseInt(daysFromMatch[1], 10);
        const result = new Date(now.getTime() + days * 86_400_000);
        return { result: result.toISOString().slice(0, 10), calculation: `${days} days from ${now.toISOString().slice(0, 10)}` };
      }
      const daysAgoMatch = input.match(/(\d+)\s+days?\s+ago/i);
      if (daysAgoMatch) {
        const days = parseInt(daysAgoMatch[1], 10);
        const result = new Date(now.getTime() - days * 86_400_000);
        return { result: result.toISOString().slice(0, 10), calculation: `${days} days ago from ${now.toISOString().slice(0, 10)}` };
      }
      // "what day is today / what is the date"
      if (/today|current date|what day/i.test(input)) {
        return { result: now.toISOString().slice(0, 10), day: now.toLocaleDateString('en-US', { weekday: 'long' }) };
      }
      // Days between two ISO dates
      const betweenMatch = input.match(/between\s+(\d{4}-\d{2}-\d{2})\s+(?:and|to)\s+(\d{4}-\d{2}-\d{2})/i);
      if (betweenMatch) {
        const d1 = new Date(betweenMatch[1]);
        const d2 = new Date(betweenMatch[2]);
        const diff = Math.round(Math.abs(d2.getTime() - d1.getTime()) / 86_400_000);
        return { result: diff, unit: 'days', from: betweenMatch[1], to: betweenMatch[2] };
      }
      return { result: now.toISOString(), note: 'Could not parse specific date calculation' };
    },
  },

  // ── Math / statistics ─────────────────────────────────────────
  {
    type: 'math_calculation',
    match: (input) => /^(?:what\s+is\s+)?(?:calculate|compute|eval(?:uate)?)\s+/i.test(input)
      || /^[\d\s+\-*/().%^]+$/.test(input.trim())
      || /(?:sum|average|mean|median|min|max|count)\s+(?:of|:)\s+[\d,\s.]+/i.test(input),
    execute: (input) => {
      // Aggregate functions: sum/average/min/max of numbers
      const aggMatch = input.match(/(sum|average|mean|median|min|max|count)\s+(?:of|:)\s+([\d,\s.]+)/i);
      if (aggMatch) {
        const fn = aggMatch[1].toLowerCase();
        const nums = aggMatch[2].split(/[,\s]+/).map(Number).filter((n) => !isNaN(n));
        if (nums.length === 0) return { error: 'No valid numbers found' };
        const result = fn === 'sum' ? nums.reduce((a, b) => a + b, 0)
          : fn === 'count' ? nums.length
          : fn === 'min' ? Math.min(...nums)
          : fn === 'max' ? Math.max(...nums)
          : fn === 'median' ? (() => { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; })()
          : nums.reduce((a, b) => a + b, 0) / nums.length; // average/mean
        return { result, function: fn, input_count: nums.length };
      }
      // Simple arithmetic expression
      const cleaned = input.replace(/^(?:what\s+is\s+)?(?:calculate|compute|eval(?:uate)?)\s+/i, '').trim();
      if (/^[\d\s+\-*/().%]+$/.test(cleaned)) {
        try {
          // Safe eval: only digits and operators
          const result = Function('"use strict"; return (' + cleaned + ')')();
          if (typeof result === 'number' && isFinite(result)) return { result, expression: cleaned };
        } catch { /* not evaluable */ }
      }
      return null;
    },
  },

  // ── JSON parsing ──────────────────────────────────────────────
  {
    type: 'json_parse',
    match: (input) => /(?:parse|validate|check|format)\s+(?:this\s+)?json/i.test(input)
      || /^is\s+(?:this\s+)?(?:valid\s+)?json/i.test(input),
    execute: (input) => {
      // Try to find JSON in the input
      const jsonMatch = input.match(/[{[][\s\S]*[}\]]/);
      if (!jsonMatch) return { valid: false, error: 'No JSON found in input' };
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return { valid: true, parsed, keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : undefined };
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
      }
    },
  },

  // ── Sorting ───────────────────────────────────────────────────
  {
    type: 'sort',
    match: (input) => /(?:sort|order|rank)\s+(?:these|this|the)?\s*(?:numbers?|items?|values?|list)/i.test(input),
    execute: (input) => {
      const nums = input.match(/-?\d+\.?\d*/g)?.map(Number).filter((n) => !isNaN(n));
      if (nums && nums.length > 0) {
        const desc = /descend|largest|highest|reverse/i.test(input);
        const sorted = [...nums].sort((a, b) => desc ? b - a : a - b);
        return { sorted, order: desc ? 'descending' : 'ascending', count: sorted.length };
      }
      return null;
    },
  },

  // ── Regex extraction ──────────────────────────────────────────
  {
    type: 'regex_extract',
    match: (input) => /(?:extract|find|match)\s+(?:all\s+)?(?:emails?|urls?|phone|numbers?|ip\s*address)/i.test(input),
    execute: (input) => {
      if (/emails?/i.test(input)) {
        const emails = input.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
        return { type: 'emails', matches: emails, count: emails.length };
      }
      if (/urls?/i.test(input)) {
        const urls = input.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g) ?? [];
        return { type: 'urls', matches: urls, count: urls.length };
      }
      if (/phone/i.test(input)) {
        const phones = input.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [];
        return { type: 'phones', matches: phones, count: phones.length };
      }
      if (/ip\s*address/i.test(input)) {
        const ips = input.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g) ?? [];
        return { type: 'ip_addresses', matches: ips, count: ips.length };
      }
      const nums = input.match(/-?\d+\.?\d*/g) ?? [];
      return { type: 'numbers', matches: nums.map(Number), count: nums.length };
    },
  },

  // ── Unit conversion ───────────────────────────────────────────
  {
    type: 'unit_conversion',
    match: (input) => /(?:convert|how many)\s+\d+.*\s+(?:to|in|into)\s+/i.test(input)
      || /\d+\s*(?:km|mi|kg|lb|°?[CF]|cm|in|ft|m|oz|g|l|gal)\s+(?:to|in)\s+/i.test(input),
    execute: (input) => {
      const m = input.match(/(\d+\.?\d*)\s*([a-zA-Z°]+)\s+(?:to|in|into)\s+([a-zA-Z°]+)/i);
      if (!m) return null;
      const value = parseFloat(m[1]);
      const from = m[2].toLowerCase();
      const to = m[3].toLowerCase();
      const conversions: Record<string, Record<string, (v: number) => number>> = {
        km: { mi: (v) => v * 0.621371, m: (v) => v * 1000, ft: (v) => v * 3280.84 },
        mi: { km: (v) => v * 1.60934, m: (v) => v * 1609.34, ft: (v) => v * 5280 },
        kg: { lb: (v) => v * 2.20462, g: (v) => v * 1000, oz: (v) => v * 35.274 },
        lb: { kg: (v) => v * 0.453592, g: (v) => v * 453.592, oz: (v) => v * 16 },
        cm: { in: (v) => v * 0.393701, ft: (v) => v * 0.0328084, m: (v) => v / 100 },
        in: { cm: (v) => v * 2.54, ft: (v) => v / 12, m: (v) => v * 0.0254 },
        ft: { m: (v) => v * 0.3048, cm: (v) => v * 30.48, in: (v) => v * 12 },
        m: { ft: (v) => v * 3.28084, cm: (v) => v * 100, km: (v) => v / 1000 },
        l: { gal: (v) => v * 0.264172, ml: (v) => v * 1000 },
        gal: { l: (v) => v * 3.78541, ml: (v) => v * 3785.41 },
        c: { f: (v) => v * 9 / 5 + 32 },
        f: { c: (v) => (v - 32) * 5 / 9 },
        '°c': { '°f': (v) => v * 9 / 5 + 32 },
        '°f': { '°c': (v) => (v - 32) * 5 / 9 },
        g: { kg: (v) => v / 1000, oz: (v) => v * 0.035274, lb: (v) => v * 0.00220462 },
        oz: { g: (v) => v * 28.3495, kg: (v) => v * 0.0283495, lb: (v) => v / 16 },
      };
      const converter = conversions[from]?.[to];
      if (!converter) return null;
      const result = Math.round(converter(value) * 10000) / 10000;
      return { result, from: `${value} ${m[2]}`, to: `${result} ${m[3]}`, formula: `${from} → ${to}` };
    },
  },

  // ── Percentage calculation ────────────────────────────────────
  {
    type: 'percentage',
    match: (input) => /(?:what\s+is\s+)?\d+\.?\d*\s*%\s+of\s+\d+/i.test(input)
      || /\d+\s+(?:out\s+of|\/)\s+\d+\s+(?:as\s+)?(?:a\s+)?percent/i.test(input),
    execute: (input) => {
      // "X% of Y"
      const pctOf = input.match(/(\d+\.?\d*)\s*%\s+of\s+(\d+\.?\d*)/i);
      if (pctOf) {
        const result = (parseFloat(pctOf[1]) / 100) * parseFloat(pctOf[2]);
        return { result: Math.round(result * 100) / 100, calculation: `${pctOf[1]}% of ${pctOf[2]}` };
      }
      // "X out of Y as percent"
      const outOf = input.match(/(\d+\.?\d*)\s+(?:out\s+of|\/)\s+(\d+\.?\d*)/i);
      if (outOf) {
        const result = (parseFloat(outOf[1]) / parseFloat(outOf[2])) * 100;
        return { result: Math.round(result * 100) / 100, unit: '%', calculation: `${outOf[1]} / ${outOf[2]}` };
      }
      return null;
    },
  },

  // ── Countdown / time until ────────────────────────────────────
  {
    type: 'countdown',
    match: (input) => /(?:how\s+(?:long|many\s+days)\s+until|countdown\s+to|days?\s+(?:left|remaining)\s+(?:until|to))\s+\d{4}/i.test(input),
    execute: (input) => {
      const dateMatch = input.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) {
        // Try "Month Day, Year"
        const naturalMatch = input.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
        if (!naturalMatch) return null;
        const months: Record<string, number> = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
        const target = new Date(parseInt(naturalMatch[3]), months[naturalMatch[1].toLowerCase()], parseInt(naturalMatch[2]));
        const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
        return { days, target: target.toISOString().slice(0, 10), direction: days >= 0 ? 'future' : 'past' };
      }
      const target = new Date(dateMatch[1]);
      const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
      return { days, target: dateMatch[1], direction: days >= 0 ? 'future' : 'past' };
    },
  },

  // ── Word/character count ──────────────────────────────────────
  {
    type: 'word_count',
    match: (input) => /(?:count|how many)\s+(?:words?|characters?|chars?|lines?)\s+(?:in|:)/i.test(input),
    execute: (input) => {
      // Extract the text after "in:" or "in "
      const textMatch = input.match(/(?:in|:)\s*["']?([\s\S]+?)["']?\s*$/i);
      if (!textMatch) return null;
      const text = textMatch[1].trim();
      return {
        characters: text.length,
        words: text.split(/\s+/).filter(Boolean).length,
        lines: text.split('\n').length,
      };
    },
  },

  // ── Base conversion ───────────────────────────────────────────
  {
    type: 'base_conversion',
    match: (input) => /(?:convert|what\s+is)\s+(?:0x[0-9a-f]+|0b[01]+|\d+)\s+(?:to|in)\s+(?:hex|binary|decimal|octal|base)/i.test(input),
    execute: (input) => {
      const m = input.match(/(?:convert|what\s+is)\s+(0x[0-9a-f]+|0b[01]+|\d+)\s+(?:to|in)\s+(hex|binary|decimal|octal|base\s*\d+)/i);
      if (!m) return null;
      const valueStr = m[1];
      const toBase = m[2].toLowerCase();
      let value: number;
      if (valueStr.startsWith('0x')) value = parseInt(valueStr, 16);
      else if (valueStr.startsWith('0b')) value = parseInt(valueStr.slice(2), 2);
      else value = parseInt(valueStr, 10);
      if (isNaN(value)) return null;
      const result = toBase === 'hex' ? '0x' + value.toString(16)
        : toBase === 'binary' ? '0b' + value.toString(2)
        : toBase === 'octal' ? '0o' + value.toString(8)
        : toBase.startsWith('base') ? value.toString(parseInt(toBase.replace('base', '').trim()) || 10)
        : value.toString(10);
      return { result, decimal: value, from: valueStr, to: toBase };
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Try to handle a user message with deterministic computation.
 * Returns { handled: true, ... } if a shortcut matched, or { handled: false } if not.
 */
export function tryDeterministicShortcut(input: string): ShortcutResult {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 500) return { handled: false };

  for (const pattern of SHORTCUT_PATTERNS) {
    if (pattern.match(trimmed)) {
      const result = pattern.execute(trimmed);
      if (result !== null && result !== undefined) {
        return {
          handled: true,
          type: pattern.type,
          output: result,
          explanation: `Handled by deterministic ${pattern.type} shortcut (Tier 0: no model needed).`,
        };
      }
    }
  }

  return { handled: false };
}

/** List all available shortcut types. */
export function listShortcutTypes(): string[] {
  return SHORTCUT_PATTERNS.map((p) => p.type);
}
