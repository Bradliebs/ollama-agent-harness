#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const logPath = process.argv[2] || process.env.HARNESS_DEBUG_LOG || '.forge-debug.jsonl';

if (!fs.existsSync(logPath)) {
  console.error(`Debug log not found: ${logPath}`);
  process.exit(1);
}

const rows = fs.readFileSync(logPath, 'utf-8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return { phase: 'invalid', line: index + 1, error: error instanceof Error ? error.message : String(error) };
    }
  });

const requests = rows.filter((row) => row.phase === 'request');
const responses = rows.filter((row) => row.phase === 'response');
const invalid = rows.filter((row) => row.phase === 'invalid');

console.log(`Debug payload summary for ${path.resolve(logPath)}`);
console.log(`Entries: ${rows.length} (${requests.length} request, ${responses.length} response, ${invalid.length} invalid)`);

if (requests.length === 0) {
  console.log('No request-phase entries found.');
  process.exit(invalid.length > 0 ? 1 : 0);
}

for (const [index, entry] of requests.entries()) {
  const metrics = entry.payload || {};
  const toolNames = Array.isArray(entry.toolNames) ? entry.toolNames.join(', ') : '';
  console.log([
    `${index + 1}. ${entry.timestamp || '(no timestamp)'}`,
    `model=${entry.model || '(unknown)'}`,
    `messages=${metrics.messageCount ?? '?'}`,
    `tools=${metrics.toolCount ?? 0}`,
    `chars=${metrics.totalEstimatedChars ?? '?'}`,
    `tokens~=${metrics.estimatedTokens ?? '?'}`,
    toolNames ? `toolNames=${toolNames}` : 'toolNames=(none)',
  ].join(' | '));
}

if (invalid.length > 0) {
  console.error(`Invalid JSONL lines: ${invalid.map((row) => row.line).join(', ')}`);
  process.exit(1);
}