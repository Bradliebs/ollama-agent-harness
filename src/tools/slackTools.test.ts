import { SlackNotifyTool } from './slackTools';

const originalFetch = global.fetch;
const originalWebhookUrl = process.env.HARNESS_SLACK_WEBHOOK_URL;

describe('SlackNotifyTool', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWebhookUrl === undefined) delete process.env.HARNESS_SLACK_WEBHOOK_URL;
    else process.env.HARNESS_SLACK_WEBHOOK_URL = originalWebhookUrl;
    jest.restoreAllMocks();
  });

  it('requires a configured webhook URL', async () => {
    delete process.env.HARNESS_SLACK_WEBHOOK_URL;

    const result = await SlackNotifyTool.execute({ title: 'Build', body: 'Done' });

    expect(result).toMatchObject({ success: false, error: 'slack not configured' });
  });

  it('rejects non-Slack webhook URLs', async () => {
    process.env.HARNESS_SLACK_WEBHOOK_URL = 'https://example.com/webhook';

    const result = await SlackNotifyTool.execute({ title: 'Build', body: 'Done' });

    expect(result).toMatchObject({ success: false, error: 'invalid slack webhook' });
  });

  it('posts the notification to Slack', async () => {
    process.env.HARNESS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/secret';
    const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => ({ ok: true, status: 200, text: async () => 'ok' } as Response));
    global.fetch = fetchMock;

    const result = await SlackNotifyTool.execute({ title: 'Build', body: 'Done' });

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/services/T000/B000/secret', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '*Build*\nDone' }),
    }));
  });

  it('surfaces Slack HTTP failures', async () => {
    process.env.HARNESS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/secret';
    global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => ({ ok: false, status: 403, text: async () => 'invalid_auth' } as Response));

    const result = await SlackNotifyTool.execute({ title: 'Build', body: 'Done' });

    expect(result).toMatchObject({ success: false, error: 'slack request failed' });
    expect(result.output).toContain('HTTP 403 invalid_auth');
  });
});
