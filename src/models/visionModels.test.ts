import { findInstalledVisionModel, isVisionCapableModelName } from './visionModels';

describe('vision model detection', () => {
  it('detects Minimax M3 as vision-capable', () => {
    expect(isVisionCapableModelName('minimax-m3:cloud')).toBe(true);
    expect(isVisionCapableModelName('MiniMax_M3')).toBe(true);
  });

  it('can choose Minimax M3 as an installed vision model', () => {
    expect(findInstalledVisionModel(['qwen2.5-coder:7b', 'minimax-m3:cloud'])).toBe('minimax-m3:cloud');
  });
});