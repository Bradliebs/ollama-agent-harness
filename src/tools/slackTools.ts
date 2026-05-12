import type { Tool, ToolResult } from '../types';

const MAX_SLACK_MESSAGE_LENGTH = 4_000;

export const SlackNotifyTool: Tool = {
  name: 'slack_notify',
  description: 'Send a Slack notification through a configured incoming webhook. Uses HARNESS_SLACK_WEBHOOK_URL from Settings or the environment. Requires an explicit communication capability grant.',
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
    if (title.length + body.length > MAX_SLACK_MESSAGE_LENGTH) {
      return { success: false, output: `Notification too long (${title.length + body.length} chars, max ${MAX_SLACK_MESSAGE_LENGTH}).`, error: 'notification too long' };
    }

    const webhookUrl = process.env.HARNESS_SLACK_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      return { success: false, output: 'Slack webhook is not configured. Set HARNESS_SLACK_WEBHOOK_URL in Settings -> API Keys or the environment.', error: 'slack not configured' };
    }
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(webhookUrl)) {
      return { success: false, output: 'HARNESS_SLACK_WEBHOOK_URL must be a Slack incoming webhook URL.', error: 'invalid slack webhook' };
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${title}*\n${body}` }),
      });
      const responseText = await response.text().catch(() => '');
      if (!response.ok) {
        return { success: false, output: `Slack notification failed: HTTP ${response.status}${responseText ? ` ${responseText}` : ''}`, error: 'slack request failed' };
      }
      return { success: true, output: 'Slack notification sent.' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Slack notification failed: ${msg}`, error: msg };
    }
  },
};
