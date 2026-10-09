import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveContextMaxTokens, resolveEffectiveContextMaxTokensFromKnown } from './contextWindow';

describe('context window resolution', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-window-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('uses the reported window in auto mode, capped at 200k, and 8192 when unknown', () => {
    expect(resolveEffectiveContextMaxTokensFromKnown(0, 32_768)).toBe(32_768);
    expect(resolveEffectiveContextMaxTokensFromKnown(8192, 262_144)).toBe(200_000);
    expect(resolveEffectiveContextMaxTokensFromKnown(0, null)).toBe(8192);
    expect(resolveEffectiveContextMaxTokensFromKnown(16_000, 32_768)).toBe(16_000);
  });

  it('reads the global cap from settings.json and lets a per-model cap win', async () => {
    fs.mkdirSync(path.join(projectDir, '.harness'), { recursive: true });
    expect(await resolveContextMaxTokens(projectDir, 'qwen3:8b', 40_960)).toBe(40_960);

    fs.writeFileSync(path.join(projectDir, '.harness', 'settings.json'), JSON.stringify({ contextMaxTokens: 16_000 }));
    expect(await resolveContextMaxTokens(projectDir, 'qwen3:8b', 40_960)).toBe(16_000);

    fs.writeFileSync(path.join(projectDir, '.harness', 'model-profiles.json'), JSON.stringify({ profiles: { 'qwen3:8b': { contextMaxTokens: 24_000 } } }));
    expect(await resolveContextMaxTokens(projectDir, 'qwen3:8b', 40_960)).toBe(24_000);
  });
});
