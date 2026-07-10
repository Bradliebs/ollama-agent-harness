/**
 * Concept Memory Client — thin HTTP client for the ccmem FastAPI service.
 *
 * ccmem lives in this repo at ccmem/service.py and exposes:
 *   POST /write          — store a single text as a concept cell
 *   POST /write_many     — batch store
 *   POST /query          — semantic search
 *   POST /bind           — bind related texts into a composite cell
 *   GET  /health         — liveness probe
 *
 * Integration rules:
 *   - All calls are best-effort. If the service is unreachable or returns an
 *     error, functions return null / empty arrays and never throw. The harness
 *     works identically when ccmem is offline.
 *   - URL configured via HARNESS_CCMEM_URL env or ccmemUrl settings field.
 *     Default: http://localhost:8765
 *   - Health is checked lazily and cached for HEALTH_CACHE_MS.
 *
 * Wire contract matches ccmem/service.py exactly:
 *   write    : req {text, label}              res {id, label}
 *   write_many: req {items:[{text,label}]}    res {ids:[number]}
 *   query    : req {text, top_k}              res {hits:[{id,label,source,margin}]}
 *   bind     : req {texts:[string], label}    res {id, label, theta}
 * The service's `label` field defaults to "" (empty string) — never send null.
 */

const DEFAULT_URL = 'http://localhost:8765';
const HEALTH_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

let _configuredUrl: string = process.env.HARNESS_CCMEM_URL?.trim() || DEFAULT_URL;
// Optional shared-secret token. When set, sent as `Authorization: Bearer <token>`
// on every request so an authenticated ccmem accepts us. Empty by default so
// behaviour is unchanged when ccmem runs without auth.
let _token: string = process.env.HARNESS_CCMEM_TOKEN?.trim() || '';
let _lastHealthCheckMs = 0;
let _lastHealthOk = false;

export function setCcmemUrl(url: string): void {
  _configuredUrl = url.trim() || DEFAULT_URL;
  // Reset health cache when URL changes so the next call re-probes.
  _lastHealthCheckMs = 0;
}

export function getCcmemUrl(): string {
  return _configuredUrl;
}

export function setCcmemToken(token: string): void {
  _token = token.trim();
  // Re-probe health on next call: an auth change can flip reachability.
  _lastHealthCheckMs = 0;
}

export function getCcmemToken(): string {
  return _token;
}

// Returns the auth header object (or empty) to spread into a fetch headers map.
function authHeaders(): Record<string, string> {
  return _token ? { Authorization: `Bearer ${_token}` } : {};
}

// ── Types matching ccmem/service.py schema ────────────────────────────────────

export interface ConceptHit {
  id: number;
  label: string;
  source: string;
  margin: number;
}

export interface StoreResult {
  id: number;
  label: string;
}

export interface BindResult {
  id: number;
  label: string;
  theta: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${_configuredUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if the ccmem service is reachable. Caches results for 30 s so the
 * harness does not spam health checks on every memory write.
 */
export async function isAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - _lastHealthCheckMs < HEALTH_CACHE_MS) return _lastHealthOk;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${_configuredUrl}/health`, { headers: authHeaders(), signal: controller.signal });
    _lastHealthOk = res.ok;
  } catch {
    _lastHealthOk = false;
  } finally {
    clearTimeout(timer);
    _lastHealthCheckMs = now;
  }
  return _lastHealthOk;
}

/**
 * Store a single memory entry as a concept cell.
 * @param text   The text to embed and store.
 * @param label  Optional human-readable label (e.g. "decision: use SQLite").
 * @returns The new cell's ID, or null if the store is unavailable/uninitialised.
 */
export async function store(text: string, label?: string): Promise<StoreResult | null> {
  if (!text.trim()) return null;
  const result = await post<{ id: number; label: string }>(
    '/write',
    { text: text.trim(), label: label ?? '' },
  );
  if (!result) return null;
  return { id: result.id, label: result.label };
}

/**
 * Store multiple memory entries in one batch.
 * Silently skips empty strings.
 */
export async function storeMany(
  entries: Array<{ text: string; label?: string }>,
): Promise<number[]> {
  const valid = entries.filter(e => e.text.trim().length > 0);
  if (valid.length === 0) return [];
  const result = await post<{ ids: number[] }>('/write_many', {
    items: valid.map(e => ({ text: e.text.trim(), label: e.label ?? '' })),
  });
  return result?.ids ?? [];
}

/**
 * Semantic recall — find the most relevant stored memories for a query.
 * Returns an empty array when the service is down or not yet initialised.
 */
export async function recall(
  query: string,
  topK = 5,
): Promise<ConceptHit[]> {
  if (!query.trim()) return [];
  const result = await post<{ hits: ConceptHit[] }>(
    '/query',
    { text: query.trim(), top_k: topK },
  );
  return result?.hits ?? [];
}

/**
 * Bind a set of related texts into a composite concept cell that fires for
 * any of them. Useful for grouping a cluster of related learnings.
 */
export async function bind(
  texts: string[],
  label?: string,
): Promise<BindResult | null> {
  const cleaned = texts.map(t => t.trim()).filter(Boolean);
  if (cleaned.length < 2) return null;
  return post<BindResult>('/bind', {
    texts: cleaned,
    label: label ?? '',
  });
}
