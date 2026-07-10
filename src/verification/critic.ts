// Surgical critic. War_loops' insight: a generic "fix everything" remediation
// prompt makes the agent churn across already-passing components. Instead,
// rank failing signals by `weight × (target − score)` and focus repair on the
// top N, with an explicit "do not touch the rest" instruction. The signals
// that already pass are listed so the agent knows what NOT to break.

import type { PanelResult, PerSignalReport } from './panel';

export interface SurgicalRepairOptions {
  /** Max number of signals to focus repair on. Default 3. */
  maxFocus?: number;
}

export interface SurgicalRepairPlan {
  /** Ordered list (worst first) of signals to focus on. */
  focusSignals: string[];
  /** Signals at-or-above target — the explicit do-not-touch list. */
  leaveAlone: string[];
  /** A prompt fragment ready to be appended to a remediation step. */
  prompt: string;
}

export function planSurgicalRepair(panel: PanelResult, opts: SurgicalRepairOptions = {}): SurgicalRepairPlan {
  const maxFocus = opts.maxFocus ?? 3;
  const entries = Object.entries(panel.perSignal);

  const failing: Array<{ name: string; report: PerSignalReport; impact: number; target: number }> = [];
  const passing: string[] = [];
  for (const [name, report] of entries) {
    if (report.abstain) continue;
    const target = panel.perAxis[report.axis]?.target ?? 70;
    if (report.score >= target) {
      passing.push(name);
      continue;
    }
    const impact = report.weight * (target - report.score);
    failing.push({ name, report, impact, target });
  }
  failing.sort((a, b) => b.impact - a.impact);
  const focus = failing.slice(0, maxFocus);
  const focusSignals = focus.map((f) => f.name);

  const prompt = composePrompt(focus, passing);
  return { focusSignals, leaveAlone: passing, prompt };
}

function composePrompt(
  focus: Array<{ name: string; report: PerSignalReport; target: number }>,
  passing: string[],
): string {
  if (focus.length === 0) {
    return 'All verification signals are at or above target. No surgical repair needed.';
  }
  const lines: string[] = [];
  lines.push('Surgical repair plan. Fix ONLY the signals below; do not touch anything else.');
  lines.push('');
  lines.push('Focus signals:');
  for (const f of focus) {
    const findings = f.report.findings.length > 0 ? ` — ${f.report.findings.join(' ')}` : '';
    lines.push(`- ${f.name} (axis: ${f.report.axis}, score ${f.report.score.toFixed(0)}/${f.target.toFixed(0)})${findings}`);
  }
  if (passing.length > 0) {
    lines.push('');
    lines.push('Already passing — leave these untouched:');
    lines.push(`- ${passing.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Duck-typed check shape so this module stays a leaf — anything with
 * `name + status + optional detail` qualifies, including
 * `VerificationCheck` from `doneStateVerifier`.
 */
export interface RepairableCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail?: string;
}

/**
 * Sibling of `planSurgicalRepair` for callers (e.g. taskConductor) that have
 * a list of pass/fail checks rather than a full signal panel. Same output
 * shape: focus on failing checks, list the passing ones explicitly so the
 * agent knows what NOT to touch.
 */
export function planSurgicalRepairForChecks(
  checks: RepairableCheck[],
  opts: SurgicalRepairOptions = {},
): SurgicalRepairPlan {
  const maxFocus = opts.maxFocus ?? 3;
  const failing = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const passing = checks.filter((c) => c.status === 'pass').map((c) => c.name);
  const focusChecks = [...failing, ...warns].slice(0, maxFocus);

  if (focusChecks.length === 0) {
    return {
      focusSignals: [],
      leaveAlone: passing,
      prompt: 'All verification checks passed. No surgical repair needed.',
    };
  }

  const lines: string[] = [];
  lines.push('Surgical repair plan. Fix ONLY the checks below; do not touch anything else.');
  lines.push('');
  lines.push('Failing checks:');
  for (const c of focusChecks) {
    const detail = c.detail ? ` — ${truncate(c.detail, 400)}` : '';
    lines.push(`- ${c.name} (${c.status})${detail}`);
  }
  if (passing.length > 0) {
    lines.push('');
    lines.push('Already passing — leave these untouched:');
    lines.push(`- ${passing.join(', ')}`);
  }
  return {
    focusSignals: focusChecks.map((c) => c.name),
    leaveAlone: passing,
    prompt: lines.join('\n'),
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
