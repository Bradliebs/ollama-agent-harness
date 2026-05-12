import * as fs from 'fs/promises';
import * as path from 'path';

export interface ModelCatalogModel {
  id: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ModelCatalogProvider {
  metadata?: Record<string, unknown>;
  models: ModelCatalogModel[];
}

export interface ModelCatalogManifest {
  version: 1;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  providers: Record<string, ModelCatalogProvider>;
}

export interface ModelCatalogCacheStatus {
  path: string;
  exists: boolean;
  fresh: boolean;
  ageMs: number;
}

export interface GetModelCatalogOptions {
  url?: string;
  ttlMs?: number;
  forceRefresh?: boolean;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: Date;
}

export const DEFAULT_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export const BUILTIN_MODEL_CATALOG: ModelCatalogManifest = {
  version: 1,
  updatedAt: 'builtin',
  metadata: {
    recommendations: [
      { useCase: 'Best for coding', modelId: 'qwen2.5-coder:7b', reason: 'Best built-in local default for code edits; still validate with typecheck, tests, or smoke.' },
      { useCase: 'Best for research', modelId: 'llama3.1:8b', reason: 'General local reasoning default for summaries and workspace research.' },
      { useCase: 'Safe local fallback', modelId: 'llama3.1:8b', reason: 'Keeps prompts local when privacy matters more than raw capability.' },
      { useCase: 'Best for autonomy', modelId: 'strongest configured tool-capable model', reason: 'Use the strongest configured backend for long autonomous runs; keep validation and evidence review on.' },
      { useCase: 'Vision', modelId: 'llava:latest', reason: 'Use when image analysis is required and the model is pulled locally.' },
    ],
  },
  providers: {
    ollama: {
      metadata: { source: 'builtin' },
      models: [
        { id: 'qwen2.5-coder:7b', description: 'Balanced local coding default' },
        { id: 'llama3.1:8b', description: 'General local chat and reasoning model' },
        { id: 'llava:latest', description: 'Vision-capable local model for image analysis' },
      ],
    },
  },
};

export function validateModelCatalogManifest(value: unknown): value is ModelCatalogManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== 'string') return false;
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false;
  if (!isRecord(value.providers)) return false;
  for (const [providerName, provider] of Object.entries(value.providers)) {
    if (!providerName.trim() || !isRecord(provider) || !Array.isArray(provider.models)) return false;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) return false;
      if (model.description !== undefined && typeof model.description !== 'string') return false;
      if (model.metadata !== undefined && !isRecord(model.metadata)) return false;
    }
  }
  return true;
}

export async function getModelCatalog(projectDir: string, options: GetModelCatalogOptions = {}): Promise<ModelCatalogManifest> {
  const ttlMs = options.ttlMs ?? DEFAULT_MODEL_CATALOG_TTL_MS;
  const now = options.now ?? new Date();
  const cache = await readModelCatalogCache(projectDir);
  const fresh = cache ? now.getTime() - Date.parse(cache.updatedAt) < ttlMs : false;
  if (cache && fresh && !options.forceRefresh) return cache;

  if (options.url && options.fetchJson) {
    try {
      const fetched = await options.fetchJson(options.url);
      if (validateModelCatalogManifest(fetched)) {
        const manifest = { ...fetched, updatedAt: fetched.updatedAt || now.toISOString() };
        await writeModelCatalogCache(projectDir, manifest);
        return manifest;
      }
    } catch {
      // Use stale cache or built-in fallback below.
    }
  }

  return cache ?? BUILTIN_MODEL_CATALOG;
}

export async function getModelCatalogCacheStatus(projectDir: string, now = new Date(), ttlMs = DEFAULT_MODEL_CATALOG_TTL_MS): Promise<ModelCatalogCacheStatus> {
  const filePath = modelCatalogCachePath(projectDir);
  try {
    const stat = await fs.stat(filePath);
    const ageMs = now.getTime() - stat.mtimeMs;
    return { path: filePath, exists: true, fresh: ageMs < ttlMs, ageMs };
  } catch {
    return { path: filePath, exists: false, fresh: false, ageMs: Number.POSITIVE_INFINITY };
  }
}

export async function readModelCatalogCache(projectDir: string): Promise<ModelCatalogManifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(modelCatalogCachePath(projectDir), 'utf-8')) as unknown;
    return validateModelCatalogManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeModelCatalogCache(projectDir: string, manifest: ModelCatalogManifest): Promise<void> {
  if (!validateModelCatalogManifest(manifest)) throw new Error('Invalid model catalog manifest.');
  const filePath = modelCatalogCachePath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function listCatalogModels(manifest: ModelCatalogManifest, provider: string): ModelCatalogModel[] {
  return manifest.providers[provider]?.models ?? [];
}

function modelCatalogCachePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'cache', 'model-catalog.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}