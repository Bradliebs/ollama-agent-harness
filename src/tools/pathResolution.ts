import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/logger';

const DEFAULT_UPLOADS_DIRNAME = path.join('.harness', 'uploads');

/**
 * Resolve the uploads directory. Honors the HARNESS_UPLOADS_DIR env override
 * (absolute or project-relative) and falls back to .harness/uploads. The
 * directory is not auto-created here; the upload route does that on demand.
 */
export function getUploadsDir(): string {
  const override = process.env.HARNESS_UPLOADS_DIR?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  return path.join(process.cwd(), DEFAULT_UPLOADS_DIRNAME);
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
  const resolved = path.resolve(raw);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
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
