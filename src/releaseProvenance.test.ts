import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface ReleaseProvenance {
  assetName: string;
  commit: string;
  version: string;
  builtAt: string;
  releaseUrl: string;
}

const { generateReleaseProvenance } = require('../scripts/generate-release-provenance') as {
  generateReleaseProvenance: (options: { root: string; existingPath: string; version?: string; commit?: string; repository?: string; builtAt?: string }) => ReleaseProvenance;
};

describe('generateReleaseProvenance', () => {
  it('generates deterministic release fields from package and existing provenance', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-provenance-'));
    const existingPath = path.join(projectRoot, 'release-provenance.json');
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.2.3', repository: { url: 'https://github.com/example/from-package.git' } }, null, 2), 'utf-8');
    await fs.writeFile(existingPath, JSON.stringify({ commit: 'abc123', builtAt: '2026-05-05T00:00:00.000Z', releaseUrl: 'https://github.com/example/harness/releases/tag/v1.2.2' }, null, 2), 'utf-8');

    const provenance = generateReleaseProvenance({ root: projectRoot, existingPath });

    expect(provenance).toEqual({
      assetName: 'ollama-agent-harness-v1.2.3.zip',
      commit: 'abc123',
      version: '1.2.3',
      builtAt: '2026-05-05T00:00:00.000Z',
      releaseUrl: 'https://github.com/example/harness/releases/tag/v1.2.3',
    });
  });

  it('honors explicit release workflow overrides', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-provenance-override-'));
    const existingPath = path.join(projectRoot, 'release-provenance.json');
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2), 'utf-8');

    const provenance = generateReleaseProvenance({ root: projectRoot, existingPath, version: 'v2.0.0', commit: 'def456', repository: 'owner/repo', builtAt: '2026-05-05T12:00:00Z' });

    expect(provenance).toEqual({
      assetName: 'ollama-agent-harness-v2.0.0.zip',
      commit: 'def456',
      version: '2.0.0',
      builtAt: '2026-05-05T12:00:00Z',
      releaseUrl: 'https://github.com/owner/repo/releases/tag/v2.0.0',
    });
  });
});
