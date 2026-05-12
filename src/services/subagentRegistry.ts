// In-process registry of currently-running sub-agents.
//
// `runSubagent` registers itself when invoked with an explicit `runId`
// (so background callers like the heartbeat task runner are visible) and
// unregisters on exit. The registry is the source of truth for the
// "active sub-agents" UI bar and the cancel endpoint.
//
// Designed to be cheap and dependency-free: no disk I/O, no event store
// coupling, no singleton-per-process state beyond a single Map. The
// server wires emitEvent() in alongside the registry so live WebSocket
// clients see start/end events; this module just tracks state.

type RegistryEvent =
  | { kind: 'start'; record: ActiveSubagent }
  | { kind: 'end'; id: string }
  | { kind: 'cancel'; id: string };

const registryListeners = new Set<(event: RegistryEvent) => void>();

/**
 * Subscribe to registry change events. Used by the server to bridge
 * registry mutations onto the harness event store so WebSocket clients
 * see start / end / cancel updates without polling.
 */
export function subscribeSubagentRegistry(listener: (event: RegistryEvent) => void): () => void {
  registryListeners.add(listener);
  return () => { registryListeners.delete(listener); };
}

function emitRegistryEvent(event: RegistryEvent): void {
  for (const listener of registryListeners) {
    try { listener(event); } catch { /* listener errors are non-fatal */ }
  }
}

export interface ActiveSubagent {
  id: string;
  /** Display label (typically the agent_id or `name`). */
  name: string;
  /** Truncated prompt — first 200 chars, for the UI bar. */
  promptSnippet: string;
  /** ms since epoch when the run started. */
  startedAtMs: number;
  controller: AbortController;
}

const active = new Map<string, ActiveSubagent>();

export interface RegisterSubagentInput {
  id: string;
  name: string;
  prompt: string;
  controller: AbortController;
  startedAtMs?: number;
}

export function registerSubagent(input: RegisterSubagentInput): ActiveSubagent {
  const record: ActiveSubagent = {
    id: input.id,
    name: input.name,
    promptSnippet: (input.prompt || '').slice(0, 200),
    startedAtMs: input.startedAtMs ?? Date.now(),
    controller: input.controller,
  };
  active.set(record.id, record);
  emitRegistryEvent({ kind: 'start', record });
  return record;
}

export function unregisterSubagent(id: string): void {
  if (active.delete(id)) {
    emitRegistryEvent({ kind: 'end', id });
  }
}

export function listActiveSubagents(): ActiveSubagent[] {
  return Array.from(active.values()).sort((a, b) => a.startedAtMs - b.startedAtMs);
}

export function getActiveSubagent(id: string): ActiveSubagent | undefined {
  return active.get(id);
}

/**
 * Cancel a running sub-agent by aborting its controller. Returns true
 * when a cancel signal was sent, false when the id was not found.
 * The caller is responsible for unregistering on the run's natural exit;
 * cancel does not eagerly drop the record so the run can still surface
 * a final "cancelled" event before disappearing from the bar.
 */
export function cancelSubagent(id: string): boolean {
  const record = active.get(id);
  if (!record) return false;
  try {
    record.controller.abort();
  } catch {
    // ignore — cancel is best-effort
  }
  emitRegistryEvent({ kind: 'cancel', id });
  return true;
}

/** Test helper: clear the registry. Not exported through the public API. */
export function _resetSubagentRegistryForTests(): void {
  active.clear();
}
