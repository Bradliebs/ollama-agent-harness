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
import type { LoopConfig, PermissionMode } from '../types';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'ui')));

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

  const basePrompt = systemPromptOverride ||
    'You are a helpful AI assistant. You can read files, write files, edit code, run shell commands, search files with grep, and fetch web pages using the tools available to you. Format your responses using Markdown.';

  const systemPrompt = await assembleSystemContext({ systemPrompt: basePrompt, projectDir, skillsDir: SKILLS_DIR });

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
