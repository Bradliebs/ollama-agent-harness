import * as fs from 'fs/promises';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import type { Tool, ToolResult } from '../types';
import { logger } from '../core/logger';

// ─── Email draft tool ───────────────────────────────────────────────
//
// Creates email drafts as .eml files under .harness/email/drafts/.
// Does NOT send emails — it produces a file the user can open in their
// email client to review and send manually.
//
// Capability: email-sending (gated)
// Risk: medium — writes draft files, no network access

const DRAFTS_DIR = '.harness/email/drafts';
const MAX_BODY_LENGTH = 50_000;

export const EmailDraftTool: Tool = {
  name: 'email_draft',
  description: 'Create an email draft as a .eml file. The draft is saved locally for you to review and send from your email client. Does NOT send emails automatically. Requires email-sending capability grant.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Email body in plain text' },
      cc: { type: 'string', description: 'Optional CC addresses, comma-separated' },
    },
    required: ['to', 'subject', 'body'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const to = String(input.to ?? '').trim();
    const subject = String(input.subject ?? '').trim();
    const body = String(input.body ?? '').trim();
    const cc = typeof input.cc === 'string' ? input.cc.trim() : '';

    if (!to) return { success: false, output: 'Recipient (to) is required.', error: 'missing to' };
    if (!subject) return { success: false, output: 'Subject is required.', error: 'missing subject' };
    if (!body) return { success: false, output: 'Body is required.', error: 'missing body' };
    if (body.length > MAX_BODY_LENGTH) return { success: false, output: `Body too long (${body.length} chars, max ${MAX_BODY_LENGTH}).`, error: 'body too long' };

    // Validate email addresses loosely
    const toAddresses = to.split(',').map((a) => a.trim()).filter(Boolean);
    for (const addr of toAddresses) {
      if (!addr.includes('@') || !addr.includes('.')) {
        return { success: false, output: `Invalid email address: ${addr}`, error: 'invalid email' };
      }
    }

    // Build .eml content (RFC 2822 format)
    const timestamp = new Date().toUTCString();
    const emlLines = [
      `From: <draft@local>`,
      `To: ${toAddresses.join(', ')}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subject}`,
      `Date: ${timestamp}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `X-Draft-Created-By: ollama-agent-harness`,
      ``,
      body,
    ];

    const projectDir = process.cwd();
    const draftsDir = path.join(projectDir, DRAFTS_DIR);
    await fs.mkdir(draftsDir, { recursive: true });

    const safeSubject = subject.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 50).trim().replace(/\s+/g, '-') || 'draft';
    const filename = `${safeSubject}-${Date.now()}.eml`;
    const filepath = path.join(draftsDir, filename);

    try {
      await fs.writeFile(filepath, emlLines.join('\r\n'), 'utf-8');
      const relativePath = path.relative(projectDir, filepath);
      return {
        success: true,
        output: `Email draft saved to ${relativePath}\n\nTo: ${toAddresses.join(', ')}\nSubject: ${subject}\n\nOpen this .eml file in your email client to review and send.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to save draft: ${msg}`, error: msg };
    }
  },
};

// ─── Email send tool ────────────────────────────────────────────────
//
// Sends emails via SMTP using nodemailer. Requires SMTP configuration
// via environment variables or API keys:
//   HARNESS_SMTP_HOST (e.g. smtp.gmail.com)
//   HARNESS_SMTP_PORT (default: 587)
//   HARNESS_SMTP_USER (your email address)
//   HARNESS_SMTP_PASS (app password, NOT your login password)
//   HARNESS_SMTP_FROM (optional, defaults to SMTP_USER)
//
// For Gmail: use an App Password (Google Account → Security → App passwords)
// For Outlook: use an App Password or enable SMTP AUTH
//
// Capability: email-sending (gated)
// Risk: high — sends real emails over the network

export const EmailSendTool: Tool = {
  name: 'email_send',
  description: 'Send an email via SMTP with optional file attachments. Requires SMTP configuration in settings (HARNESS_SMTP_HOST, HARNESS_SMTP_USER, HARNESS_SMTP_PASS). For Gmail, use an App Password. Requires email-sending capability grant.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Email body in plain text or HTML' },
      cc: { type: 'string', description: 'Optional CC addresses, comma-separated' },
      html: { type: 'boolean', description: 'If true, body is treated as HTML. Default: false (plain text)' },
      attachments: { type: 'array', description: 'Optional file paths to attach (e.g. ["report.xlsx", "C:/AI/Oracle/summary.pdf"]). Paths are resolved against the project root and allowed external dirs.', items: { type: 'string' } },
    },
    required: ['to', 'subject', 'body'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const to = String(input.to ?? '').trim();
    const subject = String(input.subject ?? '').trim();
    const body = String(input.body ?? '').trim();
    const cc = typeof input.cc === 'string' ? input.cc.trim() : '';
    const isHtml = Boolean(input.html);

    if (!to) return { success: false, output: 'Recipient (to) is required.', error: 'missing to' };
    if (!subject) return { success: false, output: 'Subject is required.', error: 'missing subject' };
    if (!body) return { success: false, output: 'Body is required.', error: 'missing body' };
    if (body.length > MAX_BODY_LENGTH) return { success: false, output: `Body too long (${body.length} chars, max ${MAX_BODY_LENGTH}).`, error: 'body too long' };

    // Validate email addresses
    const toAddresses = to.split(',').map((a) => a.trim()).filter(Boolean);
    for (const addr of toAddresses) {
      if (!addr.includes('@') || !addr.includes('.')) {
        return { success: false, output: `Invalid email address: ${addr}`, error: 'invalid email' };
      }
    }

    // Get SMTP configuration from environment (set via API keys or env vars).
    const host = process.env.HARNESS_SMTP_HOST?.trim();
    const port = parseInt(process.env.HARNESS_SMTP_PORT ?? '587', 10);
    const user = process.env.HARNESS_SMTP_USER?.trim();
    const pass = process.env.HARNESS_SMTP_PASS?.trim();
    const from = process.env.HARNESS_SMTP_FROM?.trim() || user;

    if (!host || !user || !pass) {
      return {
        success: false,
        output: 'SMTP not configured. Set these in Settings → API Keys:\n• HARNESS_SMTP_HOST (e.g. smtp.gmail.com)\n• HARNESS_SMTP_USER (your email)\n• HARNESS_SMTP_PASS (app password)\n\nFor Gmail: Google Account → Security → App passwords.',
        error: 'smtp not configured',
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });

      // Resolve file attachments.
      const rawAttachments = Array.isArray(input.attachments) ? input.attachments as string[] : [];
      const mailAttachments: Array<{ filename: string; path: string }> = [];
      for (const rawPath of rawAttachments) {
        const filePath = String(rawPath).trim();
        if (!filePath) continue;
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        try {
          await fs.access(resolved);
          mailAttachments.push({ filename: path.basename(resolved), path: resolved });
        } catch {
          return { success: false, output: `Attachment not found: ${filePath}`, error: 'attachment not found' };
        }
      }

      const info = await transporter.sendMail({
        from: from ? `Oracle <${from}>` : undefined,
        to: toAddresses.join(', '),
        cc: cc || undefined,
        subject,
        ...(isHtml ? { html: body } : { text: body }),
        attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
      });

      logger.info('Email', 'Sent', { to, subject, messageId: info.messageId, attachments: mailAttachments.length });

      // Also save a copy as .eml for records.
      const projectDir = process.cwd();
      const sentDir = path.join(projectDir, '.harness', 'email', 'sent');
      await fs.mkdir(sentDir, { recursive: true });
      const safeSubject = subject.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 50).trim().replace(/\s+/g, '-') || 'sent';
      const filename = `${safeSubject}-${Date.now()}.eml`;
      const emlContent = `From: ${from}\r\nTo: ${toAddresses.join(', ')}\r\n${cc ? `Cc: ${cc}\r\n` : ''}Subject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: ${info.messageId}\r\n\r\n${body}\r\n`;
      await fs.writeFile(path.join(sentDir, filename), emlContent, 'utf-8');

      return {
        success: true,
        output: `✅ Email sent successfully!\n\nTo: ${toAddresses.join(', ')}\nSubject: ${subject}${mailAttachments.length > 0 ? `\nAttachments: ${mailAttachments.map((a) => a.filename).join(', ')}` : ''}\nMessage ID: ${info.messageId}\n\nA copy was saved to .harness/email/sent/${filename}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Email', 'Send failed', { to, subject, error: msg });
      return { success: false, output: `Failed to send email: ${msg}`, error: msg };
    }
  },
};
