import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Per-model overrides remembered across sessions so switching models in
 * the UI does not drag a wrong global setting along. Today the only
 * tracked field is `contextMaxTokens` (cycle 18); the structure keeps
 * room for future per-model fields like `validationProfile` or
 * `pairedVisionModel` without a schema rewrite.
 *
 * Profiles are scoped to the project (.harness/model-profiles.json) and
 * are missing-file friendly — every reader returns an empty map when no
 * profiles have been recorded.
 */

export interface ModelProfile {
  /**
   * Model-specific contextMaxTokens. Same semantics as the global
   * setting: 0 means auto-detect; >0 caps the detected window.
   */
  contextMaxTokens?: number;
  /**
   * Output validation profile to apply when this model is the active
   * chat model. Examples: 'coding-answer', 'oracle-prime'. Empty/unset
   * means "use whatever is globally configured".
   */
  validationProfile?: string;
  /**
   * Vision model to pair with this chat model when the user attaches
   * an image. Useful when a strong text model has no vision capability
   * and you want a specific multimodal companion (e.g. llava:latest)
   * regardless of the global vision setting.
   */
  pairedVisionModel?: string;
}

export interface ModelProfileStore {
  profiles: Record<string, ModelProfile>;
}

const STORE_REL_PATH = path.join('.harness', 'model-profiles.json');

function storePath(projectDir: string): string {
  return path.join(projectDir, STORE_REL_PATH);
}

export async function loadModelProfiles(projectDir: string): Promise<ModelProfileStore> {
  const fp = storePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(fp, 'utf-8');
  } catch {
    return { profiles: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModelProfileStore>;
    const profiles: Record<string, ModelProfile> = {};
    if (parsed.profiles && typeof parsed.profiles === 'object') {
      for (const [model, value] of Object.entries(parsed.profiles)) {
        if (!model || typeof model !== 'string') continue;
        const next: ModelProfile = {};
        if (value && typeof value === 'object') {
          const v = value as ModelProfile;
          if (typeof v.contextMaxTokens === 'number' && Number.isFinite(v.contextMaxTokens) && v.contextMaxTokens >= 0) {
            next.contextMaxTokens = v.contextMaxTokens;
          }
          if (typeof v.validationProfile === 'string' && v.validationProfile.trim()) {
            next.validationProfile = v.validationProfile.trim().slice(0, 80);
          }
          if (typeof v.pairedVisionModel === 'string' && v.pairedVisionModel.trim()) {
            next.pairedVisionModel = v.pairedVisionModel.trim().slice(0, 120);
          }
        }
        profiles[model] = next;
      }
    }
    return { profiles };
  } catch {
    // Malformed file should never crash the daemon; treat as empty.
    return { profiles: {} };
  }
}

export async function saveModelProfiles(projectDir: string, store: ModelProfileStore): Promise<void> {
  const fp = storePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(store, null, 2), 'utf-8');
}

export async function getModelProfile(projectDir: string, model: string): Promise<ModelProfile | undefined> {
  if (!model) return undefined;
  const store = await loadModelProfiles(projectDir);
  return store.profiles[model];
}

export async function setModelProfileField<K extends keyof ModelProfile>(
  projectDir: string,
  model: string,
  field: K,
  value: ModelProfile[K] | undefined,
): Promise<ModelProfileStore> {
  if (!model) throw new Error('model is required');
  const store = await loadModelProfiles(projectDir);
  const current = store.profiles[model] ?? {};
  const next = { ...current };
  if (value === undefined) {
    delete next[field];
  } else {
    next[field] = value;
  }
  // Drop the entry entirely when no fields remain so the file stays
  // tidy and round-trips correctly.
  const hasAnyField = Object.values(next).some((v) => v !== undefined);
  if (hasAnyField) {
    store.profiles[model] = next;
  } else {
    delete store.profiles[model];
  }
  await saveModelProfiles(projectDir, store);
  return store;
}
