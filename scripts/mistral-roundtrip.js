#!/usr/bin/env node
/*
 * Mistral round-trip diagnostic. After pasting your MISTRAL_API_KEY in the
 * Settings panel (or exporting it in your shell), run this to verify the
 * full backend → CLI → Mistral chat path works end-to-end. Prints a clear
 * PASS/FAIL with the model id, response length, and any error.
 *
 * Usage:
 *   node scripts/mistral-roundtrip.js                    # uses mistral-medium-latest
 *   node scripts/mistral-roundtrip.js codestral-latest   # custom model id
 *
 * Env overrides:
 *   HARNESS_MISTRAL_PROMPT="say hello"   (default)
 *   HARNESS_MISTRAL_TIMEOUT_MS=60000     (default)
 *
 * This script does NOT use the harness CLI — it makes a single direct
 * Mistral chat completion call so the diagnostic stays focused on
 * backend connectivity (auth, network, model name) rather than the agent
 * loop. If this passes, the harness CLI/UI Mistral path will too.
 */

const { readFileSync, existsSync } = require('fs');
const path = require('path');
const https = require('https');

const MODEL = process.argv[2] || 'mistral-medium-latest';
const PROMPT = process.env.HARNESS_MISTRAL_PROMPT || 'say hello';
const TIMEOUT_MS = parseInt(process.env.HARNESS_MISTRAL_TIMEOUT_MS || '60000', 10);

function loadApiKey() {
  // Same precedence as src/web/server.ts loadStoredApiKeys: env first,
  // then .harness/api-keys.json (where the UI stores keys).
  if (process.env.MISTRAL_API_KEY?.trim()) {
    return { key: process.env.MISTRAL_API_KEY.trim(), source: 'env' };
  }
  const filePath = path.resolve(__dirname, '..', '.harness', 'api-keys.json');
  if (existsSync(filePath)) {
    try {
      const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (typeof stored.MISTRAL_API_KEY === 'string' && stored.MISTRAL_API_KEY.trim()) {
        return { key: stored.MISTRAL_API_KEY.trim(), source: 'file (.harness/api-keys.json)' };
      }
    } catch {}
  }
  return null;
}

function callMistral(apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT }],
      temperature: 0,
      max_tokens: 50,
    });
    const req = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: `timeout after ${TIMEOUT_MS}ms` }); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const loaded = loadApiKey();
  if (!loaded) {
    console.log('FAIL: no MISTRAL_API_KEY configured.');
    console.log('  Fix: paste your key in Settings → Remote API Keys → Mistral AI, or set MISTRAL_API_KEY in your shell.');
    process.exit(1);
  }
  console.log(`Using key from ${loaded.source}; model=${MODEL}; prompt=${JSON.stringify(PROMPT)}`);
  const result = await callMistral(loaded.key);
  if (result.status === 200) {
    let parsed;
    try { parsed = JSON.parse(result.body); } catch {}
    const text = parsed?.choices?.[0]?.message?.content || '';
    console.log('PASS: HTTP 200 from api.mistral.ai');
    console.log(`  model: ${parsed?.model || '(unknown)'}`);
    console.log(`  response (${text.length} chars): ${JSON.stringify(text.slice(0, 200))}`);
    console.log('');
    console.log('Mistral wiring is good. The harness UI/CLI Mistral path will work.');
    console.log(`Next: pick the matching dropdown entry in the UI (e.g. mistral/${MODEL}) and chat.`);
    process.exit(0);
  }
  console.log(`FAIL: HTTP ${result.status} from api.mistral.ai`);
  if (result.error) console.log(`  network error: ${result.error}`);
  if (result.body) {
    const trimmed = result.body.length > 400 ? result.body.slice(0, 400) + '...' : result.body;
    console.log(`  response body: ${trimmed}`);
  }
  if (result.status === 401) console.log('  → 401 = key rejected. Re-check the key in Settings; make sure you saved it.');
  if (result.status === 422) console.log(`  → 422 = model id "${MODEL}" not recognized. Try mistral-small-latest, mistral-medium-latest, mistral-large-latest, or codestral-latest.`);
  if (result.status === 429) console.log('  → 429 = rate-limited; wait a minute and retry.');
  process.exit(1);
}

main().catch((err) => {
  console.error('FAIL: ' + (err.stack || err.message));
  process.exit(1);
});
