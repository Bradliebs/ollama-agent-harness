import { formatPrometheusMetrics, type PrometheusMetric } from './prometheus';

describe('observability/prometheus', () => {
  it('renders counter and gauge metrics with HELP and TYPE lines', () => {
    const metrics: PrometheusMetric[] = [
      {
        name: 'harness_tool_calls_total',
        help: 'Total tool calls observed',
        type: 'counter',
        samples: [
          { value: 17, labels: { tool: 'bash', status: 'success' } },
          { value: 3, labels: { tool: 'bash', status: 'error' } },
        ],
      },
      {
        name: 'harness_active_subagents',
        help: 'Currently running sub-agents',
        type: 'gauge',
        samples: [{ value: 2 }],
      },
    ];
    const text = formatPrometheusMetrics(metrics);
    expect(text).toContain('# HELP harness_tool_calls_total Total tool calls observed');
    expect(text).toContain('# TYPE harness_tool_calls_total counter');
    expect(text).toContain('harness_tool_calls_total{tool="bash",status="success"} 17');
    expect(text).toContain('# TYPE harness_active_subagents gauge');
    expect(text).toContain('harness_active_subagents 2');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes special characters in label values and help text', () => {
    const text = formatPrometheusMetrics([{
      name: 'sample',
      help: 'has "quotes" and \\ slash and\nnewline',
      type: 'gauge',
      samples: [{ value: 1, labels: { msg: 'a "quoted" \\ value\nline' } }],
    }]);
    expect(text).toContain('# HELP sample has "quotes" and \\\\ slash and\\nnewline');
    expect(text).toContain('sample{msg="a \\"quoted\\" \\\\ value\\nline"} 1');
  });

  it('skips invalid metric names and invalid label keys', () => {
    const text = formatPrometheusMetrics([{
      name: 'bad-name', // hyphen invalid
      help: 'should not appear',
      type: 'gauge',
      samples: [{ value: 1 }],
    }, {
      name: 'good_name',
      help: 'ok',
      type: 'gauge',
      samples: [{ value: 5, labels: { 'bad-key': 'x', good_key: 'y' } }],
    }]);
    expect(text).not.toContain('bad-name');
    expect(text).toContain('good_name{good_key="y"} 5');
    expect(text).not.toContain('bad-key');
  });

  it('formats integer and float values without locale issues', () => {
    const text = formatPrometheusMetrics([{
      name: 'ratio',
      help: 'ratio',
      type: 'gauge',
      samples: [{ value: 0.5 }, { value: 1 }, { value: NaN }],
    }]);
    expect(text).toContain('ratio 0.5');
    expect(text).toContain('ratio 1');
    expect(text).toContain('ratio 0'); // NaN coerced to 0
  });
});
