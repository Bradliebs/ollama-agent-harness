/**
 * scripts/morning-priority.js
 *
 * Trigger script invoked by the harness TriggerScheduler each tick.
 * Prints (on stdout) a prompt-of-the-day message when:
 *   - today's date >= today
 *   - the user hasn't recorded an answer yet
 *   - the prompt hasn't already been shown in the last 12 hours
 *
 * Non-empty stdout becomes a `trigger.message` event the configured
 * channel (Telegram, web banner) delivers. Exit code 0 with no output
 * = "nothing to say right now". Exit non-zero = silent.
 *
 * Wire into `.harness/triggers/triggers.json` with intervalSeconds 900
 * (15 min) — the de-dupe inside the script ensures the question only
 * fires once a day.
 */

'use strict';

const { resolve } = require('node:path');

(async () => {
  let mp;
  try {
    mp = require('../src/services/morningPriority');
  } catch {
    mp = require('../dist/services/morningPriority');
  }

  const projectDir = process.env.HARNESS_PROJECT_DIR
    ? resolve(process.env.HARNESS_PROJECT_DIR)
    : process.cwd();
  const now = new Date();

  // Only ask between 09:00 and 11:00 local time
  const hour = now.getHours();
  if (hour < 9 || hour >= 11) process.exit(1);

  const today = await mp.getPriorityForToday(projectDir, now);
  if (today && today.answer) process.exit(1);
  if (today && today.askedAt) {
    const askedAge = Date.now() - new Date(today.askedAt).getTime();
    if (askedAge < 12 * 3600 * 1000) process.exit(1);
  }

  await mp.markPromptShown(projectDir, now);

  process.stdout.write(
    `🌅 Good morning. What's the **one** thing you want to make sure happens today?\n\n` +
    `Reply: \`priority: <your top thing>\` (or \`/priority …\`) and I'll keep it visible in the daily brief.\n`,
  );
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`[morning-priority] ${err && err.stack || err}\n`);
  process.exit(2);
});
