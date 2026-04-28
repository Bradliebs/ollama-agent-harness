/**
 * Ollama Agent Harness — Error Handling Patterns
 *
 * Demonstrates the harness's error handling conventions:
 * - Errors surface as tool results so the model can adapt
 * - Graceful recovery with retry logic
 * - Typed error hierarchy for different failure modes
 */

// --- Error Types ---

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

export class ToolExecutionError extends HarnessError {
  constructor(
    public readonly toolName: string,
    message: string,
    recoverable = true,
  ) {
    super(message, 'TOOL_EXECUTION_ERROR', recoverable);
    this.name = 'ToolExecutionError';
  }
}

export class PermissionDeniedError extends HarnessError {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(`Permission denied for ${toolName}: ${reason}`, 'PERMISSION_DENIED', false);
    this.name = 'PermissionDeniedError';
  }
}

export class ContextOverflowError extends HarnessError {
  constructor(public readonly tokenCount: number, public readonly limit: number) {
    super(`Context overflow: ${tokenCount} tokens exceeds ${limit} limit`, 'CONTEXT_OVERFLOW', true);
    this.name = 'ContextOverflowError';
  }
}

export class OllamaConnectionError extends HarnessError {
  constructor(message: string) {
    super(message, 'OLLAMA_CONNECTION_ERROR', true);
    this.name = 'OllamaConnectionError';
  }
}

// --- Error-to-Tool-Result Conversion ---

interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Wraps tool execution with error handling.
 * Errors become tool results the model can reason about.
 */
export async function safeToolExecution(
  toolName: string,
  fn: () => Promise<string>,
): Promise<ToolResult> {
  try {
    const output = await fn();
    return { success: true, output };
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return {
        success: false,
        error: `Permission denied: ${error.reason}. This tool requires explicit approval.`,
      };
    }

    if (error instanceof ToolExecutionError) {
      return {
        success: false,
        error: `Tool '${error.toolName}' failed: ${error.message}`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unexpected error in '${toolName}': ${message}`,
    };
  }
}

// --- Retry with Backoff ---

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (error instanceof HarnessError && !error.recoverable) {
        throw error;
      }

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// --- Usage Example ---

async function example() {
  // Tool execution with automatic error-to-result conversion
  const result = await safeToolExecution('file_read', async () => {
    // Simulated tool logic
    return 'file contents here';
  });

  console.log(result);
  // { success: true, output: 'file contents here' }

  // Retry with exponential backoff for transient failures
  const data = await withRetry(async () => {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) throw new OllamaConnectionError(`HTTP ${response.status}`);
    return response.json();
  });

  console.log(data);
}

example().catch(console.error);
