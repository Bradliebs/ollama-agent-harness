import type { Tool, ToolCall, ToolResult } from '../types';
import type { HookPipeline } from '../extensibility/hookPipeline';
import { trackToolUsage, type LearningRecorder } from '../learning/engine';
import type { RuntimeTracer } from '../core/tracing';
import { recordSwallowed } from '../observability/silentFailureSink';
import type { ReadBeforeWriteGate } from './readBeforeWriteGate';
import { compressToolResult, type CompressionConfig } from './outputCompression';
import { prepareSideEffectRecording, type SideEffectRecorder } from '../persistence/sideEffectRecording';
import type { ToolInspectionManager, InspectorContext } from '../safety/toolInspectors';
import { maybeSpoolLargeResponse, type LargeResponseConfig } from './largeResponseHandler';
import { validateToolInput } from './validateToolInput';
import { classifyError } from '../core/retryClass';

export interface DispatchResult {
  call: ToolCall;
  result: ToolResult;
}

export interface DispatchOptions {
  hooks?: HookPipeline;
  trackUsage?: boolean;
  tracer?: RuntimeTracer;
  /** Per-session, project-scoped learning recorder. When provided and
   * `trackUsage` is true, tool calls are recorded against this recorder
   * instead of the legacy process-wide default. Required to avoid the
   * cross-session race on the module-level default. */
  learningRecorder?: LearningRecorder;
  /**
   * When set, the gate is consulted before every write tool call.
   * Read tool calls are recorded in the gate's ledger automatically.
   * This enforces the read-before-write discipline.
   */
  readBeforeWriteGate?: ReadBeforeWriteGate;
  /**
   * When true, successful string tool outputs are run through the
   * rule-based compression pass (`outputCompression.ts`) before they
   * enter history. Gated OFF by default; the caller decides based on
   * `HARNESS_TOOL_COMPRESSION_ENABLED`.
   */
  compressOutput?: boolean;
  /** Optional overrides for the compression pass. */
  compressionConfig?: CompressionConfig;
  /**
   * When set, file-mutating tool calls (file_write / file_edit / file_delete)
   * record a reversible side effect against this run, so the whole run can be
   * undone later. The pre-image is captured before the tool runs; the effect is
   * recorded only after it succeeds. Best-effort — a recording failure is
   * surfaced to the silent-failure sink and never blocks the tool.
   */
  sideEffectRecorder?: SideEffectRecorder;
  /**
   * Chain of safety inspectors (repetition guard, egress detector, adversary
   * judge, ...) consulted between the permission gate and tool execution.
   * Borrowed from goose's `ToolInspectionManager`. `deny` halts the call;
   * `requireApproval` is surfaced via `onApprovalRequired` for the host to
   * decide. When the host does not wire `onApprovalRequired`, `requireApproval`
   * is treated as a soft pass (allowed), but the dropped decision is recorded
   * to the silent-failure sink so it stays post-hoc visible via diagnostics.
   */
  inspectors?: ToolInspectionManager;
  /** Context passed to inspectors (recent messages, session id, ...). */
  inspectorContext?: InspectorContext;
  /**
   * Called when an inspector requests human confirmation. Return `true` to
   * proceed, `false` to abort. If omitted, `requireApproval` is treated as
   * `allow` (matches goose's CLI when no confirmation channel is wired), and
   * the dropped decision is recorded to the silent-failure sink for visibility.
   */
  onApprovalRequired?: (info: {
    call: ToolCall;
    reason: string;
    warning?: string;
    inspectorName: string;
  }) => Promise<boolean>;
  /**
   * When set, tool responses larger than the threshold are spooled to a
   * temp file and replaced with a pointer message. Mirrors goose's
   * `large_response_handler`. Runs before `compressOutput`.
   */
  largeResponseConfig?: LargeResponseConfig;
  /**
   * When true, a tool call's input is checked against the tool's declared
   * parameter schema before execution. Only missing `required` parameters are
   * rejected (no type-checking, extra keys allowed); a violation returns a
   * correctable error result instead of executing on malformed input. Off by
   * default so the dispatch contract is unchanged unless a caller opts in.
   */
  validateInput?: boolean;
}

/**
 * Common hallucinated tool names mapped to their real builtin equivalents.
 * Live autonomy runs showed every cloud and local model occasionally calls
 * these names instead of the canonical ones; without aliasing, the model
 * burns turns on permission-denial loops trying \`search\`, \`edit\`, etc.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  search: 'grep',
  search_files: 'grep',
  ripgrep: 'grep',
  rg: 'grep',
  find: 'grep',
  read_file: 'file_read',
  read: 'file_read',
  cat: 'file_read',
  write_file: 'file_write',
  write: 'file_write',
  create_file: 'file_write',
  edit: 'file_edit',
  edit_file: 'file_edit',
  patch: 'file_edit',
  ls: 'list_files',
  list: 'list_files',
  list_dir: 'list_files',
  ls_dir: 'list_files',
  shell: 'bash',
  exec: 'bash',
  run: 'bash',
  run_command: 'bash',
  terminal: 'bash',
};

export class ToolDispatcher {
  private toolMap: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  /**
   * Resolve `requested` to a canonical tool name. If `requested` is already
   * a registered tool, returns it unchanged. If it matches a known alias
   * AND the alias target is registered, returns the canonical name.
   * Otherwise returns `requested` (caller will surface "unknown tool").
   */
  private resolveName(requested: string): string {
    if (this.toolMap.has(requested)) return requested;
    const aliased = TOOL_NAME_ALIASES[requested];
    if (aliased && this.toolMap.has(aliased)) return aliased;
    return requested;
  }

  async dispatch(
    calls: ToolCall[],
    permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
    onResult?: (result: DispatchResult) => void,
    options: DispatchOptions = {},
  ): Promise<DispatchResult[]> {
    const readOnly: ToolCall[] = [];
    const exclusive: ToolCall[] = [];

    for (const original of calls) {
      const canonical = this.resolveName(original.name);
      const call: ToolCall = canonical === original.name ? original : { ...original, name: canonical };
      const tool = this.toolMap.get(call.name);
      if (tool?.isReadOnly) {
        readOnly.push(call);
      } else {
        exclusive.push(call);
      }
    }

    const results: DispatchResult[] = [];

    // Read-only tools run in parallel
    if (readOnly.length > 0) {
      const parallel = await Promise.all(
        readOnly.map((call) => this.executeSingle(call, permissionCheck, options)),
      );
      for (const result of parallel) {
        results.push(result);
        onResult?.(result);
      }
    }

    // Exclusive tools run serially
    for (const call of exclusive) {
      const result = await this.executeSingle(call, permissionCheck, options);
      results.push(result);
      onResult?.(result);
    }

    return results;
  }

  private async executeSingle(
    call: ToolCall,
    permissionCheck?: (call: ToolCall) => Promise<{ allowed: boolean; reason?: string }>,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const dispatchSpan = options.tracer?.startSpan('tool.dispatch', { tool: call.name });
    if (options.hooks) {
      const hookSpan = options.tracer?.startSpan('hook.pre_tool_use', { tool: call.name });
      const hookResult = await options.hooks.execute({
        eventType: 'PreToolUse',
        toolName: call.name,
        toolInput: call.input,
      });
      hookSpan?.end('ok', { action: hookResult.action ?? 'continue' });
      if (hookResult.action === 'block') {
        dispatchSpan?.end('ok', { blockedByHook: true });
        return {
          call,
          result: {
            success: false,
            output: `Blocked by hook: ${hookResult.reason ?? 'no reason given'}`,
            error: hookResult.reason,
          },
        };
      }
      if (hookResult.modifiedInput) {
        call = { ...call, input: hookResult.modifiedInput };
      }
    }

    // Permission gate
    if (permissionCheck) {
      const permissionSpan = options.tracer?.startSpan('permission.check', { tool: call.name });
      const perm = await permissionCheck(call);
      permissionSpan?.end(perm.allowed ? 'ok' : 'error', { allowed: perm.allowed, reason: perm.reason });
      if (!perm.allowed) {
        dispatchSpan?.end('ok', { permissionDenied: true });
        return {
          call,
          result: {
            success: false,
            output: `Permission denied for '${call.name}': ${perm.reason ?? 'no matching allow rule'}`,
            error: perm.reason,
          },
        };
      }
    }

    // Safety inspectors (repetition guard, egress detector, adversary judge, ...)
    if (options.inspectors) {
      const inspectSpan = options.tracer?.startSpan('inspector.chain', { tool: call.name });
      const decision = await options.inspectors.decide(call, options.inspectorContext ?? {});
      inspectSpan?.end('ok', {
        action: decision.action.kind,
        inspector: decision.inspectorName,
      });
      if (decision.action.kind === 'deny') {
        dispatchSpan?.end('ok', { inspectorDenied: true, inspector: decision.inspectorName });
        return {
          call,
          result: {
            success: false,
            output: `Blocked by inspector '${decision.inspectorName}': ${decision.action.reason}`,
            error: decision.action.reason,
          },
        };
      }
      if (decision.action.kind === 'requireApproval' && !options.onApprovalRequired) {
        // No confirmation channel wired: the call is allowed to proceed
        // (matches goose's CLI), but record the dropped safety decision to the
        // silent-failure sink so it is post-hoc visible via diagnostics instead
        // of silently passing through. See audit finding F2.
        recordSwallowed(
          'dispatcher.inspector.requireApproval.dropped',
          `requireApproval not honored (no onApprovalRequired wired): ${decision.action.reason}`,
          { tool: call.name, inspector: decision.inspectorName, reason: decision.action.reason },
        );
      }
      if (decision.action.kind === 'requireApproval' && options.onApprovalRequired) {
        const approvalSpan = options.tracer?.startSpan('inspector.approval', { tool: call.name });
        let approved = false;
        try {
          approved = await options.onApprovalRequired({
            call,
            reason: decision.action.reason,
            warning: decision.action.warning,
            inspectorName: decision.inspectorName,
          });
        } catch (err) {
          recordSwallowed('dispatcher.inspector.approval', err);
        }
        approvalSpan?.end('ok', { approved });
        if (!approved) {
          dispatchSpan?.end('ok', { approvalDenied: true, inspector: decision.inspectorName });
          return {
            call,
            result: {
              success: false,
              output: `Inspector '${decision.inspectorName}' required approval but it was not granted: ${decision.action.reason}`,
              error: decision.action.reason,
            },
          };
        }
      }
    }

    // Lookup tool
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      dispatchSpan?.end('error', { missingTool: true });
      return {
        call,
        result: {
          success: false,
          output: `Unknown tool: '${call.name}'`,
          error: `Tool '${call.name}' not found in tool pool`,
        },
      };
    }

    // Inbound argument validation (after tool lookup, before execution).
    // Catches calls missing a declared-required parameter and returns a
    // correctable error so the loop can retry rather than executing on
    // malformed input.
    if (options.validateInput) {
      const validation = validateToolInput(tool, call.input);
      if (!validation.valid) {
        const reason = validation.errors.join(' ');
        dispatchSpan?.end('ok', { invalidInput: true });
        return {
          call,
          result: {
            success: false,
            output: `Invalid arguments for '${call.name}': ${reason}`,
            error: reason,
          },
        };
      }
    }

    // Read-before-write gate (after permission check, before execution)
    let pendingReadPath: string | undefined;
    if (options.readBeforeWriteGate) {
      const gateResult = options.readBeforeWriteGate.gateTool(call.name, call.input);
      if (!gateResult.allowed) {
        dispatchSpan?.end('ok', { blockedByReadBeforeWriteGate: true });
        return {
          call,
          result: {
            success: false,
            output: `Read-before-write gate blocked '${call.name}': ${gateResult.reason}`,
            error: gateResult.reason,
          },
        };
      }
      pendingReadPath = gateResult.pendingReadPath;
    }

    // Execute with error boundary
    try {
      const startTime = Date.now();
      const toolSpan = options.tracer?.startSpan('tool.execute', { tool: call.name });
      let commitSideEffect: (() => Promise<void>) | null = null;
      if (options.sideEffectRecorder) {
        try {
          commitSideEffect = await prepareSideEffectRecording(options.sideEffectRecorder, call.name, call.input);
        } catch (err) {
          recordSwallowed('dispatcher.sideEffectRecord.prepare', err);
        }
      }
      let result = await tool.execute(call.input);
      const durationMs = Date.now() - startTime;
      toolSpan?.end(result.success ? 'ok' : 'error', { durationMs, success: result.success });
      // Spool overly large responses to disk before they enter history.
      // Runs before compression so compression sees the pointer message.
      if (options.largeResponseConfig) {
        const outcome = maybeSpoolLargeResponse(call.name, result, options.largeResponseConfig);
        if (outcome.spooled) {
          options.tracer
            ?.startSpan('tool.spool', { tool: call.name })
            ?.end('ok', { originalChars: outcome.originalChars, spoolPath: outcome.spoolPath });
        }
        result = outcome.result;
      }
      // Compress verbose output at the boundary, before it enters history.
      if (options.compressOutput) {
        const compressed = compressToolResult(call.name, result, options.compressionConfig);
        if (compressed.saved > 0) {
          options.tracer?.startSpan('tool.compress', { tool: call.name })?.end('ok', { saved: compressed.saved });
          result = compressed.result;
        }
      }
      // Confirm deferred read after successful execution
      if (result.success && pendingReadPath && options.readBeforeWriteGate) {
        options.readBeforeWriteGate.confirmRead(pendingReadPath);
      }
      // Record the reversible side effect once the mutation actually succeeded.
      if (result.success && commitSideEffect) {
        try {
          await commitSideEffect();
        } catch (err) {
          recordSwallowed('dispatcher.sideEffectRecord.commit', err);
        }
      }
      if (options.trackUsage) {
        const recorder = options.learningRecorder;
        try {
          const p = recorder ? recorder.trackToolUsage(call.name, call.input, result.success, durationMs) : trackToolUsage(call.name, call.input, result.success, durationMs);
          Promise.resolve(p).catch((err) => recordSwallowed('dispatcher.trackToolUsage.success', err));
        } catch (err) { recordSwallowed('dispatcher.trackToolUsage.success.sync', err); }
      }
      if (options.hooks) {
        const postHookSpan = options.tracer?.startSpan('hook.post_tool_use', { tool: call.name });
        const postHook = await options.hooks.execute({
          eventType: 'PostToolUse',
          toolName: call.name,
          toolInput: call.input,
          toolOutput: result.output,
        });
        postHookSpan?.end('ok', { modifiedOutput: Boolean(postHook.modifiedOutput) });
        if (postHook.modifiedOutput) {
          dispatchSpan?.end(result.success ? 'ok' : 'error', { outputModified: true, success: result.success });
          return { call, result: { ...result, output: postHook.modifiedOutput } };
        }
      }
      dispatchSpan?.end(result.success ? 'ok' : 'error', { success: result.success });
      return { call, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      // Surface the retry class on a dedicated annotation span so callers
      // (UI, telemetry, schedulers) can distinguish transient blips from
      // auth/policy failures without parsing error strings.
      options.tracer
        ?.startSpan('tool.failure.classified', { tool: call.name })
        ?.end('ok', {
          retryClass: classified.class,
          reason: classified.reason,
          ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
        });
      dispatchSpan?.fail(error);
      if (options.trackUsage) {
        const recorder = options.learningRecorder;
        try {
          const p = recorder ? recorder.trackToolUsage(call.name, call.input, false) : trackToolUsage(call.name, call.input, false);
          Promise.resolve(p).catch((err) => recordSwallowed('dispatcher.trackToolUsage.failure', err));
        } catch (err) { recordSwallowed('dispatcher.trackToolUsage.failure.sync', err); }
      }
      if (options.hooks) {
        const failureHookSpan = options.tracer?.startSpan('hook.post_tool_use_failure', { tool: call.name });
        await options.hooks.execute({
          eventType: 'PostToolUseFailure',
          toolName: call.name,
          toolInput: call.input,
          error: msg,
        });
        failureHookSpan?.end('ok');
      }
      return {
        call,
        result: {
          success: false,
          output: `Tool '${call.name}' threw: ${msg}`,
          error: msg,
        },
      };
    }
  }

  getToolNames(): string[] {
    return Array.from(this.toolMap.keys());
  }

  hasToolWithName(name: string): boolean {
    return this.toolMap.has(name);
  }
}
