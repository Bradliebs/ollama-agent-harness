import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildInspectorsFromEnv } from './buildFromEnv';
import { RepetitionInspector } from './repetitionInspector';
import { EgressInspector } from './egressInspector';
import { AdversaryInspector } from './adversaryInspector';

const KEYS = [
  'HARNESS_INSPECTOR_REPETITION_MAX',
  'HARNESS_INSPECTOR_EGRESS',
  'HARNESS_INSPECTOR_EGRESS_ALLOW',
  'HARNESS_INSPECTOR_EGRESS_TOOLS',
  'HARNESS_INSPECTOR_ADVERSARY',
  'HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD',
];

describe('buildInspectorsFromEnv', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns no manager when no env knobs set', () => {
    const out = buildInspectorsFromEnv();
    expect(out.manager).toBeUndefined();
    expect(out.largeResponseConfig).toBeUndefined();
  });

  it('ignores invalid numeric values silently', () => {
    process.env.HARNESS_INSPECTOR_REPETITION_MAX = 'not-a-number';
    process.env.HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD = '0';
    const out = buildInspectorsFromEnv();
    expect(out.manager).toBeUndefined();
    expect(out.largeResponseConfig).toBeUndefined();
  });

  it('registers RepetitionInspector with valid threshold', () => {
    process.env.HARNESS_INSPECTOR_REPETITION_MAX = '3';
    const out = buildInspectorsFromEnv();
    expect(out.manager).toBeDefined();
    const list = out.manager!.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toBeInstanceOf(RepetitionInspector);
  });

  it('registers EgressInspector in approve mode', () => {
    process.env.HARNESS_INSPECTOR_EGRESS = 'approve';
    process.env.HARNESS_INSPECTOR_EGRESS_ALLOW = 'github.com, npmjs.org';
    const out = buildInspectorsFromEnv();
    expect(out.manager).toBeDefined();
    const list = out.manager!.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toBeInstanceOf(EgressInspector);
  });

  it('skips EgressInspector when mode is invalid', () => {
    process.env.HARNESS_INSPECTOR_EGRESS = 'maybe';
    const out = buildInspectorsFromEnv();
    expect(out.manager).toBeUndefined();
  });

  it('registers AdversaryInspector when enabled', () => {
    process.env.HARNESS_INSPECTOR_ADVERSARY = '1';
    const out = buildInspectorsFromEnv({ projectDir: '/tmp/none' });
    expect(out.manager).toBeDefined();
    const list = out.manager!.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toBeInstanceOf(AdversaryInspector);
  });

  it('emits largeResponseConfig with threshold', () => {
    process.env.HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD = '50000';
    const out = buildInspectorsFromEnv();
    expect(out.largeResponseConfig).toEqual({ thresholdChars: 50000 });
  });

  it('stacks all inspectors when every knob is set', () => {
    process.env.HARNESS_INSPECTOR_REPETITION_MAX = '5';
    process.env.HARNESS_INSPECTOR_EGRESS = 'deny';
    process.env.HARNESS_INSPECTOR_ADVERSARY = '1';
    process.env.HARNESS_TOOL_RESPONSE_SPOOL_THRESHOLD = '100000';
    const out = buildInspectorsFromEnv();
    expect(out.manager!.list()).toHaveLength(3);
    expect(out.largeResponseConfig?.thresholdChars).toBe(100000);
  });
});
