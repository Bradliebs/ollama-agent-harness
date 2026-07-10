import type { ToolCall } from '../../types';
import type { InspectionResult, InspectorContext, ToolInspector } from './inspector';

/**
 * Blocks an agent that calls the same tool with the same arguments more than
 * `maxRepetitions` times in a row. The classic "stuck in a loop" failure mode.
 *
 * Borrowed from goose's `crates/goose/src/tool_monitor.rs` (`RepetitionInspector`).
 * Behavioural parity:
 * - Comparison is by `(name, JSON-serialised input)`.
 * - The counter resets the moment a different call appears.
 * - `maxRepetitions = undefined` disables the check (always allow).
 *
 * Stateful: one instance per agent/session. Not concurrency-safe — assumes
 * the dispatcher serialises calls into `recordAndCheck`.
 */
export class RepetitionInspector implements ToolInspector {
  public readonly name = 'repetition';
  private maxRepetitions: number | undefined;
  private lastSignature: string | undefined;
  private repeatCount = 0;

  /**
   * @param maxRepetitions max identical-call streak before deny. `undefined`
   * disables the inspector. Caller chooses the default — there is none here
   * by design, matching goose's `Option<u32>` model.
   */
  constructor(maxRepetitions: number | undefined) {
    this.maxRepetitions = maxRepetitions;
  }

  isEnabled(): boolean {
    return this.maxRepetitions !== undefined && this.maxRepetitions > 0;
  }

  /** Hard reset of the streak (e.g. on retry / new turn). */
  reset(): void {
    this.lastSignature = undefined;
    this.repeatCount = 0;
  }

  async inspect(call: ToolCall, _context: InspectorContext): Promise<InspectionResult | null> {
    if (!this.isEnabled()) return null;

    const signature = `${call.name}::${stableStringify(call.input)}`;
    if (this.lastSignature === signature) {
      this.repeatCount += 1;
    } else {
      this.lastSignature = signature;
      this.repeatCount = 1;
    }

    if (this.repeatCount > (this.maxRepetitions as number)) {
      return {
        toolName: call.name,
        inspectorName: this.name,
        findingId: 'REP-001',
        confidence: 1.0,
        action: {
          kind: 'deny',
          reason: `Tool '${call.name}' called ${this.repeatCount} times in a row with identical arguments (max ${this.maxRepetitions}). Likely stuck in a loop.`,
        },
      };
    }

    return null;
  }
}

/** Order-stable JSON for deterministic signatures. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
