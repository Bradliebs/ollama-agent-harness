import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as nodemailer from 'nodemailer';
import { atomicWriteFile, withFileLock } from '../persistence/atomicFile';

type EmailTemplate = { name: string; to: string; subject: string; body: string; html?: boolean; category?: string };

export interface EmailRoutesDeps {
  projectDir: string;
  requireAuth: (req: express.Request, res: express.Response, actionLabel: string) => boolean;
}

export function createEmailRouter(deps: EmailRoutesDeps): express.Router {
  const router = express.Router();
  const EMAIL_TEMPLATES_PATH = path.join(deps.projectDir, '.harness', 'email', 'templates.json');

  async function readEmailTemplates(): Promise<EmailTemplate[]> {
    try {
      const raw = await fs.readFile(EMAIL_TEMPLATES_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  // Test SMTP connectivity without sending an email. Uses nodemailer's
  // verify() which authenticates against the server and checks readiness.
  router.post('/api/smtp-test', async (_req, res) => {
    const host = process.env.HARNESS_SMTP_HOST?.trim();
    const port = parseInt(process.env.HARNESS_SMTP_PORT ?? '587', 10);
    const user = process.env.HARNESS_SMTP_USER?.trim();
    // Strip internal spaces from the password — Google App Passwords are
    // displayed as "xxxx xxxx xxxx xxxx" but SMTP auth needs them joined.
    const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');

    if (!host || !user || !pass) {
      res.json({ ok: false, error: 'SMTP not configured. Save HARNESS_SMTP_HOST, HARNESS_SMTP_USER, and HARNESS_SMTP_PASS first.' });
      return;
    }
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });
      await transporter.verify();
      transporter.close();
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.json({ ok: false, error: `${msg} (host: ${host}, port: ${port}, user: ${user})` });
    }
  });

  // Send an email directly from the settings compose form.
  router.post('/api/email/send', express.json({ limit: '25mb' }), async (req, res) => {
    try {
      if (!deps.requireAuth(req, res, 'email send')) return;
      const to = String(req.body?.to ?? '').trim();
      const subject = String(req.body?.subject ?? '').trim();
      const body = String(req.body?.body ?? '').trim();
      if (!to || !subject || !body) {
        res.status(400).json({ error: 'To, subject, and body are required.' });
        return;
      }
      const toAddresses = to.split(',').map((a: string) => a.trim()).filter(Boolean);
      for (const addr of toAddresses) {
        if (!addr.includes('@') || !addr.includes('.')) {
          res.status(400).json({ error: `Invalid email address: ${addr}` });
          return;
        }
      }
      const host = process.env.HARNESS_SMTP_HOST?.trim();
      const port = parseInt(process.env.HARNESS_SMTP_PORT ?? '587', 10);
      const user = process.env.HARNESS_SMTP_USER?.trim();
      const pass = process.env.HARNESS_SMTP_PASS?.trim().replace(/\s+/g, '');
      const from = process.env.HARNESS_SMTP_FROM?.trim() || user;
      if (!host || !user || !pass) {
        res.status(400).json({ error: 'SMTP not configured. Save SMTP credentials first.' });
        return;
      }
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      // Build attachment list from optional base64-encoded files.
      const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      const mailAttachments: Array<{ filename: string; content: Buffer }> = [];
      for (const att of rawAttachments.slice(0, 10)) {
        const name = String(att?.filename ?? 'attachment').replace(/[/\\]/g, '_');
        const b64 = String(att?.content ?? '');
        if (!b64) continue;
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 10 * 1024 * 1024) {
          res.status(400).json({ error: `Attachment "${name}" exceeds 10 MB limit.` });
          return;
        }
        mailAttachments.push({ filename: name, content: buf });
      }
      const info = await transporter.sendMail({
        from: from ? `Harness <${from}>` : undefined,
        to: toAddresses.join(', '),
        subject,
        ...(req.body?.html ? { html: body } : { text: body }),
        attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
      });
      // Archive sent copy.
      const sentDir = path.join(deps.projectDir, '.harness', 'email', 'sent');
      await fs.mkdir(sentDir, { recursive: true });
      const safeSubject = subject.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 50).trim().replace(/\s+/g, '-') || 'sent';
      const filename = `${safeSubject}-${Date.now()}.eml`;
      const emlContent = `From: ${from}\r\nTo: ${toAddresses.join(', ')}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: ${info.messageId}\r\n\r\n${body}\r\n`;
      await fs.writeFile(path.join(sentDir, filename), emlContent, 'utf-8');
      res.json({ ok: true, messageId: info.messageId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // List email drafts and sent emails for the preview panel.
  router.get('/api/email/list', async (_req, res) => {
    const draftsDir = path.join(deps.projectDir, '.harness', 'email', 'drafts');
    const sentDir = path.join(deps.projectDir, '.harness', 'email', 'sent');
    const results: Array<{ name: string; folder: 'drafts' | 'sent'; modified: string }> = [];
    for (const [dir, folder] of [[draftsDir, 'drafts'], [sentDir, 'sent']] as const) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.eml')) continue;
          try {
            const stat = await fs.stat(path.join(dir, file));
            results.push({ name: file, folder, modified: stat.mtime.toISOString() });
          } catch { /* skip unreadable */ }
        }
      } catch { /* directory doesn't exist yet */ }
    }
    results.sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ emails: results.slice(0, 50) });
  });

  // Read the content of a single draft/sent .eml file.
  router.get('/api/email/read', async (req, res) => {
    const folder = req.query.folder === 'sent' ? 'sent' : 'drafts';
    const name = String(req.query.name ?? '');
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename.' });
      return;
    }
    const filePath = path.join(deps.projectDir, '.harness', 'email', folder, name);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      res.json({ name, folder, content });
    } catch {
      res.status(404).json({ error: 'File not found.' });
    }
  });

  // Save a compose-in-progress draft.
  router.put('/api/email/draft', async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const subject = String(req.body?.subject ?? '').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!to && !subject && !body) { res.json({ ok: false, reason: 'empty' }); return; }
    const draftsDir = path.join(deps.projectDir, '.harness', 'email', 'drafts');
    await fs.mkdir(draftsDir, { recursive: true });
    const filename = 'compose-autosave.eml';
    const emlContent = `To: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n\r\n${body}\r\n`;
    await fs.writeFile(path.join(draftsDir, filename), emlContent, 'utf-8');
    res.json({ ok: true, filename });
  });

  router.delete('/api/email/delete', async (req, res) => {
    const folder = req.query.folder === 'sent' ? 'sent' : 'drafts';
    const name = String(req.query.name ?? '');
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.eml')) {
      res.status(400).json({ error: 'Invalid filename.' });
      return;
    }
    const filePath = path.join(deps.projectDir, '.harness', 'email', folder, name);
    try {
      await fs.unlink(filePath);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'File not found.' });
    }
  });

  // ─── Email templates ──────────────────────────────────────────────────
  router.get('/api/email/templates', async (_req, res) => {
    res.json({ templates: await readEmailTemplates() });
  });

  router.post('/api/email/templates', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'Template name is required.' }); return; }
    const template = {
      name,
      to: String(req.body?.to ?? '').trim(),
      subject: String(req.body?.subject ?? '').trim(),
      body: String(req.body?.body ?? '').trim(),
      ...(req.body?.html ? { html: true } : {}),
      ...(typeof req.body?.category === 'string' && req.body.category.trim() ? { category: String(req.body.category).trim().slice(0, 60) } : {}),
    };
    const count = await withFileLock(EMAIL_TEMPLATES_PATH, async () => {
      const templates = await readEmailTemplates();
      const idx = templates.findIndex((t) => t.name === name);
      if (idx >= 0) templates[idx] = template; else templates.push(template);
      await atomicWriteFile(EMAIL_TEMPLATES_PATH, JSON.stringify(templates, null, 2));
      return templates.length;
    });
    res.json({ ok: true, count });
  });

  router.delete('/api/email/templates', async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'Template name is required.' }); return; }
    const count = await withFileLock(EMAIL_TEMPLATES_PATH, async () => {
      const templates = await readEmailTemplates();
      const filtered = templates.filter((t) => t.name !== name);
      await atomicWriteFile(EMAIL_TEMPLATES_PATH, JSON.stringify(filtered, null, 2));
      return filtered.length;
    });
    res.json({ ok: true, count });
  });

  return router;
}
