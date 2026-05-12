import { createSignal } from '../nervous/signals';
import { defaultAmbientActionPolicy } from './ambientActions';

describe('ambient action policy', () => {
  it('emits kg_ingest_file for file change signals', () => {
    const sig = createSignal('USER_INTENT', 'ambient.file', 'low', 'changed');
    sig.metadata = { files: ['a.ts', 'b.ts'] };
    const actions = defaultAmbientActionPolicy.evaluate([sig]);
    expect(actions[0].kind).toBe('kg_ingest_file');
    expect((actions[0].payload?.files as string[]).length).toBe(2);
  });

  it('skips file changes with no payload', () => {
    const sig = createSignal('USER_INTENT', 'ambient.file', 'low', 'no files');
    expect(defaultAmbientActionPolicy.evaluate([sig])).toEqual([]);
  });

  it('emits save_brief on git dirty → clean transition', () => {
    const dirty = createSignal('USER_INTENT', 'ambient.git', 'low', 'dirty');
    const clean = createSignal('TOOL_SUCCESS', 'ambient.git', 'low', 'clean');
    const actions = defaultAmbientActionPolicy.evaluate([dirty, clean]);
    expect(actions.some((a) => a.kind === 'save_brief')).toBe(true);
  });

  it('does nothing for unrelated signals', () => {
    const sig = createSignal('USER_INTENT', 'ambient.scheduler', 'info', 'tick');
    expect(defaultAmbientActionPolicy.evaluate([sig])).toEqual([]);
  });
});
