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
    // Strip internal spaces — Google App Passwords are displayed with spaces.
    const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');
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

// ─── Email inbox reader tool ──────────────────────────────────────
//
// Reads recent emails from an IMAP mailbox. Uses the same credentials
// as the SMTP sender:
//   HARNESS_IMAP_HOST (e.g. imap.gmail.com) — falls back to HARNESS_SMTP_HOST
//   HARNESS_IMAP_PORT (default: 993)
//   HARNESS_SMTP_USER (your email address)
//   HARNESS_SMTP_PASS (app password)
//
// For Gmail: the same App Password works for both SMTP and IMAP.
// Capability: email-sending (read-only, but gated under the same grant)

const DEFAULT_IMAP_HOSTS: Record<string, string> = {
  'smtp.gmail.com': 'imap.gmail.com',
  'smtp.office365.com': 'outlook.office365.com',
  'smtp.mail.yahoo.com': 'imap.mail.yahoo.com',
};

export const EmailInboxTool: Tool = {
  name: 'email_inbox',
  description: 'Check the email inbox via IMAP. Returns the most recent emails with subject, from, date, and a preview of the body. Requires SMTP credentials to be configured (uses same App Password). Set HARNESS_IMAP_HOST if different from the SMTP host.',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of recent emails to fetch (default 10, max 50)' },
      folder: { type: 'string', description: 'Mailbox folder to read (default INBOX)' },
      unseen_only: { type: 'boolean', description: 'Only return unread/unseen messages (default false)' },
      search: { type: 'string', description: 'Optional search term to filter by subject or sender' },
    },
    required: [],
  },
  isReadOnly: true,
  execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
    const count = Math.min(Math.max(1, Number(input.count) || 10), 50);
    const folder = String(input.folder ?? 'INBOX').trim();
    const unseenOnly = Boolean(input.unseen_only);
    const search = typeof input.search === 'string' ? input.search.trim() : '';

    const smtpHost = process.env.HARNESS_SMTP_HOST?.trim();
    const user = process.env.HARNESS_SMTP_USER?.trim();
    const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');
    const imapHost = process.env.HARNESS_IMAP_HOST?.trim()
      || (smtpHost ? DEFAULT_IMAP_HOSTS[smtpHost] : undefined)
      || smtpHost;
    const imapPort = parseInt(process.env.HARNESS_IMAP_PORT ?? '993', 10);

    if (!imapHost || !user || !pass) {
      return {
        success: false,
        output: 'IMAP not configured. The inbox reader uses your SMTP credentials.\nSet in Settings → API Keys:\n• HARNESS_SMTP_HOST (e.g. smtp.gmail.com)\n• HARNESS_SMTP_USER\n• HARNESS_SMTP_PASS\n\nOptionally: HARNESS_IMAP_HOST if different from SMTP host.',
        error: 'IMAP not configured',
      };
    }

    try {
      // Dynamic require to avoid breaking if imapflow is not installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      let ImapFlowCtor: new (config: Record<string, unknown>) => ImapFlowClient;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('imapflow');
        ImapFlowCtor = mod.ImapFlow;
      } catch {
        return { success: false, output: 'imapflow package not installed. Run: npm install imapflow', error: 'missing dependency' };
      }

      const client = new ImapFlowCtor({
        host: imapHost,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user, pass },
        logger: false,
      });

      await client.connect();

      const lock = await client.getMailboxLock(folder);
      try {
        // Build search query
        const searchQuery: Record<string, unknown> = {};
        if (unseenOnly) searchQuery.seen = false;
        if (search) searchQuery.or = [{ subject: search }, { from: search }];

        // Fetch messages — get the latest `count` matching messages
        const messages: EmailSummary[] = [];
        const fetchRange = unseenOnly || search
          ? '1:*'
          : `${Math.max(1, (client.mailbox?.exists ?? count) - count + 1)}:*`;

        const fetchOptions = { envelope: true, bodyStructure: true, source: { start: 0, maxLength: 2000 } };
        for await (const msg of client.fetch(
          Object.keys(searchQuery).length > 0 ? searchQuery : fetchRange,
          fetchOptions,
          Object.keys(searchQuery).length > 0 ? {} : undefined,
        )) {
          const env = msg.envelope;
          if (!env) continue;
          const bodyPreview = msg.source
            ? extractTextPreview(msg.source.toString('utf-8'), 300)
            : '';
          messages.push({
            uid: msg.uid,
            date: env.date?.toISOString() ?? '',
            from: formatAddress(env.from),
            to: formatAddress(env.to),
            subject: env.subject ?? '(no subject)',
            preview: bodyPreview,
            flags: [...(msg.flags ?? [])],
          });
        }

        // Sort newest first, limit to count
        messages.sort((a, b) => b.date.localeCompare(a.date));
        const results = messages.slice(0, count);

        if (results.length === 0) {
          return {
            success: true,
            output: unseenOnly
              ? `No unread emails in ${folder}.`
              : `No emails found in ${folder}${search ? ` matching "${search}"` : ''}.`,
          };
        }

        let output = `📬 ${results.length} email(s) from ${folder}${unseenOnly ? ' (unread only)' : ''}:\n\n`;
        for (const msg of results) {
          const unread = !msg.flags.includes('\\Seen') ? '🔵 ' : '';
          output += `${unread}**${msg.subject}**\n`;
          output += `  From: ${msg.from} | ${msg.date.slice(0, 16)}\n`;
          if (msg.preview) output += `  ${msg.preview}\n`;
          output += '\n';
        }

        return { success: true, output };
      } finally {
        lock.release();
        await client.logout();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Email', 'IMAP fetch failed', { folder, error: msg });
      return { success: false, output: `Failed to check inbox: ${msg}`, error: msg };
    }
  },
};

interface EmailSummary {
  uid: number;
  date: string;
  from: string;
  to: string;
  subject: string;
  preview: string;
  flags: string[];
}

// Minimal type for imapflow client (avoids needing @types/imapflow)
interface ImapFlowClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(folder: string): Promise<{ release(): void }>;
  mailbox?: { exists: number };
  fetch(
    range: string | Record<string, unknown>,
    options: Record<string, unknown>,
    searchOptions?: Record<string, unknown>,
  ): AsyncIterable<{
    uid: number;
    envelope?: {
      date?: Date;
      from?: Array<{ name?: string; address?: string }>;
      to?: Array<{ name?: string; address?: string }>;
      subject?: string;
    };
    source?: Buffer;
    flags?: Set<string>;
    bodyStructure?: unknown;
  }>;
  search(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<number[]>;
  messageDelete(range: string | number[], options?: Record<string, unknown>): Promise<boolean>;
  messageFlagsAdd(range: string | number[], flags: string[], options?: Record<string, unknown>): Promise<boolean>;
}

function formatAddress(addrs?: Array<{ name?: string; address?: string }>): string {
  if (!addrs || addrs.length === 0) return '(unknown)';
  return addrs.map((a) => a.name ? `${a.name} <${a.address}>` : a.address ?? '').join(', ');
}

function extractTextPreview(raw: string, maxLen: number): string {
  // Multi-part MIME messages have nested headers (Content-Type boundaries,
  // Delivered-To, Received, X-* etc.). Strip everything that looks like
  // RFC 822 headers: lines matching "Key: value" before a blank line,
  // MIME boundary markers, and base64/quoted-printable cruft.
  let body = raw;

  // Strip all header blocks (top-level + MIME part headers).
  // A header block is contiguous lines of "Key: value" ending at a blank line.
  body = body.replace(/^([A-Za-z][\w-]*:\s.*(\r?\n[ \t].*)*\r?\n)+\r?\n/gm, '');

  // Strip MIME boundary lines (--boundary, --boundary--)
  body = body.replace(/^--[\w=+/.-]+--?\s*$/gm, '');

  // Strip Content-Type / Content-Transfer-Encoding lines that survive
  body = body.replace(/^Content-[\w-]+:.*$/gim, '');

  // Strip base64 blobs (long lines of [A-Za-z0-9+/=])
  body = body.replace(/^[A-Za-z0-9+/=]{60,}\s*$/gm, '');

  // Strip HTML tags
  body = body.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// ─── Email delete tool ──────────────────────────────────────────────
//
// Deletes emails by sender, subject search, or age. Uses IMAP to
// search and then expunge matching messages. Supports bulk operations
// like "delete all emails from instagram.com".
//
// Safety: requires confirmation count to avoid accidental mass deletion.

const MAX_DELETE_BATCH = 500;

export const EmailDeleteTool: Tool = {
  name: 'email_delete',
  description: 'Delete emails from the inbox via IMAP. Can delete by sender (from), subject search, or older_than_days. Returns count of deleted messages. Use email_inbox first to preview what will be deleted. Safety cap: max 500 per call.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Delete emails from this sender (e.g. "instagram.com", "noreply@github.com")' },
      subject: { type: 'string', description: 'Delete emails matching this subject substring' },
      older_than_days: { type: 'number', description: 'Only delete emails older than this many days' },
      folder: { type: 'string', description: 'Mailbox folder (default INBOX)' },
      confirm_count: { type: 'number', description: 'Expected number of messages to delete. Required as a safety check — call email_inbox first to get the count.' },
      dry_run: { type: 'boolean', description: 'If true, count matching emails without deleting (default false)' },
    },
    required: [],
  },
  isReadOnly: false,
  execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
    const fromFilter = typeof input.from === 'string' ? input.from.trim() : '';
    const subjectFilter = typeof input.subject === 'string' ? input.subject.trim() : '';
    const olderThanDays = typeof input.older_than_days === 'number' ? input.older_than_days : undefined;
    const folder = String(input.folder ?? 'INBOX').trim();
    const confirmCount = typeof input.confirm_count === 'number' ? input.confirm_count : undefined;
    const dryRun = Boolean(input.dry_run);

    if (!fromFilter && !subjectFilter && olderThanDays === undefined) {
      return { success: false, output: 'At least one filter is required: from, subject, or older_than_days. Refusing to delete without a filter.', error: 'no filter' };
    }

    const smtpHost = process.env.HARNESS_SMTP_HOST?.trim();
    const user = process.env.HARNESS_SMTP_USER?.trim();
    const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');
    const imapHost = process.env.HARNESS_IMAP_HOST?.trim()
      || (smtpHost ? DEFAULT_IMAP_HOSTS[smtpHost] : undefined)
      || smtpHost;
    const imapPort = parseInt(process.env.HARNESS_IMAP_PORT ?? '993', 10);

    if (!imapHost || !user || !pass) {
      return { success: false, output: 'IMAP not configured. Set HARNESS_SMTP_HOST, HARNESS_SMTP_USER, HARNESS_SMTP_PASS.', error: 'IMAP not configured' };
    }

    try {
      let ImapFlowCtor: new (config: Record<string, unknown>) => ImapFlowClient;
      try {
        const mod = require('imapflow');
        ImapFlowCtor = mod.ImapFlow;
      } catch {
        return { success: false, output: 'imapflow package not installed. Run: npm install imapflow', error: 'missing dependency' };
      }

      const client = new ImapFlowCtor({
        host: imapHost,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user, pass },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        // Build IMAP search query
        const searchCriteria: Record<string, unknown> = {};
        if (fromFilter) searchCriteria.from = fromFilter;
        if (subjectFilter) searchCriteria.subject = subjectFilter;
        if (olderThanDays !== undefined) {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - olderThanDays);
          searchCriteria.before = cutoff;
        }

        const uids = await client.search(searchCriteria, { uid: true });

        if (uids.length === 0) {
          return { success: true, output: `No emails matched the filter in ${folder}.\nFrom: ${fromFilter || '(any)'}\nSubject: ${subjectFilter || '(any)'}${olderThanDays !== undefined ? `\nOlder than: ${olderThanDays} days` : ''}` };
        }

        if (dryRun) {
          return {
            success: true,
            output: `🔍 Dry run: ${uids.length} email(s) match the filter in ${folder}.\nFrom: ${fromFilter || '(any)'}\nSubject: ${subjectFilter || '(any)'}${olderThanDays !== undefined ? `\nOlder than: ${olderThanDays} days` : ''}\n\nTo delete, call again with dry_run: false and confirm_count: ${uids.length}`,
          };
        }

        // Safety check: require confirm_count to match
        if (confirmCount === undefined) {
          return {
            success: false,
            output: `Found ${uids.length} matching email(s). For safety, set confirm_count: ${uids.length} to proceed with deletion. Use dry_run: true first to preview.`,
            error: 'confirm_count required',
          };
        }

        if (confirmCount !== uids.length) {
          return {
            success: false,
            output: `Safety check failed: confirm_count (${confirmCount}) does not match actual count (${uids.length}). Re-run email_inbox or email_delete with dry_run to get the current count.`,
            error: 'count mismatch',
          };
        }

        // Cap batch size
        const batch = uids.slice(0, MAX_DELETE_BATCH);
        const capped = uids.length > MAX_DELETE_BATCH;

        await client.messageDelete(batch, { uid: true });

        const summary = `🗑️ Deleted ${batch.length} email(s) from ${folder}.\nFrom: ${fromFilter || '(any)'}\nSubject: ${subjectFilter || '(any)'}${olderThanDays !== undefined ? `\nOlder than: ${olderThanDays} days` : ''}${capped ? `\n\n⚠️ ${uids.length - MAX_DELETE_BATCH} more match — run again to delete the rest.` : ''}`;

        logger.info('Email', 'Deleted', { folder, from: fromFilter, subject: subjectFilter, count: batch.length });
        return { success: true, output: summary };
      } finally {
        lock.release();
        await client.logout();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Email', 'IMAP delete failed', { folder, error: msg });
      return { success: false, output: `Failed to delete emails: ${msg}`, error: msg };
    }
  },
};
