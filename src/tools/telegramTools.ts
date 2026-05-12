import type { Tool, ToolResult } from '../types';
import { getKnownTelegramChatIds, sendTelegramNotification } from '../integrations/telegram';

const MAX_NOTIFICATION_LENGTH = 4_000;

export const TelegramNotifyTool: Tool = {
  name: 'telegram_notify',
  description: 'Send a Telegram notification through the configured Harness Telegram bridge. Uses saved settings; never asks for or exposes the bot token. Requires the bot to be running and at least one known chat ID.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short notification title' },
      body: { type: 'string', description: 'Notification body text' },
    },
    required: ['title', 'body'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const title = String(input.title ?? '').trim();
    const body = String(input.body ?? '').trim();
    if (!title) return { success: false, output: 'Title is required.', error: 'missing title' };
    if (!body) return { success: false, output: 'Body is required.', error: 'missing body' };
    if (title.length + body.length > MAX_NOTIFICATION_LENGTH) {
      return { success: false, output: `Notification too long (${title.length + body.length} chars, max ${MAX_NOTIFICATION_LENGTH}).`, error: 'notification too long' };
    }
    const knownChatCount = getKnownTelegramChatIds().length;
    if (knownChatCount === 0) {
      return { success: false, output: 'Telegram bridge has no known chat IDs yet. Send /start or any message to the configured bot once, then retry.', error: 'no known chat ids' };
    }
    const sent = await sendTelegramNotification(title, body);
    if (sent === 0) {
      return { success: false, output: 'Telegram notification was not delivered. Check that the Harness server Telegram bot is running.', error: 'telegram not delivered' };
    }
    return { success: true, output: `Telegram notification sent to ${sent} chat(s).` };
  },
};
