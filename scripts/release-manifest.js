#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));

function main() {
  const asset = args.asset ? path.resolve(args.asset) : '';
  if (!asset || !fs.existsSync(asset)) throw new Error('Usage: node scripts/release-manifest.js --asset <release-zip> --version <vX.Y.Z> --commit <sha> --output <manifest.json>');
  const version = args.version || '';
  const output = args.output ? path.resolve(args.output) : `${asset}.sha256.json`;
  const manifest = {
    version: version.replace(/^v/, ''),
    commit: args.commit || '',
    assetName: path.basename(asset),
    manifestName: path.basename(output),
    assetSize: fs.statSync(asset).size,
    assetSha256: sha256(asset),
    releaseUrl: args.repository && version ? `https://github.com/${args.repository}/releases/tag/${version}` : '',
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(JSON.stringify({ ok: true, output, assetSha256: manifest.assetSha256 }, null, 2));
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith('--')) continue;
    parsed[value.slice(2)] = values[i + 1] && !values[i + 1].startsWith('--') ? values[++i] : 'true';
  }
  return parsed;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
