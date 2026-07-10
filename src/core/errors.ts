export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

export class OllamaConnectionError extends HarnessError {
  constructor(message: string) {
    super(message, 'OLLAMA_CONNECTION', true);
  }
}

export class ContextOverflowError extends HarnessError {
  constructor(tokenCount: number, limit: number) {
    super(
      `Context overflow: ${tokenCount} tokens exceeds ${limit} limit`,
      'CONTEXT_OVERFLOW',
      true,
    );
  }
}

export class ToolExecutionError extends HarnessError {
  constructor(toolName: string, message: string) {
    super(`Tool '${toolName}': ${message}`, 'TOOL_EXECUTION', true);
  }
}

export class PermissionDeniedError extends HarnessError {
  constructor(toolName: string, reason: string) {
    super(`Permission denied for '${toolName}': ${reason}`, 'PERMISSION_DENIED', false);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
  onAttempt?: (info: { attempt: number; classified: import('./retryClass').ClassifiedError; nextDelayMs: number }) => void,
): Promise<T> {
  // Local import keeps the cycle one-directional (retryClass imports errors).
  const { classifyError, isRetryable, computeRetryDelayMs } = await import('./retryClass');
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const classified = classifyError(error);

      // Non-retryable classes (auth / policyDenied / permanent / unknown)
      // surface immediately. Preserves the original HarnessError.recoverable
      // contract because `recoverable === false` classifies as `permanent`.
      if (!isRetryable(classified.class)) {
        throw error;
      }

      if (attempt < maxAttempts) {
        const delayMs = computeRetryDelayMs(classified, attempt, baseDelayMs);
        try { onAttempt?.({ attempt, classified, nextDelayMs: delayMs }); } catch { /* swallowed — telemetry only */ }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

export function errorToToolResult(error: unknown): { success: false; output: string; error: string } {
  if (error instanceof HarnessError) {
    return {
      success: false,
      output: `[${error.code}] ${error.message}`,
      error: error.message,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    output: `Unexpected error: ${message}`,
    error: message,
  };
}
