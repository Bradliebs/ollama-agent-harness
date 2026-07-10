import * as fs from 'fs';
import * as path from 'path';

/**
 * Detects file-path-shaped substrings in assistant text and reports
 * which ones don't actually exist on disk. Targeted at the hallucination
 * pattern where a model writes "✅ Implemented — see src/foo/bar.ts"
 * for files it never opened. Scope is intentionally narrow:
 *
 *   - Only matches paths that look like real source/doc files
 *     (slash-or-backslash separators, recognised extension).
 *   - Only checks the first ~20 candidates per call so a long answer
 *     full of legitimate examples doesn't blow the I/O budget.
 *   - Returns just a list of unverified paths; callers decide whether
 *     to annotate, warn, or ignore.
 *
 * NOT a security boundary. The model can still claim things about
 * paths that *do* exist; this only catches the cheap mistake of
 * mentioning paths that aren't there at all.
 */

const KNOWN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php', '.swift', '.kt',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.md', '.mdx', '.txt', '.html', '.css', '.scss',
  '.sh', '.bat', '.ps1',
]);

// Match path-like tokens: at least one separator, followed by segments,
// ending in one of the known extensions. Anchored on word boundaries so
// we don't pull paths out of the middle of URLs.
//
// Examples that match:
//   src/foo/bar.ts
//   src\\agents\\health-agent.js
//   ./scripts/run.sh
//   path: "src/foo.ts"
//
// Examples that don't:
//   foo.ts          (no separator)
//   https://...     (URL)
//   foo:bar         (no extension)
const PATH_PATTERN = /(?:^|[\s"'`(\[<])((?:\.{1,2}[\\/])?(?:[\w.\-@]+[\\/])+[\w.\-@]+\.[A-Za-z0-9]{1,5})\b/g;

const MAX_CANDIDATES = 20;

export interface PathClaimReport {
  /** Path-shaped strings that we attempted to verify. */
  candidates: string[];
  /** Subset of candidates that resolve to an existing file. */
  verified: string[];
  /** Subset of candidates that do NOT exist on disk. */
  unverified: string[];
}

/**
 * Scan `text` for path-shaped substrings and check each one against
 * the filesystem rooted at `projectRoot`. Returns the verified and
 * unverified buckets. URL-like and obviously non-file matches are
 * filtered out before the disk check.
 */
export function verifyPathClaims(text: string, projectRoot: string): PathClaimReport {
  const candidates = extractPathCandidates(text);
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const candidate of candidates) {
    if (existsRelativeTo(candidate, projectRoot)) {
      verified.push(candidate);
    } else {
      unverified.push(candidate);
    }
  }
  return { candidates, verified, unverified };
}

/**
 * Format an "unverified file references" footer suitable for appending
 * to assistant text. Returns null when nothing should be appended (no
 * unverified paths or empty input).
 */
export function formatUnverifiedFooter(report: PathClaimReport): string | null {
  if (report.unverified.length === 0) return null;
  const list = report.unverified.slice(0, 10).map((p) => `  - ${p}`).join('\n');
  const suffix = report.unverified.length > 10 ? `\n  - ...and ${report.unverified.length - 10} more` : '';
  return `\n\n⚠️ Unverified file references (the model mentioned these paths but they were not opened or do not exist on disk):\n${list}${suffix}`;
}

function extractPathCandidates(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Reset regex state by constructing a fresh iterator each call.
  const matcher = new RegExp(PATH_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    if (out.length >= MAX_CANDIDATES) break;
    const normalized = raw.replace(/[)\]>'",`]+$/, '');
    const ext = path.extname(normalized).toLowerCase();
    if (!KNOWN_EXTS.has(ext)) continue;
    // Skip URL fragments — paths starting with '//' are protocol-relative URLs.
    if (normalized.startsWith('//')) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function existsRelativeTo(candidate: string, projectRoot: string): boolean {
  // The model may write either OS-native or POSIX-style separators;
  // normalise before resolving against the project root.
  const normalised = candidate.replace(/\\/g, path.sep).replace(/\//g, path.sep);
  const resolved = path.isAbsolute(normalised)
    ? normalised
    : path.resolve(projectRoot, normalised);
  try {
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}
