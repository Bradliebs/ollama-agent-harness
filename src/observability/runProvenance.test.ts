import type { EvidenceCard } from '../types/evidence';
import { buildRunProvenance } from './runProvenance';

function card(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    id: 'run-1',
    kind: 'chat',
    mode: 'general',
    createdAt: '2026-06-04T10:00:00.000Z',
    request: 'do the thing',
    model: 'qwen2.5-coder',
    tools: [],
    files: [],
    commands: [],
    artifacts: [],
    ...overrides,
  };
}

describe('buildRunProvenance — model and time', () => {
  it('records the model and timestamp from the card', () => {
    const p = buildRunProvenance(card({ model: 'llama3.1', createdAt: '2026-06-04T12:00:00.000Z' }));
    expect(p.model).toBe('llama3.1');
    expect(p.recordedAt).toBe('2026-06-04T12:00:00.000Z');
    expect(p.runId).toBe('run-1');
  });

  it('reports null model rather than fabricating one when unrecorded', () => {
    const p = buildRunProvenance(card({ model: undefined }));
    expect(p.model).toBeNull();
    expect(p.complete).toBe(false);
  });

  it('reports null recordedAt when the timestamp is blank', () => {
    const p = buildRunProvenance(card({ createdAt: '   ' }));
    expect(p.recordedAt).toBeNull();
    expect(p.complete).toBe(false);
  });
});

describe('buildRunProvenance — sources', () => {
  it('marks a tool proven only when it succeeded', () => {
    const p = buildRunProvenance(card({
      tools: [
        { name: 'web_fetch', success: true },
        { name: 'pdf_read', success: false },
      ],
    }));
    expect(p.sources).toEqual([
      { kind: 'tool', label: 'web_fetch', proven: true },
      { kind: 'tool', label: 'pdf_read', proven: false },
    ]);
  });

  it('marks a command proven only when success is a definite true', () => {
    const p = buildRunProvenance(card({
      commands: [
        { command: 'npm test', success: true },
        { command: 'npm run lint' },
      ],
    }));
    expect(p.sources).toEqual([
      { kind: 'command', label: 'npm test', proven: true },
      { kind: 'command', label: 'npm run lint', proven: false },
    ]);
  });

  it('does not claim a file with an unknown action as proven', () => {
    const p = buildRunProvenance(card({
      files: [
        { path: 'a.ts', action: 'write' },
        { path: 'b.ts', action: 'unknown' },
      ],
    }));
    expect(p.sources).toEqual([
      { kind: 'file', label: 'a.ts', proven: true },
      { kind: 'file', label: 'b.ts', proven: false },
    ]);
  });

  it('lists sources in tool→command→file order without deduplicating repeats', () => {
    const p = buildRunProvenance(card({
      tools: [{ name: 'web_fetch', success: true }, { name: 'web_fetch', success: false }],
      commands: [{ command: 'npm test', success: true }],
      files: [{ path: 'a.ts', action: 'edit' }],
    }));
    expect(p.sources.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'tool:web_fetch',
      'tool:web_fetch',
      'command:npm test',
      'file:a.ts',
    ]);
  });
});

describe('buildRunProvenance — completeness and reason', () => {
  it('is complete when both model and time are present', () => {
    const p = buildRunProvenance(card());
    expect(p.complete).toBe(true);
    expect(p.reason).toMatch(/^Provenance complete:/);
  });

  it('reports the proven source count in the reason', () => {
    const p = buildRunProvenance(card({
      tools: [{ name: 'web_fetch', success: true }, { name: 'pdf_read', success: false }],
    }));
    expect(p.reason).toContain('2 sources (1 proven)');
  });

  it('passes through artifacts the run produced', () => {
    const p = buildRunProvenance(card({
      artifacts: [{ title: 'report.md', kind: 'document' }],
    }));
    expect(p.artifacts).toEqual([{ title: 'report.md', kind: 'document' }]);
  });
});
