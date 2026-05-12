import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadModelProfiles, saveModelProfiles, getModelProfile, setModelProfileField } from './modelProfiles';

async function makeProjectDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'model-profiles-'));
}

describe('modelProfiles', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeProjectDir();
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty store when no file exists', async () => {
    const store = await loadModelProfiles(projectDir);
    expect(store).toEqual({ profiles: {} });
  });

  it('round-trips contextMaxTokens for a model', async () => {
    await setModelProfileField(projectDir, 'gpt-oss:120b-cloud', 'contextMaxTokens', 0);
    const store = await loadModelProfiles(projectDir);
    expect(store.profiles['gpt-oss:120b-cloud']).toEqual({ contextMaxTokens: 0 });
  });

  it('overwrites an existing field without losing other models', async () => {
    await setModelProfileField(projectDir, 'gemma4:e4b', 'contextMaxTokens', 1024);
    await setModelProfileField(projectDir, 'gpt-oss:120b-cloud', 'contextMaxTokens', 0);
    await setModelProfileField(projectDir, 'gemma4:e4b', 'contextMaxTokens', 2048);
    const store = await loadModelProfiles(projectDir);
    expect(store.profiles['gemma4:e4b']?.contextMaxTokens).toBe(2048);
    expect(store.profiles['gpt-oss:120b-cloud']?.contextMaxTokens).toBe(0);
  });

  it('removes the entry entirely when its last field is cleared', async () => {
    await setModelProfileField(projectDir, 'gemma4:e4b', 'contextMaxTokens', 1024);
    await setModelProfileField(projectDir, 'gemma4:e4b', 'contextMaxTokens', undefined);
    const store = await loadModelProfiles(projectDir);
    expect(store.profiles['gemma4:e4b']).toBeUndefined();
  });

  it('rejects an empty model name in setModelProfileField', async () => {
    await expect(setModelProfileField(projectDir, '', 'contextMaxTokens', 0)).rejects.toThrow();
  });

  it('drops invalid contextMaxTokens values during load', async () => {
    const fp = path.join(projectDir, '.harness', 'model-profiles.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    // Write a file with a non-numeric entry; loader must coerce or skip.
    await fs.writeFile(fp, JSON.stringify({ profiles: { 'foo': { contextMaxTokens: 'big' }, 'bar': { contextMaxTokens: -1 }, 'baz': { contextMaxTokens: 4096 } } }), 'utf-8');
    const store = await loadModelProfiles(projectDir);
    expect(store.profiles['foo']?.contextMaxTokens).toBeUndefined();
    expect(store.profiles['bar']?.contextMaxTokens).toBeUndefined();
    expect(store.profiles['baz']?.contextMaxTokens).toBe(4096);
  });

  it('treats malformed JSON as empty', async () => {
    const fp = path.join(projectDir, '.harness', 'model-profiles.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, 'not json', 'utf-8');
    const store = await loadModelProfiles(projectDir);
    expect(store).toEqual({ profiles: {} });
  });

  it('getModelProfile returns undefined when model is empty', async () => {
    expect(await getModelProfile(projectDir, '')).toBeUndefined();
  });

  it('getModelProfile reads the persisted entry', async () => {
    await saveModelProfiles(projectDir, { profiles: { 'mistral-medium': { contextMaxTokens: 16384 } } });
    const profile = await getModelProfile(projectDir, 'mistral-medium');
    expect(profile?.contextMaxTokens).toBe(16384);
  });

  it('persists validationProfile and pairedVisionModel alongside contextMaxTokens', async () => {
    await setModelProfileField(projectDir, 'gpt-oss:120b-cloud', 'contextMaxTokens', 0);
    await setModelProfileField(projectDir, 'gpt-oss:120b-cloud', 'validationProfile', 'oracle-prime');
    await setModelProfileField(projectDir, 'gpt-oss:120b-cloud', 'pairedVisionModel', 'llava:latest');
    const profile = await getModelProfile(projectDir, 'gpt-oss:120b-cloud');
    expect(profile).toEqual({ contextMaxTokens: 0, validationProfile: 'oracle-prime', pairedVisionModel: 'llava:latest' });
  });

  it('clearing one extra field leaves the other fields intact', async () => {
    await setModelProfileField(projectDir, 'foo', 'contextMaxTokens', 4096);
    await setModelProfileField(projectDir, 'foo', 'validationProfile', 'coding-answer');
    await setModelProfileField(projectDir, 'foo', 'validationProfile', undefined);
    const profile = await getModelProfile(projectDir, 'foo');
    expect(profile).toEqual({ contextMaxTokens: 4096 });
  });

  it('drops empty string validationProfile and pairedVisionModel during load', async () => {
    const fp = path.join(projectDir, '.harness', 'model-profiles.json');
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify({ profiles: { 'foo': { validationProfile: '   ', pairedVisionModel: '' } } }), 'utf-8');
    const store = await loadModelProfiles(projectDir);
    expect(store.profiles['foo']).toEqual({});
  });
});
