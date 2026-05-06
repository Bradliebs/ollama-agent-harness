// Prometheus exposition-format text writer.
//
// Pure formatting — no I/O. The HTTP layer in `web/server.ts` collects
// the live metric values and hands them to `formatPrometheusMetrics`.
// Avoids `prom-client` to keep the harness's "no new runtime deps"
// posture intact; we only emit the subset of types the harness uses
// (counters and gauges).

export type PrometheusMetricType = 'counter' | 'gauge';

export interface PrometheusMetric {
  name: string;
  help: string;
  type: PrometheusMetricType;
  /** Each sample row in this metric. Labels are optional and rendered as `{key="value",...}`. */
  samples: Array<{
    value: number;
    labels?: Record<string, string>;
  }>;
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(help: string): string {
  return String(help ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const pairs: string[] = [];
  for (const [key, raw] of Object.entries(labels)) {
    if (!LABEL_NAME_RE.test(key)) continue;
    pairs.push(`${key}="${escapeLabelValue(raw)}"`);
  }
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // Integer-friendly formatting; preserves precision for non-integers.
  return Number.isInteger(value) ? value.toString() : value.toString();
}

/**
 * Render a list of metrics into Prometheus exposition format. Invalid
 * metric names are skipped silently; invalid labels are dropped.
 */
export function formatPrometheusMetrics(metrics: PrometheusMetric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    if (!METRIC_NAME_RE.test(metric.name)) continue;
    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      lines.push(`${metric.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
    }
  }
  // Prometheus requires a trailing newline.
  return lines.join('\n') + '\n';
}
