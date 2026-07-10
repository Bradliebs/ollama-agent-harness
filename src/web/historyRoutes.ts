import express from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
function safeLocalId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id.length > 0 && SAFE_ID_PATTERN.test(id) ? id : null;
}

export interface HistoryRoutesDeps {
  projectDir: string;
}

export function createHistoryRouter(deps: HistoryRoutesDeps): express.Router {
  const router = express.Router();
  const HISTORY_DIR = path.join(deps.projectDir, '.harness', 'chat-history');

  router.get('/api/history', async (_req, res) => {
    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });
      const files = await fs.readdir(HISTORY_DIR);
      const chats = [];
      for (const f of files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, 50)) {
        try {
          const raw = await fs.readFile(path.join(HISTORY_DIR, f), 'utf-8');
          const data = JSON.parse(raw);
          chats.push({ id: f.replace('.json', ''), title: data.title ?? 'Untitled', date: data.date, messageCount: data.messages?.length ?? 0 });
        } catch { /* skip corrupt */ }
      }
      res.json({ chats });
    } catch { res.json({ chats: [] }); }
  });

  router.get('/api/history/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (!q) { res.json({ results: [] }); return; }
    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });
      const files = (await fs.readdir(HISTORY_DIR)).filter(f => f.endsWith('.json')).sort().reverse();
      const results: Array<{ id: string; title: string; date: string; snippet: string; matchCount: number }> = [];
      for (const f of files) {
        try {
          const raw = await fs.readFile(path.join(HISTORY_DIR, f), 'utf-8');
          const data = JSON.parse(raw);
          const title: string = data.title ?? 'Untitled';
          const messages: Array<{ role: string; content: string }> = data.messages ?? [];
          let snippet = '';
          let matchCount = 0;
          if (title.toLowerCase().includes(q)) { matchCount++; snippet = title; }
          for (const m of messages) {
            const text = String(m.content ?? '');
            const idx = text.toLowerCase().indexOf(q);
            if (idx !== -1) {
              matchCount++;
              if (!snippet) {
                const start = Math.max(0, idx - 40);
                const end = Math.min(text.length, idx + q.length + 80);
                snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
              }
            }
          }
          if (matchCount > 0) {
            results.push({ id: f.replace('.json', ''), title, date: data.date ?? '', snippet, matchCount });
          }
        } catch { /* skip corrupt */ }
      }
      results.sort((a, b) => b.matchCount - a.matchCount);
      res.json({ results: results.slice(0, 30) });
    } catch { res.json({ results: [] }); }
  });

  router.get('/api/history/:id', async (req, res) => {
    try {
      const chatId = safeLocalId(req.params.id);
      if (!chatId) { res.status(400).json({ error: 'Invalid chat id.' }); return; }
      const raw = await fs.readFile(path.join(HISTORY_DIR, `${chatId}.json`), 'utf-8');
      res.json(JSON.parse(raw));
    } catch { res.status(404).json({ error: 'Chat not found' }); }
  });

  router.post('/api/history', async (req, res) => {
    const { id, title, messages, date } = req.body;
    try {
      await fs.mkdir(HISTORY_DIR, { recursive: true });
      const chatId = safeLocalId(id) || Date.now().toString(36);
      await fs.writeFile(path.join(HISTORY_DIR, `${chatId}.json`), JSON.stringify({ title, messages, date: date || new Date().toISOString() }, null, 2));
      res.json({ id: chatId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/api/history/:id', async (req, res) => {
    try {
      const chatId = safeLocalId(req.params.id);
      if (!chatId) { res.status(400).json({ error: 'Invalid chat id.' }); return; }
      await fs.unlink(path.join(HISTORY_DIR, `${chatId}.json`));
      res.json({ ok: true });
    } catch { res.status(404).json({ error: 'Not found' }); }
  });

  return router;
}
