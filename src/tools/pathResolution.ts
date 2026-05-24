import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../core/logger';

// ─── Project root override ──────────────────────────────────────────
// When the server detects workspace isolation (HARNESS_PROJECT_DIR or
// harness-repo redirect), it calls setProjectRoot() so that all path
// resolution honours the workspace instead of the launch-time cwd.
let _projectRoot: string | null = null;

/** Override the project root used by all path resolution functions. */
export function setProjectRoot(dir: string): void {
  _projectRoot = path.resolve(dir);
}

/** Return the effective project root (explicit override or process.cwd()). */
export function getProjectRoot(): string {
  return _projectRoot ?? process.cwd();
}

const DEFAULT_UPLOADS_DIRNAME = path.join('.harness', 'uploads');

// ─── Allowed external paths ─────────────────────────────────────────
// Directories outside the project root that file_read and list_files
// are permitted to access. Configured via Settings → Allowed External Paths.
let allowedExternalPaths: string[] = [];

export function setAllowedExternalPaths(paths: string[]): void {
  allowedExternalPaths = paths
    .map((p) => path.resolve(p.trim()))
    .filter((p) => {
      const segments = p.split(path.sep).filter(Boolean);
      // Require at least 2 path segments to prevent near-root paths
      // e.g. reject C:\, C:\x but allow C:\Users\..., /home/user/...
      return segments.length >= 2;
    });
}

export function getAllowedExternalPaths(): string[] {
  return [...allowedExternalPaths];
}

/**
 * Resolve the uploads directory. Resolution order:
 *   1. `HARNESS_UPLOADS_DIR` (explicit override; absolute or project-relative)
 *   2. `HARNESS_GLOBAL_UPLOADS=1` → `~/.harness/uploads` (cycle 18)
 *      Useful when the daemon serves multiple workspaces and uploads
 *      should not get scattered into whichever cwd happened to start it.
 *   3. `<cwd>/.harness/uploads` (legacy default)
 *
 * The directory is not auto-created here; the upload route does that on demand.
 */
export function getUploadsDir(): string {
  const override = process.env.HARNESS_UPLOADS_DIR?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(getProjectRoot(), override);
  }
  if (process.env.HARNESS_GLOBAL_UPLOADS === '1') {
    return path.join(os.homedir(), '.harness', 'uploads');
  }
  return path.join(getProjectRoot(), DEFAULT_UPLOADS_DIRNAME);
}

const DEFAULT_AGENT_OUTPUT_DIRNAME = 'agent-outputs';

/**
 * Resolve the agent-outputs directory. Honors HARNESS_AGENT_OUTPUT_DIR
 * (absolute or project-relative) and falls back to <project>/agent-outputs.
 * Used by file_write to corral bare-filename writes (e.g. analysis.md,
 * run-all-analysis.js) into a single directory so the repo root does not
 * become a dumping ground for model-generated files.
 */
export function getAgentOutputDir(): string {
  const override = process.env.HARNESS_AGENT_OUTPUT_DIR?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(getProjectRoot(), override);
  }
  return path.join(getProjectRoot(), DEFAULT_AGENT_OUTPUT_DIRNAME);
}

/**
 * Decide whether a file_write target should be redirected to the
 * agent-outputs directory. Returns the redirected absolute path, or null
 * when the original path should be used as-is. Redirects only when:
 *   - the path is a bare filename (no directory component), AND
 *   - no file already exists at that bare name in the project root.
 *
 * This preserves intentional edits to existing files (package.json,
 * tsconfig.json) and intentional writes to subdirectories
 * (src/foo.ts, scripts/bar.js), while corralling new scratch files.
 */
export function maybeRedirectAgentOutput(rawPath: string): string | null {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed || path.isAbsolute(trimmed)) return null;
  const basename = path.basename(trimmed);
  if (!basename) return null;

  // Never redirect edits to existing project files.
  const directTarget = path.resolve(getProjectRoot(), trimmed);
  if (fs.existsSync(directTarget)) return null;

  const explicitOverride = Boolean(process.env.HARNESS_AGENT_OUTPUT_DIR?.trim());
  const outputRoot = getAgentOutputDir();
  const dir = path.dirname(trimmed);

  // Two scenarios where the agent-outputs redirect should fire:
  //   1. Bare filename — classic scratch (notes.md, run.js).
  //   2. Path that already starts with agent-outputs/ — agent or user
  //      explicitly opted in by naming the directory.
  // Any other path with a directory component (src/foo.ts,
  // fine-tuning/python/trainer.py, scripts/x.js) is a deliberate write
  // to a specific subtree and MUST be honored as-is. Previous behavior
  // when HARNESS_AGENT_OUTPUT_DIR was set silently routed even those
  // intentional subdir writes to the override directory, which broke
  // multi-file projects (e.g. fine-tuning-studio landed in AgentFiles
  // instead of the user-named subdir of the repo).
  const isBareFilename = (dir === '.' || dir === '');
  const optedIntoAgentOutputs = (() => {
    const segments = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
    return segments[0]?.toLowerCase() === DEFAULT_AGENT_OUTPUT_DIRNAME;
  })();
  if (!isBareFilename && !optedIntoAgentOutputs) return null;

  if (explicitOverride) {
    // When the override is set we still honour the bare-filename / opt-in
    // semantics above, but we redirect to the configured directory rather
    // than the project-local default.
    const tail = optedIntoAgentOutputs
      ? trimmed.replace(/\\/g, '/').split('/').slice(1).join('/') || basename
      : basename;
    const redirected = path.resolve(outputRoot, tail);
    return isInsideOrEqualPath(redirected, outputRoot) ? redirected : null;
  }

  return path.join(outputRoot, basename);
}

function isInsideOrEqualPath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ─── User-defined file_write redirect rules ─────────────────────────────
// Lets the user route any file_write whose path matches a pattern into a
// specific directory. Solves the recurring "another agent keeps dropping
// lottery scripts in the Harness root" problem by sending them to
// C:/AI/Lottery-Toolkit/ instead.
//
// Pattern syntax: glob-like, applied to BOTH the basename and the relative
// path. `*` matches any run of characters except `/`. `**` matches across
// path separators. Patterns are case-insensitive on Windows.
//
// Source precedence:
//   1. HARNESS_FILE_WRITE_REDIRECTS env var (JSON array, takes priority).
//   2. .harness/file-write-redirects.json on disk.
//   3. Empty (no redirects).
//
// Example file content:
//   [
//     { "match": "lottery-*",  "redirect": "C:/AI/Lottery-Toolkit/inbox" },
//     { "match": "*.lottery.js", "redirect": "C:/AI/Lottery-Toolkit/scripts" },
//     { "match": "scratch/**", "redirect": "C:/Users/Brad/Desktop/scratch" }
//   ]
//
// First matching rule wins (order-sensitive). Rules with empty/invalid
// match or redirect fields are silently dropped.

export interface FileWriteRedirectRule {
  match: string;
  redirect: string;
}

const REDIRECTS_FILE = path.join('.harness', 'file-write-redirects.json');
let cachedRedirects: FileWriteRedirectRule[] | null = null;
let cachedRedirectsSource: 'env' | 'file' | 'none' = 'none';

/**
 * Force a reload of the redirect rules on the next access. Call this from
 * the UI POST handler so changes take effect immediately without a restart.
 */
export function clearFileWriteRedirectCache(): void {
  cachedRedirects = null;
  cachedRedirectsSource = 'none';
}

/**
 * Returns the active redirect rules and their source (env/file/none).
 * Cached so the per-write hot path avoids JSON.parse on every call.
 */
export function getFileWriteRedirects(): { rules: FileWriteRedirectRule[]; source: 'env' | 'file' | 'none' } {
  if (cachedRedirects !== null) return { rules: cachedRedirects, source: cachedRedirectsSource };
  // Prefer env var (handy for one-off CI overrides).
  const fromEnv = process.env.HARNESS_FILE_WRITE_REDIRECTS?.trim();
  if (fromEnv) {
    const parsed = parseRedirectRules(fromEnv);
    if (parsed) {
      cachedRedirects = parsed;
      cachedRedirectsSource = 'env';
      return { rules: parsed, source: 'env' };
    }
  }
  // Fall back to the JSON file managed by the UI Settings panel.
  try {
    const raw = fs.readFileSync(path.resolve(getProjectRoot(), REDIRECTS_FILE), 'utf-8');
    const parsed = parseRedirectRules(raw);
    if (parsed) {
      cachedRedirects = parsed;
      cachedRedirectsSource = 'file';
      return { rules: parsed, source: 'file' };
    }
  } catch {
    // Missing file is the common case — user has not configured any rules.
  }
  cachedRedirects = [];
  cachedRedirectsSource = 'none';
  return { rules: [], source: 'none' };
}

function parseRedirectRules(raw: string): FileWriteRedirectRule[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rules: FileWriteRedirectRule[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const match = typeof entry.match === 'string' ? entry.match.trim() : '';
      const redirect = typeof entry.redirect === 'string' ? entry.redirect.trim() : '';
      if (!match || !redirect) continue;
      rules.push({ match, redirect });
    }
    return rules;
  } catch {
    return null;
  }
}

/**
 * Convert a glob-style pattern (`*`, `**`) to a case-insensitive RegExp.
 * Handles backslash-vs-forward-slash by normalizing to forward slashes
 * before matching, so Windows paths and pattern authors agree.
 */
function compileMatchPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        regex += '.*';
        i++;
      } else {
        regex += '[^/]*';
      }
    } else if (/[.+^$|(){}\[\]\\]/.test(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

/**
 * If any redirect rule matches the supplied path, return the absolute
 * destination path (preserving the original basename). Otherwise null.
 *
 * Matching tries both the relative path and the bare basename so simple
 * patterns like `lottery-*` work without forcing the user to write
 * `**\/lottery-*` for every variant.
 */
export function applyFileWriteRedirect(rawPath: string): string | null {
  const { rules } = getFileWriteRedirects();
  if (rules.length === 0) return null;
  return matchRedirectRules(rawPath, rules);
}

/**
 * Pure (no env / no file IO) variant used by the UI preview endpoint.
 * Lets the user see which rule (if any) would match a typed path,
 * BEFORE saving the rules. Returns the matched rule + destination, or
 * null when no rule matches.
 */
export function previewFileWriteRedirect(
  rawPath: string,
  rules: FileWriteRedirectRule[],
): { rule: FileWriteRedirectRule; destination: string } | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const normalizedPath = rawPath.replace(/\\/g, '/');
  const basename = path.basename(rawPath);
  for (const rule of rules) {
    if (!rule || !rule.match || !rule.redirect) continue;
    const re = compileMatchPattern(rule.match);
    if (re.test(normalizedPath) || re.test(basename)) {
      const targetDir = path.isAbsolute(rule.redirect)
        ? rule.redirect
        : path.resolve(getProjectRoot(), rule.redirect);
      // Safety: reject redirect rules that escape workspace and allowed paths
      const safeTargetDir = isInsideOrEqualPath(targetDir, getProjectRoot()) ||
        allowedExternalPaths.some((p) => isInsideOrEqualPath(targetDir, p));
      if (!safeTargetDir) continue;  // skip unsafe rule silently
      return { rule, destination: path.join(targetDir, basename) };
    }
  }
  return null;
}

/**
 * Internal helper used by both applyFileWriteRedirect (active rules) and
 * the preview endpoint. Returns the destination path or null.
 */
function matchRedirectRules(rawPath: string, rules: FileWriteRedirectRule[]): string | null {
  const normalizedPath = rawPath.replace(/\\/g, '/');
  const basename = path.basename(rawPath);
  for (const rule of rules) {
    const re = compileMatchPattern(rule.match);
    if (re.test(normalizedPath) || re.test(basename)) {
      const targetDir = path.isAbsolute(rule.redirect)
        ? rule.redirect
        : path.resolve(getProjectRoot(), rule.redirect);
      // Safety: reject redirect rules that escape workspace and allowed paths
      const safeTargetDir = isInsideOrEqualPath(targetDir, getProjectRoot()) ||
        allowedExternalPaths.some((p) => isInsideOrEqualPath(targetDir, p));
      if (!safeTargetDir) return null;  // skip unsafe rule silently
      return path.join(targetDir, basename);
    }
  }
  return null;
}

export interface UploadsFallbackRecord {
  requested: string;
  resolved: string;
  at: string;
}

const fallbackBuffer: UploadsFallbackRecord[] = [];
const MAX_FALLBACK_BUFFER = 50;

/**
 * Return and clear the buffered uploads-fallback records. The web layer drains
 * this after each tool result so it can surface a trace event when a model
 * passed a bare filename and the resolver had to rewrite it to .harness/uploads.
 */
export function drainUploadsFallbacks(): UploadsFallbackRecord[] {
  if (fallbackBuffer.length === 0) return [];
  const snapshot = fallbackBuffer.splice(0, fallbackBuffer.length);
  return snapshot;
}

function recordFallback(requested: string, resolved: string): void {
  fallbackBuffer.push({ requested, resolved, at: new Date().toISOString() });
  if (fallbackBuffer.length > MAX_FALLBACK_BUFFER) {
    fallbackBuffer.splice(0, fallbackBuffer.length - MAX_FALLBACK_BUFFER);
  }
}

/**
 * Resolve a tool path against the project root. Returns the absolute path
 * when it is inside the project directory, or null when it would escape.
 */
export function resolveProjectPath(value: unknown): string | null {
  const raw = String(value ?? '');
  const root = getProjectRoot();
  const resolved = path.resolve(root, raw);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return resolved;
  // Check allowed external paths
  for (const allowed of allowedExternalPaths) {
    if (isInside(resolved, allowed) || resolved === allowed) return resolved;
  }
  return null;
}

/**
 * Like {@link resolveProjectPath} but, when the caller passes a bare filename
 * that is missing at the cwd-resolved location, falls back to the matching
 * file in the uploads directory if one exists. Lets read tools accept
 * attached files by name even when the model omits the upload directory.
 * Also accepts absolute or relative paths that resolve inside the configured
 * uploads directory even when it lives outside the project root (set via
 * HARNESS_UPLOADS_DIR).
 */
export function resolveProjectReadPath(value: unknown): string | null {
  const raw = String(value ?? '');
  const uploadsDir = getUploadsDir();
  // Accept paths that already resolve inside the uploads directory, even when
  // it sits outside the project root (HARNESS_UPLOADS_DIR override).
  const directResolved = path.resolve(raw);
  if (isInside(directResolved, uploadsDir) && fs.existsSync(directResolved)) {
    return directResolved;
  }
  const resolved = resolveProjectPath(value);
  if (!resolved) return null;
  if (fs.existsSync(resolved)) return resolved;
  const dir = path.dirname(raw);
  if (dir !== '.' && dir !== '') return resolved;
  const base = path.basename(raw);
  if (!base) return resolved;
  const candidate = path.join(uploadsDir, base);
  if (fs.existsSync(candidate)) {
    logger.warn('PathResolution', 'Bare filename rewritten to uploads directory', { requested: raw, resolved: candidate });
    recordFallback(raw, candidate);
    return candidate;
  }
  return resolved;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
