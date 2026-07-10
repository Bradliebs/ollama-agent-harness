import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  recordSideEffect,
  listSideEffects,
  markSideEffectReversed,
  planRunReversal,
  type SideEffect,
} from './sideEffectLedger';

describe('sideEffectLedger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sidefx-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('records a side effect and lists it back', async () => {
    const fx = await recordSideEffect(tmpDir, {
      runId: 'run-1',
      kind: 'file_create',
      description: 'wrote src/new.ts',
      reversal: { kind: 'delete_file', path: 'src/new.ts' },
    });
    expect(fx.id).toBeTruthy();
    expect(fx.reversed).toBe(false);
    expect(fx.performedAt).toBeTruthy();

    const all = await listSideEffects(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('wrote src/new.ts');
  });

  it('returns an empty list when nothing has been recorded', async () => {
    expect(await listSideEffects(tmpDir)).toEqual([]);
  });

  it('filters by runId and lists chronologically', async () => {
    await recordSideEffect(tmpDir, { runId: 'run-1', kind: 'other', description: 'a', reversal: { kind: 'irreversible', reason: 'x' } });
    await recordSideEffect(tmpDir, { runId: 'run-2', kind: 'other', description: 'b', reversal: { kind: 'irreversible', reason: 'x' } });
    await recordSideEffect(tmpDir, { runId: 'run-1', kind: 'other', description: 'c', reversal: { kind: 'irreversible', reason: 'x' } });

    const run1 = await listSideEffects(tmpDir, 'run-1');
    expect(run1.map((e) => e.description)).toEqual(['a', 'c']);
  });

  it('marks an effect reversed (last write wins, no duplicate row in state)', async () => {
    const fx = await recordSideEffect(tmpDir, {
      runId: 'run-1', kind: 'file_modify', description: 'edited f',
      reversal: { kind: 'restore_file', path: 'f', previousContent: 'old' },
    });
    const updated = await markSideEffectReversed(tmpDir, fx.id, new Date('2026-06-03T00:00:00.000Z'));
    expect(updated?.reversed).toBe(true);
    expect(updated?.reversedAt).toBe('2026-06-03T00:00:00.000Z');

    const all = await listSideEffects(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].reversed).toBe(true);
  });

  it('returns null when marking an unknown effect reversed', async () => {
    expect(await markSideEffectReversed(tmpDir, 'nope')).toBeNull();
  });
});

describe('planRunReversal (pure)', () => {
  function effect(partial: Partial<SideEffect> & Pick<SideEffect, 'reversal'>): SideEffect {
    return {
      id: partial.id ?? Math.random().toString(36).slice(2),
      runId: partial.runId ?? 'run-1',
      kind: partial.kind ?? 'other',
      description: partial.description ?? '',
      reversal: partial.reversal,
      reversed: partial.reversed ?? false,
      performedAt: partial.performedAt ?? '2026-06-03T00:00:00.000Z',
    };
  }

  it('orders reversible effects most-recent-first so create→modify unwinds correctly', () => {
    const create = effect({ id: 'c', description: 'create', performedAt: '2026-06-03T00:00:01.000Z', reversal: { kind: 'delete_file', path: 'f' } });
    const modify = effect({ id: 'm', description: 'modify', performedAt: '2026-06-03T00:00:02.000Z', reversal: { kind: 'restore_file', path: 'f', previousContent: 'old' } });
    const plan = planRunReversal('run-1', [create, modify]);
    expect(plan.toReverse.map((e) => e.id)).toEqual(['m', 'c']);
    expect(plan.irreversible).toEqual([]);
    expect(plan.alreadyReversed).toEqual([]);
  });

  it('separates irreversible effects instead of dropping them', () => {
    const write = effect({ id: 'w', reversal: { kind: 'delete_file', path: 'f' } });
    const sent = effect({ id: 's', kind: 'notification', reversal: { kind: 'irreversible', reason: 'message already sent' } });
    const plan = planRunReversal('run-1', [write, sent]);
    expect(plan.toReverse.map((e) => e.id)).toEqual(['w']);
    expect(plan.irreversible.map((e) => e.id)).toEqual(['s']);
  });

  it('leaves already-reversed effects out of the to-do work', () => {
    const done = effect({ id: 'd', reversed: true, reversal: { kind: 'delete_file', path: 'f' } });
    const pending = effect({ id: 'p', reversal: { kind: 'delete_file', path: 'g' } });
    const plan = planRunReversal('run-1', [done, pending]);
    expect(plan.toReverse.map((e) => e.id)).toEqual(['p']);
    expect(plan.alreadyReversed.map((e) => e.id)).toEqual(['d']);
  });

  it('scopes the plan to the requested run', () => {
    const a = effect({ id: 'a', runId: 'run-1', reversal: { kind: 'delete_file', path: 'f' } });
    const b = effect({ id: 'b', runId: 'run-2', reversal: { kind: 'delete_file', path: 'g' } });
    const plan = planRunReversal('run-1', [a, b]);
    expect(plan.toReverse.map((e) => e.id)).toEqual(['a']);
  });
});
