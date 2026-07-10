import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BUILTIN_MODEL_CATALOG, getModelCatalog, getModelCatalogCacheStatus, listCatalogModels, validateModelCatalogManifest, writeModelCatalogCache } from './modelCatalog';

describe('modelCatalog', () => {
  it('validates catalog manifests and rejects malformed models', () => {
    expect(validateModelCatalogManifest({ version: 1, updatedAt: 'now', providers: { ollama: { models: [{ id: 'qwen', description: 'ok' }] } } })).toBe(true);
    expect(validateModelCatalogManifest({ version: 1, updatedAt: 'now', metadata: { recommendations: [] }, providers: { ollama: { models: [{ id: 'qwen', description: 'ok' }] } } })).toBe(true);
    expect(validateModelCatalogManifest({ version: 2, updatedAt: 'now', providers: {} })).toBe(false);
    expect(validateModelCatalogManifest({ version: 1, updatedAt: 'now', metadata: [], providers: {} })).toBe(false);
    expect(validateModelCatalogManifest({ version: 1, updatedAt: 'now', providers: { ollama: { models: [{ description: 'missing id' }] } } })).toBe(false);
  });

  it('ships opinionated built-in recommendations for common jobs', () => {
    const recommendations = BUILTIN_MODEL_CATALOG.metadata?.recommendations;
    expect(Array.isArray(recommendations)).toBe(true);
    expect(JSON.stringify(recommendations)).toContain('Best for coding');
    expect(JSON.stringify(recommendations)).toContain('Best for research');
    expect(JSON.stringify(recommendations)).toContain('Safe local fallback');
  });

  it('fetches, caches, and reads provider model lists', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-catalog-'));
    const manifest = await getModelCatalog(projectDir, {
      url: 'https://example.test/catalog.json',
      fetchJson: async () => ({ version: 1, updatedAt: '2026-04-30T12:00:00.000Z', providers: { ollama: { models: [{ id: 'model-a', description: 'A' }] } } }),
    });

    expect(listCatalogModels(manifest, 'ollama')).toEqual([{ id: 'model-a', description: 'A' }]);
    await expect(getModelCatalog(projectDir)).resolves.toEqual(manifest);
  });

  it('falls back to stale cache or built-in presets when refresh fails', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-catalog-stale-'));
    const stale = { version: 1 as const, updatedAt: '2026-04-01T00:00:00.000Z', providers: { ollama: { models: [{ id: 'stale-model', description: 'cached' }] } } };
    await writeModelCatalogCache(projectDir, stale);

    await expect(getModelCatalog(projectDir, { url: 'https://example.test/catalog.json', fetchJson: async () => { throw new Error('offline'); } })).resolves.toEqual(stale);
    const emptyProject = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-catalog-empty-'));
    await expect(getModelCatalog(emptyProject)).resolves.toEqual({ ...BUILTIN_MODEL_CATALOG, stale: true });
  });

  it('reports cache freshness', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-catalog-status-'));
    await writeModelCatalogCache(projectDir, BUILTIN_MODEL_CATALOG);
    const status = await getModelCatalogCacheStatus(projectDir, new Date(), 60_000);
    expect(status).toMatchObject({ exists: true, fresh: true });
  });
});