#!/usr/bin/env node
// Send the current daily brief to Telegram chats that have messaged the bot.
//
// Use as a cron / Trigger entry, e.g.:
//   triggers.json:
//   { "id": "harness.daily-brief.telegram",
//     "command": "node", "args": ["scripts/jarvis-brief-telegram.js"],
//     "intervalSeconds": 28800, "enabled": true }
//
// Requires the harness web server to be running on the configured port.

const baseUrl = process.env.HARNESS_BASE_URL || 'http://127.0.0.1:3000';

async function main() {
  const response = await fetch(`${baseUrl}/api/jarvis/brief/telegram`, { method: 'POST' });
  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(`brief→telegram failed: ${response.status} ${text}\n`);
    process.exit(1);
  }
  process.stdout.write(`${text}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
