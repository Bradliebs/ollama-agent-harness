import { getSlackConnectorStatus, sanitizeSlackWebhookUrl } from './slack';

describe('Slack connector status', () => {
  it('reports notification-only readiness for a valid webhook', () => {
    const status = getSlackConnectorStatus('https://hooks.slack.com/services/T000/B000/secret');

    expect(status).toMatchObject({ configured: true, webhookValid: true, ready: true, mode: 'notification-only' });
    expect(status.allowlist).toContain('https://hooks.slack.com/services/*');
  });

  it('rejects non-Slack webhook hosts', () => {
    const status = getSlackConnectorStatus('https://example.com/hook');

    expect(status.configured).toBe(true);
    expect(status.webhookValid).toBe(false);
    expect(status.ready).toBe(false);
  });

  it('sanitizes persisted webhook input', () => {
    expect(sanitizeSlackWebhookUrl('  https://hooks.slack.com/services/T/B/C  ')).toBe('https://hooks.slack.com/services/T/B/C');
  });
});
