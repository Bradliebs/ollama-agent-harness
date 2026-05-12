export function isVisionCapableModelName(name: string, details: Record<string, unknown> = {}): boolean {
  const haystack = `${name} ${Object.values(details).join(' ')}`.toLowerCase();
  return /llava|bakllava|moondream|vision|qwen\d*(?:\.\d+)?vl|qwen.*vl|minicpm-v|granite.*vision|gemma.*vision/.test(haystack);
}

export function findInstalledVisionModel(modelNames: string[]): string | undefined {
  return modelNames.find((name) => isVisionCapableModelName(name));
}
