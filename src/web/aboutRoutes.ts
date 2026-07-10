import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

export interface AboutRoutesDeps {
  harnessRoot: string;
}

interface AboutInfo {
  version: string;
  commit: string;
  assetName: string;
  assetSha256: string;
  releaseUrl: string;
  generatedAt: string;
  manifestName: string;
  manifestUrl: string;
}

interface ReleaseVerification {
  status: 'verified' | 'warning';
  message: string;
  version: string;
  commit: string;
  assetName: string;
  releaseUrl: string;
  expectedSha256: string;
  localArchiveSha256: string;
  localArchivePath: string;
}

type ProvenancePartial = Partial<{
  version: string;
  commit: string;
  assetName: string;
  assetSha256: string;
  releaseUrl: string;
  generatedAt: string;
  manifestName: string;
}>;

type ManifestPartial = Partial<{
  assetName: string;
  assetSha256: string;
  generatedAt: string;
  manifestName: string;
}>;

export function createAboutRouter(deps: AboutRoutesDeps): express.Router {
  const { harnessRoot } = deps;
  const releaseProvenancePath = path.join(harnessRoot, 'release-provenance.json');
  const router = express.Router();

  async function readReleaseManifest(assetName?: string): Promise<ManifestPartial> {
    const candidates = [
      path.join(harnessRoot, 'release-manifest.json'),
      assetName ? path.join(harnessRoot, 'release', `${assetName}.sha256.json`) : '',
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        return JSON.parse(await fs.readFile(candidate, 'utf-8')) as ManifestPartial;
      } catch {
        // Try the next companion manifest location.
      }
    }
    return {};
  }

  async function readReleaseProvenance(): Promise<ProvenancePartial> {
    let provenance: ProvenancePartial = {};
    try {
      provenance = JSON.parse(await fs.readFile(releaseProvenancePath, 'utf-8')) as ProvenancePartial;
    } catch {
      provenance = {};
    }
    const manifest = await readReleaseManifest(provenance.assetName);
    return { ...provenance, ...manifest };
  }

  async function sha256FileIfExists(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  async function getAboutInfo(): Promise<AboutInfo> {
    const packageJson = JSON.parse(await fs.readFile(path.join(harnessRoot, 'package.json'), 'utf-8')) as { version?: string };
    const rawProvenance = await readReleaseProvenance();
    const provenance = packageJson.version && rawProvenance.version && rawProvenance.version !== packageJson.version ? {} : rawProvenance;
    const version = packageJson.version ?? provenance.version ?? 'unknown';
    const releaseUrl = provenance.releaseUrl ?? `https://github.com/Bradliebs/ollama-agent-harness/releases/tag/v${version}`;
    const manifestName = provenance.manifestName ?? `ollama-agent-harness-v${version}.zip.sha256.json`;
    return {
      version,
      commit: provenance.commit ?? process.env.GITHUB_SHA ?? '',
      assetName: provenance.assetName ?? `ollama-agent-harness-v${version}.zip`,
      assetSha256: provenance.assetSha256 ?? '',
      releaseUrl,
      generatedAt: provenance.generatedAt ?? '',
      manifestName,
      manifestUrl: releaseUrl && manifestName ? `${releaseUrl.replace(/\/tag\/[^/]+$/, `/download/v${version}`)}/${manifestName}` : '',
    };
  }

  async function getReleaseVerification(): Promise<ReleaseVerification> {
    const about = await getAboutInfo();
    const localArchivePath = path.join(harnessRoot, 'release', about.assetName);
    const localArchiveSha256 = await sha256FileIfExists(localArchivePath);
    if (about.assetSha256 && localArchiveSha256) {
      const verified = about.assetSha256.toLowerCase() === localArchiveSha256.toLowerCase();
      return {
        status: verified ? 'verified' : 'warning',
        message: verified ? 'Local release archive matches the recorded SHA-256.' : 'Local release archive SHA-256 does not match the recorded release provenance.',
        version: about.version,
        commit: about.commit,
        assetName: about.assetName,
        releaseUrl: about.releaseUrl,
        expectedSha256: about.assetSha256,
        localArchiveSha256,
        localArchivePath: path.relative(harnessRoot, localArchivePath),
      };
    }
    return {
      status: 'warning',
      message: about.assetSha256
        ? 'Recorded SHA-256 is available, but no local release archive was found to compare.'
        : 'This install has release provenance, but the release asset SHA-256 is only available on the GitHub release page.',
      version: about.version,
      commit: about.commit,
      assetName: about.assetName,
      releaseUrl: about.releaseUrl,
      expectedSha256: about.assetSha256,
      localArchiveSha256,
      localArchivePath: path.relative(harnessRoot, localArchivePath),
    };
  }

  router.get('/api/about', async (_req, res) => {
    try {
      res.json(await getAboutInfo());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/about/verify', async (_req, res) => {
    try {
      res.json(await getReleaseVerification());
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
