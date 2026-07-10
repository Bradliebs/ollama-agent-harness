import type { ToolCall } from '../types';
import type { CommandClassification, ClassifierDeps } from './commandClassifier';
import { classifyCommand } from './commandClassifier';

export interface PendingPermissionPrompt {
  id: string;
  call: ToolCall;
  reason?: string;
  createdAt: string;
  /**
   * Friendly, model-generated explanation of a shell command and a safe
   * broadening pattern. Populated asynchronously after the prompt is created
   * (only for commands), so it may be absent on the first poll and appear on
   * a subsequent one.
   */
  classification?: CommandClassification;
}

interface PendingPromptState extends PendingPermissionPrompt {
  resolve: (result: { allowed: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;

function resolveDefaultTimeout(): number {
  // Override via env so unattended/headless runs can fail fast (e.g.
  // 30s) instead of stalling for the full 5 minutes before the model
  // gets the denial. Invalid or non-positive values fall back to the
  // built-in default.
  const raw = process.env.HARNESS_PERMISSION_PROMPT_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROMPT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROMPT_TIMEOUT_MS;
  return Math.floor(parsed);
}

export class PermissionPromptBroker {
  private pending = new Map<string, PendingPromptState>();
  private readonly timeoutMs: number;
  private classifierDeps?: ClassifierDeps;

  constructor(timeoutMs?: number, classifierDeps?: ClassifierDeps) {
    this.timeoutMs = timeoutMs ?? resolveDefaultTimeout();
    this.classifierDeps = classifierDeps;
  }

  /**
   * Attach (or replace) the command classifier after construction. Used by
   * the server, which builds the broker before the model runtime exists.
   */
  setClassifier(deps: ClassifierDeps): void {
    this.classifierDeps = deps;
  }

  request(call: ToolCall, reason?: string): Promise<{ allowed: boolean; reason?: string }> {
    const id = createPromptId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Embed the tool name and the original reason so the model gets
        // an actionable error rather than the bare "Permission prompt
        // timed out" string. Common autonomous-run remediations: add
        // the destination to allowed-paths, lower
        // HARNESS_PERMISSION_PROMPT_TIMEOUT_MS, or run with permission
        // mode 'auto'. The hint is appended once per timeout.
        const detail = reason ? ` (${reason})` : '';
        const hint = ` Add the path to allowed-external-paths, set HARNESS_PERMISSION_PROMPT_TIMEOUT_MS, or rerun with permission mode 'auto'.`;
        this.resolve(id, false, `Permission prompt for '${call.name}' timed out after ${this.timeoutMs}ms${detail}.${hint}`);
      }, this.timeoutMs);
      this.pending.set(id, {
        id,
        call,
        reason,
        createdAt: new Date().toISOString(),
        resolve,
        timer,
      });
      // Fire-and-forget: enrich shell-command prompts with a friendly
      // explanation. Never blocks or fails the approval flow.
      void this.classify(id, call);
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

  private async classify(id: string, call: ToolCall): Promise<void> {
    if (!this.classifierDeps) return;
    const command = extractCommand(call);
    if (!command) return;
    try {
      const classification = await classifyCommand(command, this.classifierDeps);
      // The prompt may have resolved while the model was thinking — only
      // attach if it's still pending.
      const state = this.pending.get(id);
      if (state) state.classification = classification;
    } catch {
      // Advisory only — never surface classifier failures into the flow.
    }
  }
}

/**
 * Pull a shell command string out of a tool call. Only shell-style tools
 * carry a `command`; everything else returns undefined so we skip classifying.
 */
function extractCommand(call: ToolCall): string | undefined {
  if (call.name !== 'bash' && call.name !== 'shell' && call.name !== 'docker_exec') return undefined;
  const command = (call.input as Record<string, unknown> | undefined)?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

function createPromptId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}