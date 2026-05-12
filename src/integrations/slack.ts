export interface SlackConnectorStatus {
  connector: 'slack';
  configured: boolean;
  webhookConfigured: boolean;
  webhookValid: boolean;
  allowlist: string[];
  mode: 'notification-only';
  ready: boolean;
  message: string;
}

export function getSlackConnectorStatus(webhookUrl = process.env.HARNESS_SLACK_WEBHOOK_URL ?? ''): SlackConnectorStatus {
  const trimmed = webhookUrl.trim();
  const webhookConfigured = trimmed.length > 0;
  const webhookValid = !webhookConfigured || /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(trimmed);
  const ready = webhookConfigured && webhookValid;
  return {
    connector: 'slack',
    configured: webhookConfigured,
    webhookConfigured,
    webhookValid,
    allowlist: ['https://hooks.slack.com/services/*'],
    mode: 'notification-only',
    ready,
    message: ready ? 'Slack incoming webhook is configured for notification-only sends.' : webhookConfigured ? 'Slack webhook URL is not a valid incoming webhook URL.' : 'No Slack incoming webhook is configured.',
  };
}

export function sanitizeSlackWebhookUrl(value: unknown): string {
  return String(value ?? '').trim().slice(0, 500);
}
