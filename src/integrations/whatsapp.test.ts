import { getWhatsAppConnectorStatus, parseWhatsAppAllowedRecipients, sanitizeWhatsAppSetup } from './whatsapp';

describe('WhatsApp connector status', () => {
  it('reports status-only readiness when setup and recipient allowlist are present', () => {
    const status = getWhatsAppConnectorStatus({ accessToken: 'token', phoneNumberId: '1234567890', allowedRecipients: '+447700900123,+15555550123' });

    expect(status).toMatchObject({ configured: true, ready: true, mode: 'status-only', allowedRecipientCount: 2 });
  });

  it('requires a recipient allowlist before readiness', () => {
    const status = getWhatsAppConnectorStatus({ accessToken: 'token', phoneNumberId: '1234567890', allowedRecipients: '' });

    expect(status.configured).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.hasAllowedRecipients).toBe(false);
  });

  it('sanitizes recipient allowlists', () => {
    expect(parseWhatsAppAllowedRecipients('+447700900123, nope, 15555550123')).toEqual(['+447700900123', '15555550123']);
    expect(sanitizeWhatsAppSetup({ accessToken: ' token ', phoneNumberId: ' 123456 ', allowedRecipients: 'bad,+447700900123' })).toEqual({ accessToken: 'token', phoneNumberId: '123456', allowedRecipients: '+447700900123' });
  });
});
