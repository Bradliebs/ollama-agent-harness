import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient, StreamChunk } from './chatClient';

export interface FallbackChatClientEntry {
  backend: string;
  client: IChatClient;
  supportsTools: boolean;
}

export interface RemoteProviderFallbackEvent {
  type: 'provider_fallback';
  fromBackend: string;
  toBackend: string;
  reason: string;
  cooldownSec: number;
}

const remoteProviderFallbackEvents: RemoteProviderFallbackEvent[] = [];

export function drainRemoteProviderFallbackEvents(): RemoteProviderFallbackEvent[] {
  return remoteProviderFallbackEvents.splice(0, remoteProviderFallbackEvents.length);
}

/** Cooldown window in ms. A backend that just hit a limit is skipped for
 * this long before being retried. Env override: HARNESS_REMOTE_FALLBACK_COOLDOWN_MS.
 */
export const FALLBACK_COOLDOWN_MS = parseInt(
  process.env.HARNESS_REMOTE_FALLBACK_COOLDOWN_MS || '30000',
  10,
);

/**
 * Cycles across configured remote providers only for quota/rate/request-size
 * failures. Provider-specific clients still handle their own key pools first.
 *
 * After a backend hits a limit error it enters a cooldown window and is
 * temporarily skipped on subsequent calls, similar to LiteLLM's per-deployment
 * cooldown model. The primary backend (index 0) is always attempted.
 *
 * Request timestamps are tracked per backend so `availableEntries` can prefer
 * the least-recently-used provider when multiple are available.
 */
export class FallbackChatClient implements IChatClient {
  private readonly cooldowns = new Map<string, number>();
  private readonly requestLog = new Map<string, number[]>();

  constructor(private readonly entries: FallbackChatClientEntry[]) {
    if (entries.length === 0) throw new Error('FallbackChatClient requires at least one entry.');
  }

  async chat(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): Promise<ChatResult> {
    return this.tryClients((entry) => entry.client.chat(messages, tools, abortSignal), tools);
  }

  async chatOnce(messages: Message[], tools?: Tool[]): Promise<ChatResult> {
    return this.tryClients((entry) => entry.client.chatOnce(messages, tools), tools);
  }

  async *chatStream(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const entries = this.availableEntries(tools);
    let lastError: unknown;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      let yielded = false;
      try {
        this.recordRequest(entry.backend);
        for await (const chunk of entry.client.chatStream(messages, tools, abortSignal)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (yielded || !isRemoteLimitError(error)) throw error;
        lastError = error;
        const next = entries[i + 1];
        if (next) this.warnFallback(entry, next, error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'No fallback client succeeded.'));
  }

  async listModels(): Promise<string[]> {
    return this.entries[0].client.listModels();
  }

  async getContextWindow(): Promise<number | null> {
    return this.entries[0].client.getContextWindow();
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    const errors: string[] = [];
    for (const entry of this.entries) {
      try {
        const result = await Promise.race([
          entry.client.healthCheck(),
          new Promise<{ ok: boolean; error?: string }>((_, reject) =>
            setTimeout(() => reject(new Error('healthCheck timed out')), 5_000),
          ),
        ]);
        if (result.ok) return { ok: true };
        errors.push(`${entry.backend}: ${result.error ?? 'unavailable'}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${entry.backend}: ${msg}`);
      }
    }
    return { ok: false, error: errors.join('; ') };
  }

  getModel(): string {
    return this.entries[0].client.getModel();
  }

  private async tryClients(
    invoke: (entry: FallbackChatClientEntry) => Promise<ChatResult>,
    tools?: Tool[],
  ): Promise<ChatResult> {
    const entries = this.availableEntries(tools);
    let lastError: unknown;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      try {
        this.recordRequest(entry.backend);
        return await invoke(entry);
      } catch (error) {
        if (!isRemoteLimitError(error)) throw error;
        lastError = error;
        const next = entries[i + 1];
        if (next) this.warnFallback(entry, next, error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'No fallback client succeeded.'));
  }

  private availableEntries(tools?: Tool[]): FallbackChatClientEntry[] {
    const now = Date.now();
    const cooldownMs = FALLBACK_COOLDOWN_MS;
    // Evict expired cooldowns to prevent unbounded map growth
    for (const [backend, failedAt] of this.cooldowns) {
      if (now - failedAt >= cooldownMs) this.cooldowns.delete(backend);
    }
    // Trim stale request timestamps
    for (const [backend, timestamps] of this.requestLog) {
      const fresh = timestamps.filter((t) => t > now - 60_000);
      if (fresh.length === 0) this.requestLog.delete(backend);
      else this.requestLog.set(backend, fresh);
    }
    let candidates = this.entries.filter((entry, index) => {
      // Always try the primary (first) entry regardless of cooldown.
      if (index === 0) return true;
      const failedAt = this.cooldowns.get(entry.backend);
      if (failedAt && now - failedAt < cooldownMs) return false;
      return true;
    });
    if (tools && tools.length > 0) {
      const toolCapable = candidates.filter((entry) => entry.supportsTools);
      candidates = toolCapable.length > 0 ? toolCapable : candidates.slice(0, 1);
    }
    return candidates.length > 0 ? this.sortByLeastLoaded(candidates) : this.entries.slice(0, 1);
  }

  /** Record a request timestamp for a backend. Keeps only the last 60s. */
  private recordRequest(backend: string): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    const log = (this.requestLog.get(backend) ?? []).filter((t) => t > cutoff);
    log.push(now);
    this.requestLog.set(backend, log);
  }

  /** Count requests in the last 60s for a backend. */
  private recentRequestCount(backend: string): number {
    const cutoff = Date.now() - 60_000;
    return (this.requestLog.get(backend) ?? []).filter((t) => t > cutoff).length;
  }

  /** Sort candidates by least-recently-used (fewest requests in the last 60s),
   *  keeping the primary (index-0) at the front when it's not cooled down. */
  private sortByLeastLoaded(candidates: FallbackChatClientEntry[]): FallbackChatClientEntry[] {
    if (candidates.length <= 1) return candidates;
    // Primary stays first; sort the rest by ascending recent-request count.
    const [primary, ...rest] = candidates;
    rest.sort((a, b) => this.recentRequestCount(a.backend) - this.recentRequestCount(b.backend));
    return [primary, ...rest];
  }

  private warnFallback(entry: FallbackChatClientEntry, next: FallbackChatClientEntry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const reason = message.slice(0, 160);
    this.cooldowns.set(entry.backend, Date.now());
    remoteProviderFallbackEvents.push({
      type: 'provider_fallback',
      fromBackend: entry.backend,
      toBackend: next.backend,
      reason,
      cooldownSec: Math.round(FALLBACK_COOLDOWN_MS / 1000),
    });
    console.warn(`[FallbackChatClient] ${entry.backend} hit a limit; trying ${next.backend}. Cooldown ${Math.round(FALLBACK_COOLDOWN_MS / 1000)}s. ${reason}`);
  }
}

/**
 * Detect errors that warrant trying a different remote provider.
 *
 * HTTP 429 (rate limit), quota exhaustion, and HTTP 413 (request too
 * large) are good candidates because another provider may have higher
 * limits.  A 413 from a free-tier backend (e.g. Groq 6 K TPM) doesn't
 * mean the payload is universally too big — paid / higher-tier backends
 * routinely accept 50 K+ tokens.
 */
export function isRemoteLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s+413|request too large|HTTP\s+429|rate.?limit|quota|tokens per minute|TPM|context length|maximum context|insufficient_quota/i.test(message);
}