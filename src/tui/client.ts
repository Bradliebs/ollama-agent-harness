// TUI client. Connects to a running Harness daemon over HTTP + WebSocket
// and provides a readline-driven chat interface that shares state with
// the Web UI in real time. No React, no Ink — just Node built-ins +
// the existing `ws` dependency.

import * as readline from 'readline';
import { WebSocket } from 'ws';
import {
  formatActiveSubagentsBar,
  formatChatEntry,
  formatStatusLine,
  parseSseChunk,
  type ActiveSubagentSummary,
  type ChatEntry,
} from './render';

export interface TuiClientOptions {
  /** Daemon base URL, e.g. http://127.0.0.1:4300 */
  baseUrl?: string;
  /** Optional model id to send with every chat request. */
  model?: string;
  /** Use ANSI colour escape codes. Defaults to whether stdout is a TTY. */
  useColor?: boolean;
  /** Override fetch (mainly for tests). */
  fetchImpl?: typeof fetch;
  /** Override WebSocket constructor (mainly for tests). */
  webSocketImpl?: typeof WebSocket;
  /** Override stdin stream (mainly for tests). */
  stdin?: NodeJS.ReadableStream;
  /** Override stdout stream (mainly for tests). */
  stdout?: NodeJS.WritableStream;
}

export interface TuiClient {
  /** Returns the current chat transcript snapshot. */
  getTranscript(): ChatEntry[];
  /** Returns the current active sub-agents snapshot. */
  getActiveSubagents(): ActiveSubagentSummary[];
  /** Push a chat message and stream the response. Resolves when the assistant turn finishes. */
  send(message: string): Promise<void>;
  /** Re-render the current screen. Useful after external state changes. */
  render(): void;
  /** Stop readline + close the WebSocket. */
  stop(): Promise<void>;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:4300';
const ACTIVE_REFRESH_MS = 5_000;

export function createTuiClient(options: TuiClientOptions = {}): TuiClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const useColor = options.useColor ?? Boolean(process.stdout.isTTY);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wsImpl = options.webSocketImpl ?? WebSocket;

  if (!fetchImpl) {
    throw new Error('global fetch is required (Node 18+)');
  }

  const transcript: ChatEntry[] = [];
  let active: ActiveSubagentSummary[] = [];
  let connected = false;
  let model = options.model ?? '';
  let hint = '';
  let stopped = false;
  let ws: WebSocket | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean((stdin as { isTTY?: boolean }).isTTY),
    prompt: '> ',
  });

  function appendEntry(entry: ChatEntry): void {
    transcript.push({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
    render();
  }

  function render(): void {
    const cols = (stdout as NodeJS.WriteStream).columns ?? 80;
    const bar = formatActiveSubagentsBar(active, useColor);
    const status = formatStatusLine({ connected, model, hint }, useColor);
    const recent = transcript.slice(-12); // keep terminal output bounded
    for (const entry of recent.slice(-1)) {
      const lines = formatChatEntry(entry, cols, useColor);
      for (const line of lines) stdout.write(line + '\n');
    }
    if (bar) stdout.write(bar + '\n');
    stdout.write(status + '\n');
    if (typeof rl.prompt === 'function' && !stopped) {
      rl.prompt(true);
    }
  }

  function refreshActiveSubagents(): void {
    fetchImpl(`${baseUrl}/api/subagents`)
      .then((response) => response.json())
      .then((raw) => {
        const data = raw as { subagents?: Array<{ id: string; name: string; durationMs?: number }> };
        if (!data || !Array.isArray(data.subagents)) return;
        active = data.subagents.map((record) => ({
          id: record.id,
          name: record.name,
          durationMs: record.durationMs ?? 0,
        }));
        render();
      })
      .catch(() => { /* best-effort */ });
  }

  function connectWebSocket(): void {
    if (stopped) return;
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    try {
      ws = new wsImpl(wsUrl);
    } catch {
      // Daemon unreachable — try again shortly.
      hint = 'daemon unreachable; retrying';
      connected = false;
      render();
      setTimeout(connectWebSocket, 3_000).unref?.();
      return;
    }
    ws.on('open', () => {
      connected = true;
      hint = '';
      render();
    });
    ws.on('close', () => {
      connected = false;
      hint = 'WS closed; retrying';
      render();
      if (!stopped) setTimeout(connectWebSocket, 3_000).unref?.();
    });
    ws.on('error', () => {
      connected = false;
      hint = 'WS error';
    });
    ws.on('message', (raw) => {
      let parsed: { type?: string; event?: { category?: string; type?: string; data?: Record<string, unknown> }; events?: Array<{ type?: string; event?: { category?: string; type?: string; data?: Record<string, unknown> } }> };
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handle = (harnessEvent: { category?: string; type?: string }): void => {
        const category = harnessEvent.category;
        const type = harnessEvent.type;
        if (category === 'system' && (type === 'subagent.start' || type === 'subagent.end' || type === 'subagent.cancel')) {
          refreshActiveSubagents();
        }
      };
      if (parsed.type === 'event_batch' && Array.isArray(parsed.events)) {
        for (const inner of parsed.events) {
          if (inner?.event) handle(inner.event);
        }
        return;
      }
      if (parsed.type !== 'event' || !parsed.event) return;
      handle(parsed.event);
    });
  }

  async function send(message: string): Promise<void> {
    const text = message.trim();
    if (!text) return;
    appendEntry({ role: 'user', text });
    let assistantBuffer = '';
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: text, model }),
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      appendEntry({ role: 'error', text: `Failed to reach daemon: ${messageText}` });
      return;
    }
    if (!response.ok || !response.body) {
      appendEntry({ role: 'error', text: `Daemon responded ${response.status}` });
      return;
    }
    const reader = (response.body as unknown as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        const payload = event.payload as { type?: string; content?: string; reason?: string; message?: string; call?: { name?: string }; result?: { output?: string; success?: boolean } };
        if (!payload || typeof payload.type !== 'string') continue;
        if (payload.type === 'text' && typeof payload.content === 'string') {
          assistantBuffer += payload.content;
        } else if (payload.type === 'tool_call' && payload.call?.name) {
          appendEntry({ role: 'tool', text: `\u2192 ${payload.call.name}` });
        } else if (payload.type === 'tool_result' && payload.result) {
          const status = payload.result.success === false ? '\u2717' : '\u2713';
          const snippet = String(payload.result.output ?? '').split('\n')[0].slice(0, 120);
          appendEntry({ role: 'tool', text: `${status} ${snippet}` });
        } else if (payload.type === 'error' && payload.message) {
          appendEntry({ role: 'error', text: payload.message });
        } else if (payload.type === 'done') {
          // Drain any buffered assistant text into the transcript.
          if (assistantBuffer.trim()) {
            appendEntry({ role: 'assistant', text: assistantBuffer });
            assistantBuffer = '';
          }
        }
      }
    }
    if (assistantBuffer.trim()) {
      appendEntry({ role: 'assistant', text: assistantBuffer });
    }
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === '/quit' || trimmed === '/exit') {
      stop().catch(() => { /* shutting down */ });
      return;
    }
    if (trimmed === '/help') {
      appendEntry({ role: 'system', text: 'Commands: /quit, /exit, /help, /agents, /clear' });
      rl.prompt();
      return;
    }
    if (trimmed === '/agents') {
      const summary = active.length === 0 ? 'No active sub-agents.' : active.map((record) => `${record.name} ${Math.round(record.durationMs / 1000)}s [${record.id}]`).join('\n');
      appendEntry({ role: 'system', text: summary });
      rl.prompt();
      return;
    }
    if (trimmed === '/clear') {
      transcript.length = 0;
      stdout.write('\x1b[2J\x1b[0f');
      render();
      return;
    }
    send(trimmed).catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      appendEntry({ role: 'error', text: messageText });
    });
  });

  rl.on('close', () => {
    stop().catch(() => { /* shutting down */ });
  });

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (ws) {
      try { ws.close(); } catch { /* best-effort */ }
      ws = null;
    }
    rl.close();
  }

  // Wire startup actions.
  refreshActiveSubagents();
  connectWebSocket();
  refreshTimer = setInterval(refreshActiveSubagents, ACTIVE_REFRESH_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  appendEntry({ role: 'system', text: `Connected to ${baseUrl}. Type /help for commands.` });

  return {
    getTranscript: () => transcript.slice(),
    getActiveSubagents: () => active.slice(),
    send,
    render,
    stop,
  };
}
