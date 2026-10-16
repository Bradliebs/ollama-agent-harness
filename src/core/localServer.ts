import { OpenAIClient } from './openaiClient';
import type { ModelLocality } from './chatClient';

/**
 * Local OpenAI-compatible servers: Strata, llama.cpp's llama-server, LM Studio,
 * vLLM, LocalAI and the like, running on this machine. Chosen with the `local/`
 * model prefix (or HARNESS_BACKEND=local). Unlike the cloud presets they need
 * no API key, cost nothing, never take part in remote fallback, and are given
 * time for slow local prompt reading.
 */
export const LOCAL_SERVER_BACKEND = 'local';
/** Strata's and llama-server's default address. */
export const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:8080/v1';
/** Local servers read long prompts slowly (Strata: ~1 minute per 30K tokens). */
const DEFAULT_LOCAL_TIMEOUT_MS = 600_000;
/** Used when neither the setting nor the server says how big the window is. */
const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768;

export function localServerBaseUrl(): string {
  return (process.env.HARNESS_LOCAL_BASE_URL?.trim() || DEFAULT_LOCAL_SERVER_URL).replace(/\/+$/, '');
}

function localTimeoutMs(): number {
  const parsed = Number(process.env.HARNESS_LOCAL_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LOCAL_TIMEOUT_MS;
}

function authHeaders(): Record<string, string> {
  const key = process.env.HARNESS_LOCAL_API_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Only a server on this machine counts as local ($0, nothing leaves it). A URL
 * on another host still works, but its locality is reported as unknown.
 */
export function isLoopbackServer(url = localServerBaseUrl()): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export function createLocalServerClient(model: string, numCtx?: number): OpenAIClient {
  return new OpenAIClient({
    baseUrl: localServerBaseUrl(),
    // Servers started without a key ignore the header; Strata accepts any key.
    apiKey: process.env.HARNESS_LOCAL_API_KEY?.trim() || 'local',
    model,
    contextWindow: numCtx,
    providerLabel: 'Local server',
    timeoutMs: localTimeoutMs(),
    locality: (isLoopbackServer() ? 'local' : 'unknown') as ModelLocality,
    streamPreview: true,
  });
}

/** Returned by getJson when the server took too long (it may be busy, not gone). */
const TIMED_OUT = Symbol('timed out');

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', ...authHeaders() }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return controller.signal.aborted ? TIMED_OUT : null;
  } finally {
    clearTimeout(timer);
  }
}

const MODEL_LIST_CACHE_MS = 15_000;
const modelListCache = new Map<string, { at: number; models: string[] }>();
const lastContextWindow = new Map<string, number>();

/**
 * Model ids the local server reports at /models, or [] when it isn't running.
 * Cached for 15 seconds (the model list and readiness checks ask often), and a
 * server too busy to answer in time keeps the models it reported last.
 */
export async function listLocalServerModels(timeoutMs = 1_500): Promise<string[]> {
  const base = localServerBaseUrl();
  const cached = modelListCache.get(base);
  if (cached && Date.now() - cached.at < MODEL_LIST_CACHE_MS) return cached.models;
  const body = await getJson(`${base}/models`, timeoutMs) as { data?: Array<{ id?: unknown }> } | typeof TIMED_OUT | null;
  const models = body && body !== TIMED_OUT && Array.isArray(body.data)
    ? [...new Set(body.data.map((entry) => entry?.id).filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
    : body === TIMED_OUT && cached ? cached.models : [];
  modelListCache.set(base, { at: Date.now(), models });
  return models;
}

/**
 * The server's context window: HARNESS_LOCAL_CONTEXT_WINDOW, else what a
 * llama.cpp-based server reports at /props (or reported last time), else a
 * conservative 32K.
 */
export async function getLocalServerContextWindow(timeoutMs = 1_500): Promise<number> {
  const configured = Number(process.env.HARNESS_LOCAL_CONTEXT_WINDOW);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const root = localServerBaseUrl().replace(/\/v1$/, '');
  const props = await getJson(`${root}/props`, timeoutMs) as { default_generation_settings?: { n_ctx?: unknown } } | typeof TIMED_OUT | null;
  const nCtx = Number(props && props !== TIMED_OUT ? props.default_generation_settings?.n_ctx : NaN);
  if (Number.isFinite(nCtx) && nCtx > 0) {
    lastContextWindow.set(root, Math.floor(nCtx));
    return Math.floor(nCtx);
  }
  // A busy single-request server may not answer; keep what it said before.
  return lastContextWindow.get(root) ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
}

/** Forget cached probe results (tests, or after changing the server). */
export function resetLocalServerCache(): void {
  modelListCache.clear();
  lastContextWindow.clear();
}

/** `local/<model>` → `<model>`, or null for any other id. */
export function localServerModelName(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 && model.slice(0, slash).toLowerCase() === LOCAL_SERVER_BACKEND ? model.slice(slash + 1) : null;
}
