import type { ToolCall } from '../types';

export interface PendingPermissionPrompt {
  id: string;
  call: ToolCall;
  reason?: string;
  createdAt: string;
}

interface PendingPromptState extends PendingPermissionPrompt {
  resolve: (result: { allowed: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

export class PermissionPromptBroker {
  private pending = new Map<string, PendingPromptState>();

  constructor(private readonly timeoutMs = 300_000) {}

  request(call: ToolCall, reason?: string): Promise<{ allowed: boolean; reason?: string }> {
    const id = createPromptId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolve(id, false, 'Permission prompt timed out');
      }, this.timeoutMs);
      this.pending.set(id, {
        id,
        call,
        reason,
        createdAt: new Date().toISOString(),
        resolve,
        timer,
      });
    });
  }

  list(): PendingPermissionPrompt[] {
    return Array.from(this.pending.values()).map(({ resolve: _resolve, timer: _timer, ...prompt }) => prompt);
  }

  resolve(id: string, allowed: boolean, reason?: string): boolean {
    const prompt = this.pending.get(id);
    if (!prompt) return false;
    clearTimeout(prompt.timer);
    this.pending.delete(id);
    prompt.resolve({ allowed, reason: reason ?? (allowed ? 'Approved by user' : 'Denied by user') });
    return true;
  }

  clear(): void {
    for (const prompt of this.pending.values()) {
      clearTimeout(prompt.timer);
      prompt.resolve({ allowed: false, reason: 'Permission prompts cleared' });
    }
    this.pending.clear();
  }
}

function createPromptId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}