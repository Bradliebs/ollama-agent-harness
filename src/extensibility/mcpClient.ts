import { Buffer } from 'buffer';
import type { ChildProcessWithoutNullStreams } from 'child_process';

export interface McpProtocolTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class McpStdioClient {
  private buffer = '';
  private nextId = 1;
  private initialized?: Promise<void>;
  private pending = new Map<number | string, PendingRequest>();

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    child.stdout.on('data', (chunk) => this.handleData(String(chunk)));
    child.on('exit', () => this.rejectAll(new Error('MCP server process exited.')));
    child.on('error', (error) => this.rejectAll(error));
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ollama-agent-harness', version: '0.3.25' },
      }).then(async () => {
        await this.notify('notifications/initialized', {});
      });
    }
    await this.initialized;
  }

  async listTools(): Promise<McpProtocolTool[]> {
    await this.initialize();
    const result = await this.request('tools/list', {});
    const tools = result && typeof result === 'object' && Array.isArray((result as { tools?: unknown[] }).tools)
      ? (result as { tools: unknown[] }).tools
      : [];
    return tools.map(sanitizeProtocolTool).filter((tool): tool is McpProtocolTool => Boolean(tool));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args });
    return result && typeof result === 'object' ? result as McpToolCallResult : { content: [{ type: 'text', text: String(result ?? '') }] };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const payload = JSON.stringify(message);
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error(`MCP request timed out: ${method}`));
    }, this.timeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(formatJsonRpcPayload(payload));
    return promise;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.child.stdin.write(formatJsonRpcPayload(payload));
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const framed = readFramedMessage(this.buffer);
      if (framed) {
        this.buffer = framed.rest;
        this.handleMessageText(framed.message);
        continue;
      }
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = this.buffer.slice(0, newlineIndex).trim();
      if (!line.startsWith('{')) return;
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleMessageText(line);
    }
  }

  private handleMessageText(text: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP error ${message.error.code ?? ''}`.trim()));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function formatJsonRpcPayload(payload: string): string {
  return `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`;
}

function readFramedMessage(buffer: string): { message: string; rest: string } | null {
  const separator = buffer.indexOf('\r\n\r\n');
  const separatorLength = separator >= 0 ? 4 : 0;
  const headerEnd = separator >= 0 ? separator : buffer.indexOf('\n\n');
  const headerSeparatorLength = separator >= 0 ? separatorLength : 2;
  if (headerEnd < 0) return null;
  const header = buffer.slice(0, headerEnd);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const bodyStart = headerEnd + headerSeparatorLength;
  if (buffer.length < bodyStart + length) return null;
  return { message: buffer.slice(bodyStart, bodyStart + length), rest: buffer.slice(bodyStart + length) };
}

function sanitizeProtocolTool(value: unknown): McpProtocolTool | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() || undefined : undefined,
    inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema as Record<string, unknown> : undefined,
  };
}