#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { generateReleaseProvenance } = require('./generate-release-provenance');

const root = path.resolve(__dirname, '..');
const packageJson = readJson(path.join(root, 'package.json'));
const packageVersion = String(packageJson.version || '').trim();
const installerPath = path.join(root, 'installer', 'harness-installer.nsi');
const provenancePath = path.join(root, 'release-provenance.json');
const installerText = fs.existsSync(installerPath) ? fs.readFileSync(installerPath, 'utf-8') : '';
const provenance = fs.existsSync(provenancePath) ? readJson(provenancePath) : null;
const generatedProvenance = generateReleaseProvenance({ root, existingPath: provenancePath });

const checks = [];
checks.push({ name: 'package.json', version: packageVersion, expected: packageVersion });
checks.push({ name: 'installer VIProductVersion', version: normalizeInstallerVersion(extract(installerText, /VIProductVersion\s+"([^"]+)"/)), expected: packageVersion });
checks.push({ name: 'installer FileVersion', version: extract(installerText, /VIAddVersionKey\s+"FileVersion"\s+"([^"]+)"/), expected: packageVersion });
checks.push({ name: 'installer DisplayVersion', version: extract(installerText, /"DisplayVersion"\s+"([^"]+)"/), expected: packageVersion });
if (provenance) {
  checks.push({ name: 'release-provenance version', version: String(provenance.version || '').trim(), expected: generatedProvenance.version });
  checks.push({ name: 'release-provenance assetName', version: String(provenance.assetName || '').trim(), expected: generatedProvenance.assetName });
  checks.push({ name: 'release-provenance releaseUrl', version: String(provenance.releaseUrl || '').trim(), expected: generatedProvenance.releaseUrl });
}

const failures = checks.filter((check) => check.version !== check.expected);
for (const check of checks) {
  const status = check.version === check.expected ? 'ok' : 'mismatch';
  console.log(`${status}: ${check.name} = ${check.version || '(missing)'} (expected ${check.expected})`);
}

if (failures.length > 0) {
  console.error(`Release version verification failed: ${failures.length} mismatch(es).`);
  process.exit(1);
}

console.log(`Release version verification passed for ${packageVersion}.`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function extract(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || '';
}

function normalizeInstallerVersion(value) {
  return String(value || '').replace(/\.0$/, '').trim();
}
