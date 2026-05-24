/**
 * Concept Memory Client — thin HTTP client for the cc_service (ccmem) FastAPI.
 *
 * cc_service lives at H:\MiniLM\cc_service and exposes:
 *   POST /write          — store a single text as a concept cell
 *   POST /write_many     — batch store
 *   POST /query          — semantic search
 *   POST /bind           — bind related cells into a composite cell
 *   GET  /health         — liveness probe
 *
 * Integration rules:
 *   - All calls are best-effort. If the service is unreachable or returns an
 *     error, functions return null / empty arrays and never throw. The harness
 *     works identically when ccmem is offline.
 *   - URL configured via HARNESS_CCMEM_URL env or ccmemUrl settings field.
 *     Default: http://localhost:8765
 *   - Health is checked lazily and cached for HEALTH_CACHE_MS.
 */

const DEFAULT_URL = 'http://localhost:8765';
const HEALTH_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

let _configuredUrl: string = process.env.HARNESS_CCMEM_URL?.trim() || DEFAULT_URL;
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

// ── Types matching cc_service schema ──────────────────────────────────────────

export interface ConceptHit {
  cell_id: number;
  label: string | null;
  kind: string;
  activation: number;
  margin: number;
  source_text: string | null;
}

export interface StoreResult {
  cell_id: number;
  label: string | null;
}

export interface BindResult {
  bound_cell_id: number;
  source_cell_ids: number[];
  items_fire_after_binding: boolean[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${_configuredUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${_configuredUrl}/health`, { signal: controller.signal });
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
  const result = await post<{ cell_id: number; label: string | null; theta: number }>(
    '/write',
    { text: text.trim(), label: label ?? null },
  );
  if (!result) return null;
  return { cell_id: result.cell_id, label: result.label };
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
  const result = await post<{ cell_ids: number[] }>('/write_many', {
    texts: valid.map(e => e.text.trim()),
    labels: valid.map(e => e.label ?? null),
  });
  return result?.cell_ids ?? [];
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
  const result = await post<{
    query: string;
    n_hits: number;
    hits: ConceptHit[];
  }>('/query', { text: query.trim(), top_k: topK });
  return result?.hits ?? [];
}

/**
 * Bind a set of related cells into a composite concept cell that fires for
 * any of them. Useful for grouping a cluster of related learnings.
 */
export async function bind(
  cellIds: number[],
  label?: string,
): Promise<BindResult | null> {
  if (cellIds.length < 2) return null;
  return post<BindResult>('/bind', {
    source_cell_ids: cellIds,
    label: label ?? null,
  });
}
