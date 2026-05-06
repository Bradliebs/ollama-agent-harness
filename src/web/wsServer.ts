// WebSocket transport for the harness daemon.
//
// Multi-client live event stream. Bridges the in-process event store
// (subscribeEventStream) to all connected clients so the Web UI, TUI, and
// other clients can react to tool calls, sub-agent events, task updates,
// and heartbeat ticks without polling.
//
// Backpressure: each client gets a bounded send buffer. When the buffer
// overflows (slow consumer), the client is sent a single `overflow` message
// and disconnected; it can reconnect cleanly without stalling the
// broadcaster.

import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { subscribeEventStream, type HarnessEvent } from '../persistence/eventStore';

export interface HarnessWsServer {
  wss: WebSocketServer;
  /** Number of currently connected clients. */
  clientCount(): number;
  /** Number of clients that were dropped because their buffer overflowed. */
  overflowCount(): number;
  /** Broadcast an arbitrary message to every connected client. */
  broadcast(message: unknown): void;
  /** Stop the server and close all connections. */
  close(): Promise<void>;
}

export interface WsServerOptions {
  /** Maximum buffered messages per client before overflow drop. Defaults to 256. */
  bufferSize?: number;
  /**
   * Optional override of the test-only "is the socket buffer full" predicate.
   * In production we use ws's own bufferedAmount; tests can inject a stub.
   */
  isBackpressuredFn?: (ws: WebSocket) => boolean;
  /**
   * Coalesce window for harness events (ms). When > 0, events emitted
   * within the window are batched into a single `event_batch` message
   * sent to every client. 0 disables batching (default — preserves
   * original single-event semantics).
   */
  coalesceWindowMs?: number;
}

const WS_PATH = '/ws';
const DEFAULT_BUFFER_SIZE = 256;
/** Drop a client when its underlying socket has more than this many bytes queued. */
const SOCKET_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

interface ClientState {
  queue: string[];
  /** True while the queue is being drained by a setImmediate-scheduled flush. */
  flushing: boolean;
  overflowed: boolean;
}

export function attachWsServer(httpServer: HttpServer, options: WsServerOptions = {}): HarnessWsServer {
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const isBackpressured = options.isBackpressuredFn ?? defaultBackpressureCheck;
  const coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? 0);

  const clients = new Map<WebSocket, ClientState>();
  let overflowCount = 0;

  wss.on('connection', (ws) => {
    clients.set(ws, { queue: [], flushing: false, overflowed: false });
    enqueue(ws, JSON.stringify({ type: 'hello', protocol: 'harness-ws/1', path: WS_PATH }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {
      // Errors will fire close shortly after; remove eagerly so we don't keep
      // sending into a dead socket.
      clients.delete(ws);
    });
  });

  // Coalesce buffer: when coalesceWindowMs > 0 we accumulate harness
  // events into one batched payload per window. When 0 we deliver each
  // event immediately as a single message (legacy behaviour).
  const pendingEvents: HarnessEvent[] = [];
  let coalesceTimer: NodeJS.Timeout | null = null;

  function flushBatch(): void {
    coalesceTimer = null;
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents.splice(0, pendingEvents.length);
    if (batch.length === 1) {
      broadcastToClients({ type: 'event', event: batch[0] });
      return;
    }
    broadcastToClients({ type: 'event_batch', events: batch.map((event) => ({ type: 'event', event })) });
  }

  // Bridge harness events to all clients.
  const unsubscribe = subscribeEventStream((event: HarnessEvent) => {
    if (coalesceWindowMs <= 0) {
      broadcastToClients({ type: 'event', event });
      return;
    }
    pendingEvents.push(event);
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(flushBatch, coalesceWindowMs);
      if (typeof coalesceTimer.unref === 'function') coalesceTimer.unref();
    }
  });

  function broadcastToClients(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of clients.keys()) {
      enqueue(client, payload);
    }
  }

  function enqueue(client: WebSocket, payload: string): void {
    const state = clients.get(client);
    if (!state) return;
    if (state.overflowed) return;
    if (state.queue.length >= bufferSize) {
      state.overflowed = true;
      overflowCount += 1;
      try {
        // One last courtesy message so the UI knows why it was kicked.
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'overflow', reason: 'send buffer overflowed; reconnect to resume' }));
        }
      } catch { /* best-effort */ }
      try { client.close(1009, 'overflow'); } catch { /* best-effort */ }
      clients.delete(client);
      return;
    }
    state.queue.push(payload);
    if (!state.flushing) {
      state.flushing = true;
      setImmediate(() => flushQueue(client));
    }
  }

  function flushQueue(client: WebSocket): void {
    const state = clients.get(client);
    if (!state) return;
    while (state.queue.length > 0) {
      if (client.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        return;
      }
      if (isBackpressured(client)) {
        // Yield: the underlying socket buffer is full. Try again on next tick.
        setImmediate(() => flushQueue(client));
        return;
      }
      const next = state.queue.shift()!;
      try {
        client.send(next);
      } catch {
        clients.delete(client);
        return;
      }
    }
    state.flushing = false;
  }

  async function close(): Promise<void> {
    unsubscribe();
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    pendingEvents.length = 0;
    for (const client of clients.keys()) {
      try { client.close(); } catch { /* best-effort */ }
    }
    clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return {
    wss,
    clientCount: () => clients.size,
    overflowCount: () => overflowCount,
    broadcast: (message: unknown) => broadcastToClients(message),
    close,
  };
}

function defaultBackpressureCheck(ws: WebSocket): boolean {
  // ws exposes bufferedAmount (bytes still in the kernel send buffer).
  return ws.bufferedAmount > SOCKET_BUFFER_LIMIT_BYTES;
}
