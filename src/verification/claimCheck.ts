// Research-claim checks — does the answer say things the sources didn't?
//
// A research answer is built from pages the agent read. Figures (prices,
// counts, percentages, dates) are where confident fabrication does the most
// damage and where a cheap in-process check works: a figure that appears in
// none of the pages read is unsupported. Claims without figures cannot be
// checked lexically; the optional critic model handles those.

export interface Claim {
  text: string;
  /** Normalised figures the claim asserts. */
  figures: string[];
}

export interface ClaimCheck {
  claim: Claim;
  supported: boolean;
  /** Figures not found in any source. */
  missing: string[];
  /** Figures not in the sources but computed from other figures in the answer (a difference, total or percentage). */
  derived: string[];
}

export interface ClaimCheckReport {
  checked: ClaimCheck[];
  unsupported: ClaimCheck[];
  /** Claims with no checkable figures (candidates for the critic). */
  unchecked: Claim[];
}

// A figure is a standalone number (optionally with currency or a unit); digits
// inside names like "X100VI" or "V4" are not figures.
const FIGURE_PATTERN = /(?<![A-Za-z0-9.])(?:[£$€¥₹]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|k|m|bn|million|billion)(?![A-Za-z])|(?![A-Za-z0-9]))/gi;
const MAX_CLAIMS = 40;
// Phone numbers are compared by their last nine digits, however they are spaced.
const CLAIM_PHONE_PATTERN = /(?:\+|(?<![\d.,])0)\d[\d\s()-]{7,}\d/g;
const SOURCE_PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;
const HTTP_CONTEXT = /\b(?:HTTP|status|error|blocked|forbidden|not found)\b|\b[45]\d\d'd\b/i;

function phoneFigure(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15 ? `tel:${digits.slice(-9)}` : null;
}

/** Canonical forms of a figure: "£1,669.28" -> ["1669.28", "1669"]. */
export function normalizeFigure(raw: string): string[] {
  const cleaned = raw.toLowerCase().replace(/[£$€¥₹\s]/g, '').replace(/,/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(%|k|m|bn|million|billion)?$/);
  if (!match) return [];
  const [, number, unit] = match;
  const forms = new Set<string>([number + (unit === '%' ? '%' : '')]);
  const value = Number(number);
  if (Number.isFinite(value) && number.includes('.')) forms.add(String(Math.trunc(value)) + (unit === '%' ? '%' : ''));
  return [...forms];
}

function isCheckable(raw: string): boolean {
  const hasMarker = /[£$€¥₹%]|\.\d|k\b|m\b|bn\b|million|billion/i.test(raw);
  const digits = raw.replace(/\D/g, '');
  // Bare small integers are usually list numbers, step counts or ordinals.
  return hasMarker || digits.length >= 3;
}

/** Split an answer into claims that assert at least one checkable figure. */
export function extractClaims(answer: string): { withFigures: Claim[]; withoutFigures: Claim[] } {
  const body = answer.split(/\n\s*\*\*Sources\*\*\s*\n/)[0] ?? answer;
  const units = body
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\n+/)
    .flatMap((line) => (line.trim().startsWith('|') ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z*_(])/)))
    .map((unit) => unit.replace(/[*_`#>]/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((unit) => unit.length >= 12 && !/^[-:\s]+$/.test(unit));
  const withFigures: Claim[] = [];
  const withoutFigures: Claim[] = [];
  for (const text of units) {
    const phones = (text.match(CLAIM_PHONE_PATTERN) ?? []).map(phoneFigure).filter((phone): phone is string => phone !== null);
    const withoutPhones = phones.length > 0 ? text.replace(CLAIM_PHONE_PATTERN, (raw) => (phoneFigure(raw) ? ' ' : raw)) : text;
    const httpContext = HTTP_CONTEXT.test(text);
    const numbers = (withoutPhones.match(FIGURE_PATTERN) ?? [])
      .filter(isCheckable)
      .filter((raw) => !(httpContext && /^[45]\d\d$/.test(raw.trim())))
      .flatMap((raw) => normalizeFigure(raw.trim()).slice(0, 1));
    const figures = [...new Set([...phones, ...numbers])];
    if (figures.length > 0) withFigures.push({ text: text.slice(0, 300), figures });
    else if (text.split(' ').length >= 6) withoutFigures.push({ text: text.slice(0, 300), figures: [] });
  }
  return { withFigures: withFigures.slice(0, MAX_CLAIMS), withoutFigures: withoutFigures.slice(0, MAX_CLAIMS) };
}

/** All canonical figures present in the source texts. */
export function figuresInSources(sources: string[]): Set<string> {
  const found = new Set<string>();
  for (const source of sources) {
    for (const raw of source.match(FIGURE_PATTERN) ?? []) {
      for (const form of normalizeFigure(raw.trim())) found.add(form);
    }
    for (const raw of source.match(SOURCE_PHONE_PATTERN) ?? []) {
      const phone = phoneFigure(raw);
      if (phone) found.add(phone);
    }
  }
  return found;
}

const DERIVATION_CUE = /\b(?:sav\w*|cheaper|dearer|under|over|less|more|off|below|above|difference|total\w*|combined|vs|versus|than|drops?|rises?|up|down|reduction|increase|discount|gap)\b/i;

/**
 * True when a figure is arithmetic on figures the sources back: a difference
 * or total ("saves £544"), or a percentage ("11% below new"). Only claims
 * that talk about a comparison qualify, and years never do.
 */
function isDerived(figure: string, claimText: string, operands: number[]): boolean {
  if (figure.startsWith('tel:') || !DERIVATION_CUE.test(claimText)) return false;
  const percent = figure.endsWith('%');
  const value = Number(figure.replace('%', ''));
  if (!Number.isFinite(value) || value === 0) return false;
  // Small numbers are within rounding of too many differences to call derived.
  if (!percent && (value < 10 || (Number.isInteger(value) && value >= 1900 && value <= 2100))) return false;
  const tolerance = percent ? 0.5 : 1;
  for (let i = 0; i < operands.length; i += 1) {
    for (let j = 0; j < operands.length; j += 1) {
      if (i === j) continue;
      const a = operands[i];
      const b = operands[j];
      if (percent) {
        if (a > 0 && (Math.abs(((a - b) / a) * 100 - value) <= tolerance || Math.abs((b / a) * 100 - value) <= tolerance)) return true;
      } else if (Math.abs(Math.abs(a - b) - value) <= tolerance || (j > i && Math.abs(a + b - value) <= tolerance)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check each figure-bearing claim against the sources. `trusted` text (the
 * user's own question) also counts as support, so a figure the user supplied
 * is never flagged.
 */
export function checkClaims(answer: string, sources: string[], trusted: string[] = []): ClaimCheckReport {
  const { withFigures, withoutFigures } = extractClaims(answer);
  const known = figuresInSources([...sources, ...trusted]);
  const numeric = (figures: string[]) => figures
    .filter((figure) => !figure.endsWith('%') && !figure.startsWith('tel:'))
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const verified = [...new Set(numeric(withFigures.flatMap((claim) => claim.figures).filter((figure) => known.has(figure))))].slice(0, 60);
  const checked = withFigures.map((claim) => {
    const notInSources = claim.figures.filter((figure) => !known.has(figure));
    const derived = notInSources.filter((figure) => isDerived(figure, claim.text, verified));
    const missing = notInSources.filter((figure) => !derived.includes(figure));
    return { claim, supported: missing.length === 0, missing, derived };
  });
  return { checked, unsupported: checked.filter((entry) => !entry.supported), unchecked: withoutFigures };
}

/** Source passages most relevant to a claim, for the critic. */
export function bestExcerpts(claim: string, sources: string[], maxExcerpts = 2, excerptChars = 1200): string[] {
  const terms = new Set(claim.toLowerCase().split(/[^a-z0-9£$€.%]+/).filter((term) => term.length > 3));
  const passages: Array<{ text: string; score: number }> = [];
  for (const source of sources) {
    for (let start = 0; start < source.length; start += Math.floor(excerptChars / 2)) {
      const text = source.slice(start, start + excerptChars);
      const lower = text.toLowerCase();
      let score = 0;
      for (const term of terms) if (lower.includes(term)) score += 1;
      if (score > 0) passages.push({ text, score });
      if (passages.length > 400) break;
    }
  }
  return passages.sort((a, b) => b.score - a.score).slice(0, maxExcerpts).map((passage) => passage.text.replace(/\s+/g, ' ').trim());
}
