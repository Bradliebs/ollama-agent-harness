#!/usr/bin/env node
// Barge-in regression test: drives the dashboard with playwright, fakes
// an in-flight TTS utterance, then invokes jarvisBargeInCancelTts and
// asserts speechSynthesis.cancel() was called and jarvisTtsPlaying flipped
// to false. Catches any future regression where the barge-in path quietly
// stops cancelling TTS — exactly the kind of "works in dev, breaks at
// user-pace" bug the function was added to prevent.
//
// Usage:
//   node scripts/jarvis-bargein-smoke.js
//
// Env:
//   HARNESS_VOICE_SMOKE_URL  default: http://localhost:3001
//
// Exit codes:
//   0  pass
//   1  assertion failed
//   2  setup failed (page didn't load, function not found, etc.)
//   3  playwright not installed (skipped — same convention as ui-smoke.js)

const targetUrl = process.env.HARNESS_VOICE_SMOKE_URL || 'http://localhost:3001/';

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('[bargein-smoke] playwright not installed — skipping (run `npm i playwright` then `npx playwright install chromium`)');
    process.exit(3);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg) => {
      // Surface page errors so a broken script load shows up here, not
      // as a silent timeout.
      if (msg.type() === 'error') console.error('[bargein-smoke page error]', msg.text());
    });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => typeof jarvisBargeInCancelTts === 'function', { timeout: 15000 });

    const result = await page.evaluate(() => {
      // Fake an in-flight TTS utterance and spy on cancel().
      window.__cancelCalls = 0;
      const origCancel = window.speechSynthesis.cancel.bind(window.speechSynthesis);
      window.speechSynthesis.cancel = function () { window.__cancelCalls += 1; return origCancel(); };
      // Listen for the dispatched event.
      window.__ttsEnded = 0;
      document.addEventListener('jarvis-tts-ended', () => { window.__ttsEnded += 1; });
      // Set the playback flag the way jarvisSpeak would.
      jarvisTtsPlaying = true;
      const beforePlaying = jarvisTtsPlaying;
      jarvisBargeInCancelTts();
      const afterPlaying = jarvisTtsPlaying;
      // Idempotency: a second call must not double-cancel or double-event.
      jarvisBargeInCancelTts();
      return {
        beforePlaying,
        afterPlaying,
        cancelCalls: window.__cancelCalls,
        ttsEnded: window.__ttsEnded,
      };
    });

    const failures = [];
    if (result.beforePlaying !== true) failures.push('expected jarvisTtsPlaying=true before barge-in, got ' + result.beforePlaying);
    if (result.afterPlaying !== false) failures.push('expected jarvisTtsPlaying=false after barge-in, got ' + result.afterPlaying);
    if (result.cancelCalls !== 1) failures.push('expected speechSynthesis.cancel() called exactly 1 time, got ' + result.cancelCalls);
    if (result.ttsEnded !== 1) failures.push('expected jarvis-tts-ended dispatched exactly 1 time, got ' + result.ttsEnded);

    if (failures.length > 0) {
      console.error('[bargein-smoke] ❌ FAIL');
      for (const f of failures) console.error('  -', f);
      process.exit(1);
    }
    console.log('[bargein-smoke] ✅ pass: cancel=' + result.cancelCalls + ' tts-ended=' + result.ttsEnded + ' (idempotent)');
    process.exit(0);
  } catch (err) {
    console.error('[bargein-smoke] ❌ setup failed:', err.message);
    process.exit(2);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main();
