/**
 * Tests for comparisonSchema preset loader.
 */
import { findPresetForIntent, listPresetCategories, loadPreset } from './comparisonSchema';

describe('comparisonSchema preset loader', () => {
  it('lists the shipped presets', async () => {
    const categories = await listPresetCategories();
    expect(categories).toEqual(expect.arrayContaining(['aircons']));
  });

  it('loads the aircons preset and exposes expected columns', async () => {
    const schema = await loadPreset('aircons');
    expect(schema).not.toBeNull();
    expect(schema!.category).toBe('aircons');
    expect(schema!.title).toMatch(/air conditioner/i);
    const keys = schema!.columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['model', 'price_usd', 'btu', 'noise_db', 'energy_class', 'url']));
    const price = schema!.columns.find((c) => c.key === 'price_usd')!;
    expect(price.direction).toBe('lower-better');
    expect(price.weight).toBeGreaterThan(0);
  });

  it('returns null for an unknown category instead of throwing', async () => {
    expect(await loadPreset('definitely-not-a-real-category')).toBeNull();
  });

  it('rejects path-traversal in the category id by returning null', async () => {
    expect(await loadPreset('../../etc/passwd')).toBeNull();
  });

  it('findPresetForIntent matches an alias substring case-insensitively', async () => {
    expect((await findPresetForIntent('compare PORTABLE Aircons under $500'))?.category).toBe('aircons');
    expect((await findPresetForIntent('find me the best air conditioner'))?.category).toBe('aircons');
    expect(await findPresetForIntent('research the best dishwashers')).toBeNull();
  });
});
