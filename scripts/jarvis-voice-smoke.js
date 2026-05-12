#!/usr/bin/env node
// Smoke test for the hands-free voice pipeline.
//
// Generates a 1-second 16kHz mono PCM WAV of silence, POSTs it to the
// running harness's /api/jarvis/voice/transcribe endpoint, and asserts the
// server returns a usable response. This catches the failure mode that
// silently broke hands-free voice on 2026-05-12: env vars unset → 503 →
// mic appears dead with no diagnostic.
//
// Usage:
//   node scripts/jarvis-voice-smoke.js
//
// Env:
//   HARNESS_VOICE_SMOKE_URL  default: http://localhost:3001
//
// Exit codes:
//   0  success (200 OK with text field, even empty / [BLANK_AUDIO])
//   1  server reachable but transcribe failed (timeout, 5xx other than 503)
//   2  whisper not configured (503) — actionable, not a code bug
//   3  server unreachable (ECONNREFUSED etc.)

const http = require('http');
const { URL } = require('url');

function buildSilenceWav() {
  // 1s of silence at 16kHz mono 16-bit PCM = 32000 sample bytes + 44 header
  const sampleRate = 16000;
  const samples = sampleRate; // 1 second
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(1, 22);             // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  // Sample bytes are already zero (silence) from Buffer.alloc.
  return buf;
}

function post(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': body.length,
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, body: text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout after 30s')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const base = process.env.HARNESS_VOICE_SMOKE_URL || 'http://localhost:3001';
  const transcribeUrl = base.replace(/\/$/, '') + '/api/jarvis/voice/transcribe';
  console.log('[voice-smoke] POST', transcribeUrl);

  let result;
  try {
    result = await post(transcribeUrl, buildSilenceWav());
  } catch (err) {
    console.error('[voice-smoke] ❌ request failed:', err.message);
    console.error('[voice-smoke]    is the harness running? try `npm run start` in another terminal.');
    process.exit(3);
  }

  if (result.status === 503) {
    console.error('[voice-smoke] ⚠️  503 Whisper not configured.');
    console.error('[voice-smoke]    hint:', result.json && result.json.hint ? result.json.hint : '(none)');
    console.error('[voice-smoke]    fix:  set HARNESS_WHISPER_PYTHON=python and HARNESS_WHISPER_MODEL_NAME=<path-or-name>,');
    console.error('[voice-smoke]          then restart the harness so it inherits the env vars.');
    process.exit(2);
  }

  if (result.status !== 200) {
    console.error('[voice-smoke] ❌ status', result.status);
    console.error('[voice-smoke]    body:', result.body.slice(0, 400));
    process.exit(1);
  }

  if (!result.json || typeof result.json.text !== 'string') {
    console.error('[voice-smoke] ❌ 200 OK but missing { text: string } payload');
    console.error('[voice-smoke]    body:', result.body.slice(0, 400));
    process.exit(1);
  }

  const text = result.json.text.trim();
  console.log('[voice-smoke] ✅ 200 OK · text=' + JSON.stringify(text.slice(0, 80)));
  console.log('[voice-smoke]    (silence input typically yields "" or "[BLANK_AUDIO]" — both are healthy)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[voice-smoke] ❌ unexpected error:', err.stack || err.message);
  process.exit(1);
});
