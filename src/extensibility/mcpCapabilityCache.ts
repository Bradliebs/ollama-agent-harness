import { classifyError, type ClassifiedError } from '../core/retryClass';
import type { McpProtocolTool } from './mcpClient';

/**
 * In-memory TTL cache for MCP server capability lists (currently just tools).
 *
 * Purpose: collapse repeat "what does this server expose" lookups so callers
 * don't re-roundtrip stdio every time they need the list, and tolerate
 * transient handshake failures by serving the last-known-good value while
 * still surfacing hard failures (auth, permanent) by invalidating + re-throwing.
 *
 * The cache is in-memory only — process-level. Persistent capability state
 * still lives in {@link McpServerDefinition.tools} on disk. This cache sits
 * in front of {@link McpStdioClient.listTools} for runtime callers.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface CapabilityCacheEntry {
  tools: McpProtocolTool[];
  fetchedAt: number;
  ttlMs: number;
  stale: boolean;
  lastError?: ClassifiedError;
}

export interface CapabilityFetchResult {
  tools: McpProtocolTool[];
  /** True if the result came from the cache (whether fresh or stale). */
  cached: boolean;
  /** True if the fetcher failed and we returned a previously-good entry. */
  stale: boolean;
  /** Timestamp of the last successful fetch backing this result. */
  fetchedAt: number;
  /** Classification of the most recent failure (only present when `stale`). */
  lastError?: ClassifiedError;
}

export interface GetToolsOptions {
  /** Override the cache TTL for this call. */
  ttlMs?: number;
  /** Skip the cache lookup and force a fresh fetch. */
  forceRefresh?: boolean;
}

export class McpCapabilityCache {
  private readonly entries = new Map<string, CapabilityCacheEntry>();
  private readonly inflight = new Map<string, Promise<CapabilityFetchResult>>();

  constructor(private readonly defaultTtlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Resolve the tool list for `id`, using the cache when possible.
   *
   * - Fresh hit (within TTL, not stale): returns cached, no fetcher call.
   * - Miss or expired: calls `fetcher`. On success, stores and returns.
   * - Concurrent calls for the same id collapse to one fetcher invocation.
   * - Fetcher failure: classified via {@link classifyError}.
   *   - `auth` / `policyDenied` / `permanent`: invalidate cache, re-throw.
   *   - everything else (transient, rateLimited, unknown): if a prior entry
   *     exists, return it with `stale: true` instead of throwing. Otherwise
   *     re-throw — there's nothing to fall back to.
   */
  async getTools(
    id: string,
    fetcher: () => Promise<McpProtocolTool[]>,
    opts: GetToolsOptions = {},
  ): Promise<CapabilityFetchResult> {
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs;
    const existing = this.entries.get(id);
    const now = Date.now();

    if (!opts.forceRefresh && existing && !existing.stale && now - existing.fetchedAt < ttlMs) {
      return {
        tools: existing.tools,
        cached: true,
        stale: false,
        fetchedAt: existing.fetchedAt,
      };
    }

    const pending = this.inflight.get(id);
    if (pending) return pending;

    const promise = this.refresh(id, fetcher, ttlMs, existing);
    this.inflight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Drop the cached entry (and any in-flight refresh) for `id`. */
  invalidate(id: string): void {
    this.entries.delete(id);
    this.inflight.delete(id);
  }

  /** Drop every cached entry. */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /** Return the raw entry without touching TTL (useful for diagnostics/tests). */
  peek(id: string): CapabilityCacheEntry | undefined {
    return this.entries.get(id);
  }

  private async refresh(
    id: string,
    fetcher: () => Promise<McpProtocolTool[]>,
    ttlMs: number,
    existing: CapabilityCacheEntry | undefined,
  ): Promise<CapabilityFetchResult> {
    try {
      const tools = await fetcher();
      const fetchedAt = Date.now();
      this.entries.set(id, { tools, fetchedAt, ttlMs, stale: false });
      return { tools, cached: false, stale: false, fetchedAt };
    } catch (error) {
      const classified = classifyError(error);
      if (
        classified.class === 'auth' ||
        classified.class === 'policyDenied' ||
        classified.class === 'permanent'
      ) {
        this.entries.delete(id);
        throw error;
      }
      if (existing) {
        const stale: CapabilityCacheEntry = {
          tools: existing.tools,
          fetchedAt: existing.fetchedAt,
          ttlMs,
          stale: true,
          lastError: classified,
        };
        this.entries.set(id, stale);
        return {
          tools: existing.tools,
          cached: true,
          stale: true,
          fetchedAt: existing.fetchedAt,
          lastError: classified,
        };
      }
      throw error;
    }
  }
}

/** Process-wide default cache used by {@link mcpRuntime}. */
export const globalMcpCapabilityCache = new McpCapabilityCache();
