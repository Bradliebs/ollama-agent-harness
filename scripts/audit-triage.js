#!/usr/bin/env node

const { spawnSync } = require('child_process');

const auditCommand = process.platform === 'win32'
  ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm audit --json'] }
  : { command: 'npm', args: ['audit', '--json'] };
const result = spawnSync(auditCommand.command, auditCommand.args, { encoding: 'utf-8' });
const raw = result.stdout || result.stderr;
if (!raw) {
  console.error('npm audit produced no JSON output');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch (error) {
  console.error('Failed to parse npm audit JSON');
  console.error(raw.slice(0, 1000));
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities || {};
const clusters = [
  {
    id: 'telegram-request-stack',
    owner: 'node-telegram-bot-api',
    packages: ['node-telegram-bot-api', '@cypress/request', '@cypress/request-promise', 'request', 'request-promise-core', 'form-data', 'qs', 'tough-cookie'],
    action: 'Replace or upgrade the Telegram bridge dependency in a dedicated compatibility pass; npm currently proposes a semver-major downgrade, so do not auto-fix during release packaging.',
  },
  {
    id: 'pdfjs-major-upgrade',
    owner: 'pdfjs-dist',
    packages: ['pdfjs-dist'],
    action: 'Upgrade PDF.js in a focused OCR/PDF parsing pass and verify uploaded PDF handling.',
  },
  {
    id: 'exceljs-uuid',
    owner: 'exceljs',
    packages: ['exceljs', 'uuid'],
    action: 'Track ExcelJS uuid advisory separately; npm proposes a semver-major downgrade, so validate workbook export before changing versions.',
  },
  {
    id: 'install-native-helper',
    owner: '@mapbox/node-pre-gyp',
    packages: ['@mapbox/node-pre-gyp', 'tar'],
    action: 'Investigate only if present in the current lockfile dependency tree; dry-run fix previews may include optional/native helper churn.',
  },
];

const summarized = clusters.map((cluster) => {
  const entries = cluster.packages
    .map((name) => vulnerabilities[name])
    .filter(Boolean)
    .map((item) => ({ name: item.name, severity: item.severity, direct: item.isDirect, via: summarizeVia(item.via), fixAvailable: item.fixAvailable ?? false }));
  return { ...cluster, findings: entries, affected: entries.length > 0 };
});

console.log(JSON.stringify({
  ok: true,
  metadata: report.metadata?.vulnerabilities || {},
  clusters: summarized,
}, null, 2));

function summarizeVia(via) {
  if (!Array.isArray(via)) return [];
  return via.map((entry) => typeof entry === 'string' ? entry : entry.title || entry.name || 'advisory').slice(0, 8);
}
