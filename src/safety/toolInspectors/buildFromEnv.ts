import { ToolInspectionManager } from './inspector';
import { RepetitionInspector } from './repetitionInspector';
import { EgressInspector, type EgressInspectorOptions } from './egressInspector';
import { AdversaryInspector, type AdversaryJudge } from './adversaryInspector';
import type { LargeResponseConfig } from '../../tools/largeResponseHandler';

/**
 * Env-driven defaults for the Tier-1 inspector chain. Mirrors the
 * `HARNESS_TOOL_COMPRESSION_ENABLED` pattern used elsewhere in queryLoop —
 * one knob per inspector, all off by default. Caller can still construct
 * a manager by hand and pass it through DispatchOptions for tests or
 * non-default wiring.
 */
export interface BuildInspectorsResult {
  /** Undefined when no inspector env knob is enabled, so the dispatcher
   * can skip the inspection chain entirely instead of running an empty one. */
  manager: ToolInspectionManager | undefined;
  /** Undefined when HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD is unset; lets the
   * dispatcher skip spool work when the feature is off. */
  largeResponseConfig: LargeResponseConfig | undefined;
}

export interface BuildInspectorsOptions {
  projectDir?: string;
  /** Optional LLM-graded judge for AdversaryInspector. Not constructed
   * here because the inspector module deliberately has no provider deps;
   * callers wire it from chat-client land if they want LLM grading. */
  adversaryJudge?: AdversaryJudge;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function buildInspectorsFromEnv(opts: BuildInspectorsOptions = {}): BuildInspectorsResult {
  const manager = new ToolInspectionManager();
  let registered = 0;

  const repMax = process.env.HARNESS_INSPECTOR_REPETITION_MAX;
  if (repMax) {
    const n = Number(repMax);
    if (Number.isFinite(n) && n > 0) {
      manager.add(new RepetitionInspector(n));
      registered += 1;
    }
  }

  const egressMode = process.env.HARNESS_INSPECTOR_EGRESS;
  if (egressMode === 'approve' || egressMode === 'deny') {
    const egressOpts: EgressInspectorOptions = {
      blockInsteadOfApprove: egressMode === 'deny',
      allowDomains: parseCsv(process.env.HARNESS_INSPECTOR_EGRESS_ALLOW),
      shellToolNames: parseCsv(process.env.HARNESS_INSPECTOR_EGRESS_TOOLS),
    };
    manager.add(new EgressInspector(egressOpts));
    registered += 1;
  }

  if (process.env.HARNESS_INSPECTOR_ADVERSARY === '1') {
    manager.add(
      new AdversaryInspector({
        projectDir: opts.projectDir,
        judge: opts.adversaryJudge,
      }),
    );
    registered += 1;
  }

  const spoolThreshold = process.env.HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD;
  let largeResponseConfig: LargeResponseConfig | undefined;
  if (spoolThreshold) {
    const n = Number(spoolThreshold);
    if (Number.isFinite(n) && n > 0) {
      largeResponseConfig = { thresholdChars: n };
    }
  }

  return {
    manager: registered > 0 ? manager : undefined,
    largeResponseConfig,
  };
}
