import type { Message, Tool } from 'ollama';
import type { ChatResult, IChatClient, StreamChunk } from './chatClient';

export interface ReplicateClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
}

/**
 * Minimal Replicate Predictions API adapter. Replicate model schemas vary, so
 * this targets text/chat-like models that accept a `prompt` input and returns
 * the completed prediction output as one assistant message.
 */
export class ReplicateClient implements IChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: ReplicateClientOptions) {
    if (!options.apiKey.trim()) throw new Error('Replicate apiKey is required.');
    if (!options.model.trim()) throw new Error('Replicate model is required.');
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = (options.baseUrl ?? 'https://api.replicate.com/v1').replace(/\/$/, '');
  }

  async chat(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): Promise<ChatResult> {
    if (tools && tools.length > 0) {
      throw new Error('Replicate backend does not support agent tool calls. Use a tool-capable backend for agent loops.');
    }
    const prompt = messagesToPrompt(messages);
    const response = await fetch(this.predictionUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60',
      },
      body: JSON.stringify(this.predictionBody(prompt)),
      signal: abortSignal,
    });
    const body = await readJson(response);
    if (!response.ok) {
      const detail = extractErrorDetail(body) || response.statusText;
      throw new Error(`Replicate HTTP ${response.status}: ${detail}`);
    }
    const prediction = body as ReplicatePrediction;
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(`Replicate prediction ${prediction.status}: ${extractErrorDetail(prediction.error) || 'no details'}`);
    }
    const content = outputToText(prediction.output);
    return {
      message: { role: 'assistant', content },
      usage: { promptTokens: 0, completionTokens: 0, totalDurationNs: 0 },
    };
  }

  chatOnce(messages: Message[], tools?: Tool[]): Promise<ChatResult> {
    return this.chat(messages, tools);
  }

  async *chatStream(messages: Message[], tools?: Tool[], abortSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const result = await this.chat(messages, tools);
    yield { content: result.message.content ?? '', done: true };
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  async getContextWindow(): Promise<number | null> {
    return null;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  getModel(): string {
    return this.model;
  }

  private predictionUrl(): string {
    const parts = this.model.split('/');
    if (parts.length === 2 && !this.model.includes(':')) {
      const [owner, name] = parts.map(encodeURIComponent);
      return `${this.baseUrl}/models/${owner}/${name}/predictions`;
    }
    return `${this.baseUrl}/predictions`;
  }

  private predictionBody(prompt: string): Record<string, unknown> {
    if (this.model.includes('/') && !this.model.includes(':')) {
      return { input: { prompt } };
    }
    return { version: this.model, input: { prompt } };
  }
}

function messagesToPrompt(messages: Message[]): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ''}`)
    .join('\n\n')
    .trim();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(outputToText).join('');
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.output === 'string') return record.output;
    return JSON.stringify(record);
  }
  return output == null ? '' : String(output);
}

function extractErrorDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractErrorDetail).filter(Boolean).join('; ');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return extractErrorDetail(record.detail ?? record.error ?? record.message ?? JSON.stringify(record));
  }
  return '';
}
