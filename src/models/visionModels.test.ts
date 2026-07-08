import { findInstalledVisionModel, isVisionCapableModelName, isCloudModelName, isVisionModelUsable } from './visionModels';

describe('vision model detection', () => {
  it('detects Minimax M3 as vision-capable', () => {
    expect(isVisionCapableModelName('minimax-m3:cloud')).toBe(true);
    expect(isVisionCapableModelName('MiniMax_M3')).toBe(true);
  });

  it('detects GLM "V" vision variants as vision-capable', () => {
    expect(isVisionCapableModelName('glm-4v')).toBe(true);
    expect(isVisionCapableModelName('glm-4.1v')).toBe(true);
    expect(isVisionCapableModelName('glm-4.5v')).toBe(true);
    expect(isVisionCapableModelName('glm-4v:cloud')).toBe(true);
  });

  it('does NOT treat text-only GLM chat models as vision-capable', () => {
    // Regression: the old `glm-(4v|5)` pattern falsely flagged every glm-5.x
    // (and would have matched a bare glm-4.5) as a vision model, which made
    // image_analyze accept models that cannot see. These are text-only.
    expect(isVisionCapableModelName('glm-5.2:cloud')).toBe(false);
    expect(isVisionCapableModelName('glm-5.1:cloud')).toBe(false);
    expect(isVisionCapableModelName('glm-4.5')).toBe(false);
    expect(isVisionCapableModelName('glm-4.6:cloud')).toBe(false);
  });

  it('can choose Minimax M3 as an installed vision model', () => {
    expect(findInstalledVisionModel(['qwen2.5-coder:7b', 'minimax-m3:cloud'])).toBe('minimax-m3:cloud');
  });

  it('recognizes :cloud models as cloud-resolved', () => {
    expect(isCloudModelName('minimax-m3:cloud')).toBe(true);
    expect(isCloudModelName('glm-5.2:cloud')).toBe(true);
    expect(isCloudModelName('llava:latest')).toBe(false);
    expect(isCloudModelName('')).toBe(false);
  });

  it('treats a cloud vision model as usable even when not in the installed list', () => {
    // The tool's local `ollama list` does not report cloud models, so a
    // local-install-only gate wrongly rejected minimax-m3:cloud. Cloud
    // models must be usable without a local pull.
    expect(isVisionModelUsable('minimax-m3:cloud', [])).toBe(true);
    expect(isVisionModelUsable('minimax-m3:cloud', ['qwen2.5-coder:7b'])).toBe(true);
  });

  it('treats a locally installed model as usable via exact or bare-name match', () => {
    expect(isVisionModelUsable('llava:latest', ['llava:latest'])).toBe(true);
    expect(isVisionModelUsable('llava', ['llava:latest'])).toBe(true);
    expect(isVisionModelUsable('llava', ['qwen2.5-coder:7b'])).toBe(false);
    expect(isVisionModelUsable('', ['llava:latest'])).toBe(false);
  });
});