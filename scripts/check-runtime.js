const fs = require('fs');
const path = require('path');

function supportsRuntime(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function launchMode(root) {
  if (fs.existsSync(path.join(root, 'src', 'web', 'server.ts'))) return 'source';
  if (!fs.existsSync(path.join(root, 'release-provenance.json'))) throw new Error('Missing source and release provenance. Reinstall a complete release.');
  if (!fs.existsSync(path.join(root, 'dist', 'web', 'server.js'))) throw new Error('Missing prebuilt server. Reinstall a complete release.');
  return 'prebuilt';
}

if (require.main === module) {
  try {
    if (!supportsRuntime(process.versions.node)) throw new Error('Node.js 22.13 or newer is required. Install Node.js 24 LTS from https://nodejs.org/.');
    if (process.argv.includes('--launch-mode')) console.log(launchMode(path.resolve(__dirname, '..')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { supportsRuntime, launchMode };