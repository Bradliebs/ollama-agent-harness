export interface WhatsAppConnectorStatus {
  connector: 'whatsapp';
  configured: boolean;
  accessTokenConfigured: boolean;
  phoneNumberIdConfigured: boolean;
  hasAllowedRecipients: boolean;
  allowedRecipientCount: number;
  mode: 'status-only';
  ready: boolean;
  message: string;
}

export interface WhatsAppConnectorSettings {
  accessToken?: string;
  phoneNumberId?: string;
  allowedRecipients?: string;
}

export function getWhatsAppConnectorStatus(settings: WhatsAppConnectorSettings = {}): WhatsAppConnectorStatus {
  const accessToken = String(settings.accessToken ?? process.env.HARNESS_WHATSAPP_ACCESS_TOKEN ?? '').trim();
  const phoneNumberId = String(settings.phoneNumberId ?? process.env.HARNESS_WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  const recipients = parseWhatsAppAllowedRecipients(settings.allowedRecipients ?? process.env.HARNESS_WHATSAPP_ALLOWED_RECIPIENTS ?? '');
  const accessTokenConfigured = accessToken.length > 0;
  const phoneNumberIdConfigured = /^[0-9]{6,32}$/.test(phoneNumberId);
  const hasAllowedRecipients = recipients.length > 0;
  const configured = accessTokenConfigured || phoneNumberId.length > 0 || hasAllowedRecipients;
  const ready = accessTokenConfigured && phoneNumberIdConfigured && hasAllowedRecipients;
  return {
    connector: 'whatsapp',
    configured,
    accessTokenConfigured,
    phoneNumberIdConfigured,
    hasAllowedRecipients,
    allowedRecipientCount: recipients.length,
    mode: 'status-only',
    ready,
    message: ready
      ? 'WhatsApp Cloud API setup is present. Harness keeps this connector status-only until a notification tool is explicitly added.'
      : 'WhatsApp setup requires an access token, numeric phone number ID, and an allowed-recipient list.',
  };
}

export function parseWhatsAppAllowedRecipients(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\+?[0-9]{8,20}$/.test(item))
    .slice(0, 50);
}

export function sanitizeWhatsAppSetup(value: WhatsAppConnectorSettings): Required<WhatsAppConnectorSettings> {
  return {
    accessToken: String(value.accessToken ?? '').trim().slice(0, 500),
    phoneNumberId: String(value.phoneNumberId ?? '').trim().slice(0, 80),
    allowedRecipients: parseWhatsAppAllowedRecipients(value.allowedRecipients ?? '').join(','),
  };
}
