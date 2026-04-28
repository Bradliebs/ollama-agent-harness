import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as net from 'net';
import { Ollama } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { setSkillsDir } from '../tools/skillTools';
import { PermissionEngine } from '../permissions/engine';
import { assembleSystemContext } from '../context/assembly';
import { HookPipeline } from '../extensibility/hookPipeline';
import { loadSkillsDir } from '../extensibility/skillLoader';
import { RateLimiter } from '../core/rateLimiter';
import { logger } from '../core/logger';
import { startNewSession, onSessionEnd, getEvolvedPrompt } from '../learning/engine';
import type { LoopConfig, PermissionMode } from '../types';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'ui')));

const UPLOADS_DIR = path.join(process.cwd(), '.harness', 'uploads');

// --- State ---
let currentModel = '';
let permissionMode: PermissionMode = 'dontAsk';
let ollamaHost = 'http://localhost:11434';
let systemPromptOverride = '';
let temperature = 0.7;
let topP = 0.9;
const rateLimiter = new RateLimiter(10, 2);
const HISTORY_DIR = path.join(process.cwd(), '.harness', 'chat-history');
const SKILLS_DIR = path.join(process.cwd(), '.harness', 'skills');
const hookPipeline = new HookPipeline();

// Initialize skills directory for SkillTool
setSkillsDir(SKILLS_DIR);

// --- API Routes ---

// List available models from Ollama
app.get('/api/models', async (_req, res) => {
  try {
    const ollama = new Ollama({ host: ollamaHost });
    const response = await ollama.list();
    const models = response.models.map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
      family: (m.details as unknown as Record<string, unknown>)?.family ?? '',
      parameterSize: (m.details as unknown as Record<string, unknown>)?.parameter_size ?? '',
    }));
    res.json({ models });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(503).json({ error: `Cannot connect to Ollama: ${msg}` });
  }
});

// Get/set current settings
app.get('/api/settings', (_req, res) => {
  res.json({ model: currentModel, permissionMode, ollamaHost, systemPrompt: systemPromptOverride, temperature, topP });
});

app.post('/api/settings', (req, res) => {
  if (req.body.model !== undefined) currentModel = req.body.model;
  if (req.body.permissionMode !== undefined) permissionMode = req.body.permissionMode;
  if (req.body.ollamaHost !== undefined) ollamaHost = req.body.ollamaHost;
  if (req.body.systemPrompt !== undefined) systemPromptOverride = req.body.systemPrompt;
  if (req.body.temperature !== undefined) temperature = parseFloat(req.body.temperature);
  if (req.body.topP !== undefined) topP = parseFloat(req.body.topP);
  logger.info('Settings', 'Updated', { model: currentModel, permissionMode, temperature, topP });
  res.json({ model: currentModel, permissionMode, ollamaHost, systemPrompt: systemPromptOverride, temperature, topP });
});

// Chat endpoint — runs the agent loop and streams events as SSE
app.post('/api/chat', async (req, res) => {
  const { message, model } = req.body;
  if (!message) { res.status(400).json({ error: 'message is required' }); return; }

  const activeModel = model || currentModel;
  if (!activeModel) { res.status(400).json({ error: 'No model selected.' }); return; }

  if (!rateLimiter.tryConsume()) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = new OllamaClient({ model: activeModel, host: ollamaHost });
  const tools = getBuiltinTools();
  const permissions = new PermissionEngine([], permissionMode);
  const projectDir = process.cwd();

  // Start a new learning session for tracking
  startNewSession();

  const basePrompt = systemPromptOverride ||
    'You are a self-learning AI assistant with full web access and local tool use. IMPORTANT RULES:\n' +
    '1. When the user asks about something on the web (weather, news, docs, prices, etc.), ALWAYS use web_search to find it, then web_read to fetch the actual content. NEVER just suggest links — fetch the data yourself and show the results.\n' +
    '2. You can read files, write files, edit code, run commands, search files with grep, search the web, and read web pages.\n' +
    '3. When you notice a reusable pattern, create a skill. When you learn something important, use the remember tool.\n' +
    '4. Format responses in Markdown.\n' +
    '5. Be direct — do the work, don\'t ask the user to do it themselves.';

  // Use evolved prompt — layers in learned patterns and self-improvements
  const evolvedPrompt = await getEvolvedPrompt(basePrompt);
  const systemPrompt = await assembleSystemContext({ systemPrompt: evolvedPrompt, projectDir, skillsDir: SKILLS_DIR });

  const config: LoopConfig = { model: activeModel, systemPrompt, maxTurns: 25 };

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: (call) => permissions.evaluateAsync(call),
    hooks: hookPipeline,
  };

  const messages = [{ role: 'user' as const, content: message }];
  logger.info('Chat', `User: ${message.slice(0, 80)}`, { model: activeModel });

  try {
    for await (const event of queryLoop(config, deps, messages)) {
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Chat', 'Loop error', { error: msg });
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg, recoverable: false })}\n\n`);
  }

  // Auto-reflection: analyze this session's tool usage (runs silently, non-blocking)
  onSessionEnd().then(({ reflection, newPatterns }) => {
    if (reflection.insights.length > 0) {
      logger.info('Learning', `Session reflection: ${reflection.insights.join('; ')}`);
    }
    if (newPatterns.length > 0) {
      logger.info('Learning', `${newPatterns.length} patterns ready for skill promotion`);
    }
  }).catch(() => {});

  res.write('data: [DONE]\n\n');
  res.end();
});

// Pull a model from Ollama
app.post('/api/models/pull', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: 'model name is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  try {
    const ollama = new Ollama({ host: ollamaHost });
    const stream = await ollama.pull({ model: name, stream: true });
    for await (const progress of stream) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// --- API: Chat History ---
app.get('/api/history', async (_req, res) => {
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

app.get('/api/history/:id', async (req, res) => {
  try {
    const raw = await fs.readFile(path.join(HISTORY_DIR, `${req.params.id}.json`), 'utf-8');
    res.json(JSON.parse(raw));
  } catch { res.status(404).json({ error: 'Chat not found' }); }
});

app.post('/api/history', async (req, res) => {
  const { id, title, messages, date } = req.body;
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const chatId = id || Date.now().toString(36);
    await fs.writeFile(path.join(HISTORY_DIR, `${chatId}.json`), JSON.stringify({ title, messages, date: date || new Date().toISOString() }, null, 2));
    res.json({ id: chatId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    await fs.unlink(path.join(HISTORY_DIR, `${req.params.id}.json`));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// --- API: Skills ---
app.get('/api/skills', async (_req, res) => {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const skills = await loadSkillsDir(SKILLS_DIR);
    res.json({ skills: skills.map(s => ({ name: s.name, description: s.description, domain: s.domain, triggers: s.triggers, filePath: s.filePath })) });
  } catch { res.json({ skills: [] }); }
});

app.get('/api/skills/:name', async (req, res) => {
  try {
    const skills = await loadSkillsDir(SKILLS_DIR);
    const skill = skills.find(s => s.name === req.params.name);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
    res.json(skill);
  } catch { res.status(500).json({ error: 'Failed to load skill' }); }
});

app.delete('/api/skills/:name', async (req, res) => {
  try {
    const skillDir = path.join(SKILLS_DIR, req.params.name);
    await fs.rm(skillDir, { recursive: true });
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Skill not found' }); }
});

// --- API: Agent Memory ---
app.get('/api/memory', async (_req, res) => {
  const memDir = path.join(process.cwd(), '.harness', 'memory');
  const result: Record<string, string> = {};
  for (const file of ['decisions.md', 'patterns.md', 'notes.md']) {
    try {
      result[file.replace('.md', '')] = await fs.readFile(path.join(memDir, file), 'utf-8');
    } catch { /* not yet created */ }
  }
  res.json(result);
});

// --- API: Learning ---
app.get('/api/learning', async (_req, res) => {
  const learningDir = path.join(process.cwd(), '.harness', 'learning');
  const result: Record<string, unknown> = {};
  try {
    result.patterns = JSON.parse(await fs.readFile(path.join(learningDir, 'detected-patterns.json'), 'utf-8'));
  } catch { result.patterns = []; }
  try {
    const raw = await fs.readFile(path.join(learningDir, 'reflections.jsonl'), 'utf-8');
    result.reflections = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-20);
  } catch { result.reflections = []; }
  try {
    result.evolvedPrompt = await fs.readFile(path.join(learningDir, 'evolved-prompt.md'), 'utf-8');
  } catch { result.evolvedPrompt = ''; }
  try {
    result.digest = await fs.readFile(path.join(learningDir, 'consolidated-digest.md'), 'utf-8');
  } catch { result.digest = ''; }
  try {
    const raw = await fs.readFile(path.join(learningDir, 'tool-usage.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    result.totalToolCalls = lines.length;
    // Tool usage breakdown
    const counts: Record<string, number> = {};
    for (const line of lines) { try { const e = JSON.parse(line); counts[e.tool] = (counts[e.tool] || 0) + 1; } catch {} }
    result.toolBreakdown = counts;
  } catch { result.totalToolCalls = 0; result.toolBreakdown = {}; }
  res.json(result);
});

// --- API: File Upload ---
app.post('/api/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const filename = req.headers['x-filename'] as string;
  if (!filename) { res.status(400).json({ error: 'x-filename header required' }); return; }

  // Sanitize filename — strip path traversal
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) { res.status(400).json({ error: 'Invalid filename' }); return; }

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const dest = path.join(UPLOADS_DIR, safe);
    await fs.writeFile(dest, req.body);
    logger.info('Upload', `File saved: ${safe} (${req.body.length} bytes)`);
    res.json({ path: dest, name: safe, size: req.body.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/uploads', async (_req, res) => {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
    const files = [];
    for (const e of entries.filter(e => e.isFile())) {
      const stat = await fs.stat(path.join(UPLOADS_DIR, e.name));
      files.push({ name: e.name, path: path.join(UPLOADS_DIR, e.name), size: stat.size, modified: stat.mtime.toISOString() });
    }
    res.json({ files });
  } catch { res.json({ files: [] }); }
});

app.delete('/api/uploads/:name', async (req, res) => {
  const safe = path.basename(req.params.name);
  try {
    await fs.unlink(path.join(UPLOADS_DIR, safe));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// --- API: File Tree ---
app.get('/api/files', async (req, res) => {
  const dir = (req.query.path as string) || process.cwd();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: path.join(dir, e.name) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ items, cwd: dir });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: msg });
  }
});

// --- Start ---

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(preferred: number, maxAttempts: number = 20): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferred + i;
    if (await isPortAvailable(port)) return port;
  }
  return 0;
}

function openBrowser(url: string): void {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors */ });
}

(async () => {
  const preferred = parseInt(process.env.PORT ?? '3000', 10);
  const port = await findAvailablePort(preferred);

  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    if (port !== preferred) {
      console.log(`\n  ⚠️  Port ${preferred} was in use — using ${port} instead.`);
    }
    console.log(`\n  🤖 Ollama Agent Harness`);
    console.log(`  ───────────────────────`);
    console.log(`  Open in your browser:  ${url}`);
    console.log(`  Ollama host:           ${ollamaHost}`);
    console.log(`\n  Press Ctrl+C to stop.\n`);

    if (process.env.NO_OPEN !== '1') {
      openBrowser(url);
    }
  });
})();
