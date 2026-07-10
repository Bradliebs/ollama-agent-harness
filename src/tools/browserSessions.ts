import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Browser cookie/session vault ──────────────────────────────────
//
// Explicit, scoped storage of browser logins as named Playwright
// `storageState` snapshots under .harness/browser-sessions/<name>.json,
// instead of pointing the browser at a raw on-disk Chrome profile
// (HARNESS_BROWSER_PROFILE_DIR). Each vault entry is a self-contained
// JSON document of cookies + origin localStorage that Playwright can
// restore into a fresh context via `newContext({ storageState })`.
//
// The vault file ON DISK necessarily contains the login material (that
// is the whole point — it IS the saved session). But the LISTING API
// only ever returns metadata (name, counts, timestamp, size); it never
// echoes cookie values or localStorage contents.

const SESSIONS_RELDIR = path.join('.harness', 'browser-sessions');

function sessionsDir(): string {
  return path.join(process.cwd(), SESSIONS_RELDIR);
}

/** Restrict names to a safe filename charset so a name can never escape the vault dir. */
function sanitizeName(name: string): string {
  return String(name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
}

function sessionPath(name: string): string {
  return path.join(sessionsDir(), `${sanitizeName(name)}.json`);
}

export interface BrowserSessionMeta {
  name: string;
  savedAt: string;
  cookieCount: number;
  originCount: number;
  sizeBytes: number;
}

/** Name of the vault entry to auto-load, from HARNESS_BROWSER_SESSION. '' = none. */
export function getActiveSessionName(): string {
  return (process.env.HARNESS_BROWSER_SESSION ?? '').trim();
}

function countState(state: unknown): { cookieCount: number; originCount: number } {
  if (!state || typeof state !== 'object') return { cookieCount: 0, originCount: 0 };
  const s = state as Record<string, unknown>;
  const cookieCount = Array.isArray(s.cookies) ? s.cookies.length : 0;
  const originCount = Array.isArray(s.origins) ? s.origins.length : 0;
  return { cookieCount, originCount };
}

/**
 * Persist a Playwright `storageState` object as a named vault entry.
 * Returns the (metadata-only) descriptor of what was saved.
 */
export async function saveBrowserSession(name: string, state: unknown): Promise<BrowserSessionMeta> {
  const safe = sanitizeName(name);
  if (!safe) throw new Error('A session name is required.');
  await fs.mkdir(sessionsDir(), { recursive: true });
  const json = JSON.stringify(state ?? {}, null, 2);
  const target = sessionPath(safe);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, json, 'utf-8');
  await fs.rename(tmp, target);
  const counts = countState(state);
  return {
    name: safe,
    savedAt: new Date().toISOString(),
    cookieCount: counts.cookieCount,
    originCount: counts.originCount,
    sizeBytes: Buffer.byteLength(json, 'utf-8'),
  };
}

/** List all vault entries as metadata only — never cookie/localStorage values. */
export async function listBrowserSessions(): Promise<BrowserSessionMeta[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }
  const metas: BrowserSessionMeta[] = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    const full = path.join(sessionsDir(), file);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(full, 'utf-8'), fs.stat(full)]);
      const state = JSON.parse(raw) as unknown;
      const counts = countState(state);
      metas.push({
        name: file.replace(/\.json$/, ''),
        savedAt: stat.mtime.toISOString(),
        cookieCount: counts.cookieCount,
        originCount: counts.originCount,
        sizeBytes: stat.size,
      });
    } catch {
      // Skip unreadable/corrupt entries.
    }
  }
  return metas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Load a vault entry's raw `storageState` for restoring into a browser context. */
export async function loadBrowserSessionState(name: string): Promise<Record<string, unknown> | null> {
  const safe = sanitizeName(name);
  if (!safe) return null;
  try {
    const raw = await fs.readFile(sessionPath(safe), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Delete a vault entry. Returns true if a file was removed. */
export async function deleteBrowserSession(name: string): Promise<boolean> {
  const safe = sanitizeName(name);
  if (!safe) return false;
  try {
    await fs.unlink(sessionPath(safe));
    return true;
  } catch {
    return false;
  }
}
