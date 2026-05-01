import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types';

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
