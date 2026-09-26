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
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private initialized?: Promise<void>;
  private pending = new Map<number | string, PendingRequest>();

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = DEFAULT_TIMEOUT_MS, private readonly framing: 'newline' | 'content-length' = 'newline') {
    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    child.on('exit', () => this.rejectAll(new Error('MCP server process exited.')));
    child.on('error', (error) => this.rejectAll(error));
    child.stdin.on('error', (error) => this.rejectAll(error));
    child.stdout.on('end', () => this.rejectAll(new Error('MCP server output closed.')));
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ollama-agent-harness', version: '0.3.25' },
      }).then(async (result) => {
        if (!result || typeof result !== 'object' || (result as { protocolVersion?: unknown }).protocolVersion !== '2024-11-05') {
          this.child.stdin.end();
          throw new Error('MCP server returned an unsupported protocol version.');
        }
        await this.notify('notifications/initialized', {});
      });
    }
    await this.initialized;
  }

  async listTools(): Promise<McpProtocolTool[]> {
    await this.initialize();
    const tools: McpProtocolTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) {
        throw new Error('MCP server returned an invalid tool list.');
      }
      const page = result as { tools: unknown[]; nextCursor?: unknown };
      tools.push(...page.tools.map(sanitizeProtocolTool).filter((tool): tool is McpProtocolTool => Boolean(tool)));
      if (page.nextCursor !== undefined && typeof page.nextCursor !== 'string') throw new Error('MCP server returned an invalid pagination cursor.');
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor) || seenCursors.size >= 100) throw new Error('MCP tool pagination did not terminate.');
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
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
      if (method !== 'initialize' && !this.child.stdin.destroyed) {
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Request timed out' });
      }
      pending.reject(new Error(`MCP request timed out: ${method}`));
    }, this.timeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(formatJsonRpcPayload(payload, this.framing));
    return promise;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.child.stdin.write(formatJsonRpcPayload(payload, this.framing));
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const framed = readFramedMessage(this.buffer);
      if (framed) {
        this.buffer = framed.rest;
        this.handleMessageText(framed.message);
        continue;
      }
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = this.buffer.subarray(0, newlineIndex).toString('utf8').trim();
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
    if (message.method) {
      const response = message.method === 'ping'
        ? { jsonrpc: '2.0', id: message.id, result: {} }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } };
      this.child.stdin.write(formatJsonRpcPayload(JSON.stringify(response), this.framing));
      return;
    }
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

function formatJsonRpcPayload(payload: string, framing: 'newline' | 'content-length'): string {
  return framing === 'content-length' ? `Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}` : `${payload}\n`;
}

function readFramedMessage(buffer: Buffer): { message: string; rest: Buffer } | null {
  const separator = buffer.indexOf('\r\n\r\n');
  const separatorLength = separator >= 0 ? 4 : 0;
  const headerEnd = separator >= 0 ? separator : buffer.indexOf('\n\n');
  const headerSeparatorLength = separator >= 0 ? separatorLength : 2;
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const bodyStart = headerEnd + headerSeparatorLength;
  if (buffer.length < bodyStart + length) return null;
  return { message: buffer.subarray(bodyStart, bodyStart + length).toString('utf8'), rest: buffer.subarray(bodyStart + length) };
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