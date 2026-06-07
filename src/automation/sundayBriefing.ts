import { createAutomationJob, updateAutomationJob, type AutomationJob } from './jobs';

/**
 * Sunday 09:00 briefing template. Demonstrates that any tool registered
 * in createToolRegistry is reachable from the scheduler channel — this
 * job exercises shopping_list and reading_list, the same tools the web
 * chat and Telegram bot already see.
 *
 * Shipped as opt-in source, not as a committed jobs.json entry, because
 * .harness/ is gitignored. Install via installSundayBriefingJob.
 */
export const SUNDAY_BRIEFING_TEMPLATE = {
  name: 'Sunday briefing',
  prompt: [
    'It is Sunday morning. Do two things:',
    '1. Call shopping_list with op="list" and summarise outstanding items.',
    '   Group by likely store if there are quantity hints; otherwise list as-is.',
    '2. Call reading_list with op="list" and pick three unread items to surface this week.',
    'Output a short markdown brief with a "Shopping" section and a "Reading" section.',
  ].join('\n'),
  // Cron fields: m h dom mon dow (0=Sunday). 09:00 every Sunday.
  schedule: '0 9 * * 0',
} as const;

/**
 * Creates the Sunday briefing job in .harness/automations/jobs.json
 * and immediately disables it. The user flips enabled=true via the
 * automations UI (or updateAutomationJob) when ready to fire it.
 */
export async function installSundayBriefingJob(projectDir: string, now = new Date()): Promise<AutomationJob> {
  const created = await createAutomationJob(projectDir, { ...SUNDAY_BRIEFING_TEMPLATE }, now);
  const disabled = await updateAutomationJob(projectDir, created.id, { enabled: false }, now);
  if (!disabled) throw new Error('Failed to disable Sunday briefing job after creation');
  return disabled;
}
