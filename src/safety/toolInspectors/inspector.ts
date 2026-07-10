import type { ToolCall } from '../../types';

/**
 * Action a `ToolInspector` requests the dispatcher to take for a tool call.
 *
 * - `allow`           — proceed normally
 * - `deny`            — refuse execution with `reason`
 * - `requireApproval` — bounce up for confirmation (UI hook; honoured by
 *                       callers that wire approval into their permission
 *                       check, e.g. server.ts).
 *
 * Borrowed from goose's `crates/goose/src/tool_inspection.rs` (`InspectionAction`).
 * The shape is intentionally TS-idiomatic discriminated union, not the
 * Rust enum-with-payload form.
 */
export type InspectionAction =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'requireApproval'; reason: string; warning?: string };

export interface InspectionResult {
  toolName: string;
  inspectorName: string;
  action: InspectionAction;
  /** 0..1, inspector-specific. Used by the manager to break ties. */
  confidence: number;
  /** Optional short identifier for traceability (e.g. "REP-001"). */
  findingId?: string;
}

/** Optional context an inspector may read but never mutate. */
export interface InspectorContext {
  /** Recent conversation messages, oldest first. May be omitted. */
  recentMessages?: Array<{ role: string; content: string }>;
  sessionId?: string;
}

export interface ToolInspector {
  readonly name: string;
  isEnabled(): boolean;
  /**
   * Inspect a single tool call. Return `null` to mean "no opinion" (treated
   * as `allow`). Inspectors must be safe to call concurrently; any internal
   * state must be guarded by the implementation.
   */
  inspect(call: ToolCall, context: InspectorContext): Promise<InspectionResult | null>;
}

/**
 * Coordinates a chain of `ToolInspector`s.
 *
 * Conflict resolution (highest-severity wins):
 *   deny > requireApproval > allow
 *
 * If multiple inspectors deny, the first deny is returned (deterministic
 * ordering preserves debugging signal). Inspector failures never block
 * the call — they are dropped and the chain continues, matching goose's
 * fail-open posture in `ToolInspectionManager::inspect_tools`.
 */
export class ToolInspectionManager {
  private readonly inspectors: ToolInspector[] = [];

  add(inspector: ToolInspector): this {
    this.inspectors.push(inspector);
    return this;
  }

  list(): readonly ToolInspector[] {
    return this.inspectors;
  }

  async decide(call: ToolCall, context: InspectorContext): Promise<InspectionResult> {
    let strongest: InspectionResult = {
      toolName: call.name,
      inspectorName: 'default',
      action: { kind: 'allow' },
      confidence: 0,
    };

    for (const inspector of this.inspectors) {
      if (!inspector.isEnabled()) continue;
      let result: InspectionResult | null = null;
      try {
        result = await inspector.inspect(call, context);
      } catch {
        // Fail-open per goose: a broken inspector must not block tools.
        continue;
      }
      if (!result) continue;
      strongest = mergeStrongest(strongest, result);
    }

    return strongest;
  }
}

function actionRank(action: InspectionAction): number {
  switch (action.kind) {
    case 'deny':
      return 2;
    case 'requireApproval':
      return 1;
    case 'allow':
      return 0;
  }
}

function mergeStrongest(current: InspectionResult, candidate: InspectionResult): InspectionResult {
  const c = actionRank(current.action);
  const n = actionRank(candidate.action);
  if (n > c) return candidate;
  return current;
}
