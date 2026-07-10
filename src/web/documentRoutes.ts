import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;
function safeLocalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (!SAFE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export interface DocumentRoutesDeps {
  projectDir: string;
  localDocumentConverters: () => Promise<{ pandoc: boolean }>;
  normalizeDocumentTemplate: (value: unknown) => unknown;
  normalizeDocumentFormat: (value: unknown) => unknown;
  createGeneratedDocument: (input: {
    title: string;
    template: unknown;
    format: unknown;
    sourceLabel: string;
    content: string;
    evidence?: unknown;
  }) => Promise<{ metadata: { format: string; filename: string }; content: string }>;
}

export function createDocumentRouter(deps: DocumentRoutesDeps): express.Router {
  const router = express.Router();
  const DOCUMENTS_DIR = path.join(deps.projectDir, '.harness', 'documents');

  router.get('/api/documents/formats', async (_req, res) => {
    try {
      const converters = await deps.localDocumentConverters();
      res.json({ formats: { markdown: { available: true }, html: { available: true }, pdf: { available: converters.pandoc, converter: 'pandoc' }, docx: { available: converters.pandoc, converter: 'pandoc' } } });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/documents', async (_req, res) => {
    try {
      await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
      const files = await fs.readdir(DOCUMENTS_DIR, { withFileTypes: true });
      const documents: Array<Record<string, unknown>> = [];
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(DOCUMENTS_DIR, file.name), 'utf-8')) as Record<string, unknown>;
          documents.push(metadata);
        } catch { /* ignore corrupt metadata */ }
      }
      documents.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      res.json({ documents });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/documents/generate', async (req, res) => {
    try {
      const title = String(req.body?.title || 'Harness Document').trim().slice(0, 160) || 'Harness Document';
      const template = deps.normalizeDocumentTemplate(req.body?.template);
      const format = deps.normalizeDocumentFormat(req.body?.format);
      const sourceLabel = String(req.body?.sourceLabel || 'Harness chat').trim().slice(0, 120) || 'Harness chat';
      const content = String(req.body?.content || '').slice(0, 200_000);
      const evidence = req.body?.evidence && typeof req.body.evidence === 'object' ? req.body.evidence : undefined;
      const document = await deps.createGeneratedDocument({ title, template, format, sourceLabel, content, evidence });
      res.json({ ok: true, document: document.metadata, content: document.content });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/documents/:id/download', async (req, res) => {
    const id = safeLocalId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Invalid document id.' }); return; }
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(DOCUMENTS_DIR, `${id}.json`), 'utf-8')) as { format: string; filename: string };
      const filePath = path.join(DOCUMENTS_DIR, metadata.filename);
      const raw = await fs.readFile(filePath);
      const contentType = metadata.format === 'html' ? 'text/html; charset=utf-8' : metadata.format === 'pdf' ? 'application/pdf' : metadata.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
      res.send(raw);
    } catch {
      res.status(404).json({ error: 'Document not found.' });
    }
  });

  return router;
}
