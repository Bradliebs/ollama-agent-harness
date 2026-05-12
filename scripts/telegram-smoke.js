#!/usr/bin/env node

const baseUrl = (process.env.HARNESS_SMOKE_BASE_URL || process.argv[2] || 'http://127.0.0.1:4000').replace(/\/$/, '');
const requireConfigured = process.env.HARNESS_TELEGRAM_REQUIRE_CONFIGURED === '1';
const requireRunning = process.env.HARNESS_TELEGRAM_REQUIRE_RUNNING === '1';

async function main() {
  const response = await fetch(`${baseUrl}/api/telegram/status`);
  if (!response.ok) throw new Error(`Telegram status returned HTTP ${response.status}`);
  const status = await response.json();
  assertBoolean(status, 'configured');
  assertBoolean(status, 'running');
  assertBoolean(status, 'hasAllowedChatIds');
  if (!status.pollingLock || typeof status.pollingLock !== 'object') throw new Error('Telegram status missing pollingLock object');
  if (typeof status.pollingLock.path !== 'string') throw new Error('Telegram pollingLock.path must be a string');
  if (typeof status.pollingLock.active !== 'boolean') throw new Error('Telegram pollingLock.active must be a boolean');
  if (typeof status.pollingLock.ownedByCurrentProcess !== 'boolean') throw new Error('Telegram pollingLock.ownedByCurrentProcess must be a boolean');
  if ('token' in status || 'telegramBotToken' in status) throw new Error('Telegram status leaked a token field');
  if (requireConfigured && !status.configured) throw new Error('Telegram is not configured');
  if (requireRunning && !status.running) throw new Error('Telegram bot is not running');
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    configured: status.configured,
    running: status.running,
    hasAllowedChatIds: status.hasAllowedChatIds,
    pollingLock: {
      active: status.pollingLock.active,
      ownedByCurrentProcess: status.pollingLock.ownedByCurrentProcess,
    },
  }, null, 2));
}

function assertBoolean(source, key) {
  if (typeof source[key] !== 'boolean') throw new Error(`Telegram status ${key} must be a boolean`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
