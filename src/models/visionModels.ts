export function isVisionCapableModelName(name: string, details: Record<string, unknown> = {}): boolean {
  const haystack = `${name} ${Object.values(details).join(' ')}`.toLowerCase();
  // GLM vision models carry a "V" suffix (glm-4v, glm-4.1v, glm-4.5v). The
  // text-only GLM chat models (glm-4.5, glm-4.6, glm-5.x) must NOT match, so
  // the pattern requires the trailing "v". The previous `glm-(4v|5)` pattern
  // wrongly flagged every glm-5.x as vision AND missed glm-4.5v.
  return /llava|bakllava|moondream|vision|qwen\d*(?:\.\d+)?vl|qwen.*vl|minicpm-v|granite.*vision|gemma.*vision|glm-\d+(?:\.\d+)?v|minimax[-_]?m3/.test(haystack);
}

export function findInstalledVisionModel(modelNames: string[]): string | undefined {
  return modelNames.find((name) => isVisionCapableModelName(name));
}

/**
 * Cloud models (Ollama's `:cloud` variants) are resolved remotely and never
 * appear in `ollama list`, so a local-install check wrongly rejects them.
 * Callers use this to treat a cloud vision model (e.g. minimax-m3:cloud) as
 * usable without requiring a local pull.
 */
export function isCloudModelName(name: string): boolean {
  return /:cloud$/i.test(String(name ?? '').trim());
}

/**
 * A vision model is usable when it is either locally installed OR a cloud
 * model. `installed` is the list returned by `ollama list`; matching accepts
 * an exact name or a bare-name/tag prefix (mirrors Ollama's name:tag scheme).
 */
export function isVisionModelUsable(name: string, installed: string[]): boolean {
  if (!name) return false;
  if (isCloudModelName(name)) return true;
  if (installed.includes(name)) return true;
  const bare = name.split(':')[0];
  return installed.some((entry) => entry === bare || entry.startsWith(`${bare}:`));
}
