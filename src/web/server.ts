import express from 'express';
import * as path from 'path';
import { Ollama } from 'ollama';
import { OllamaClient } from '../core/ollamaClient';
import { queryLoop, type QueryLoopDeps } from '../core/queryLoop';
import { getBuiltinTools } from '../tools';
import { PermissionEngine } from '../permissions/engine';
import { assembleSystemContext } from '../context/assembly';
import type { LoopConfig, PermissionMode } from '../types';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'ui')));

// --- State ---
let currentModel = '';
let permissionMode: PermissionMode = 'dontAsk';
let ollamaHost = 'http://localhost:11434';

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
  res.json({ model: currentModel, permissionMode, ollamaHost });
});

app.post('/api/settings', (req, res) => {
  if (req.body.model) currentModel = req.body.model;
  if (req.body.permissionMode) permissionMode = req.body.permissionMode;
  if (req.body.ollamaHost) ollamaHost = req.body.ollamaHost;
  res.json({ model: currentModel, permissionMode, ollamaHost });
});

// Chat endpoint — runs the agent loop and streams events as SSE
app.post('/api/chat', async (req, res) => {
  const { message, model } = req.body;
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const activeModel = model || currentModel;
  if (!activeModel) {
    res.status(400).json({ error: 'No model selected. Pick a model first.' });
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

  const systemPrompt = await assembleSystemContext({
    systemPrompt: 'You are a helpful AI assistant. You can read files, write files, edit code, run shell commands, and fetch web pages using the tools available to you. Be concise and helpful.',
    projectDir,
  });

  const config: LoopConfig = {
    model: activeModel,
    systemPrompt,
    maxTurns: 25,
  };

  const deps: QueryLoopDeps = {
    client,
    tools,
    permissionCheck: (call) => permissions.evaluateAsync(call),
  };

  const messages = [{ role: 'user' as const, content: message }];

  try {
    for await (const event of queryLoop(config, deps, messages)) {
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
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

// --- Start ---
import * as net from 'net';

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
  // Fall back to OS-assigned port
  return 0;
}

(async () => {
  const preferred = parseInt(process.env.PORT ?? '3000', 10);
  const port = await findAvailablePort(preferred);

  app.listen(port, () => {
    if (port !== preferred) {
      console.log(`\n  ⚠️  Port ${preferred} was in use — using ${port} instead.`);
    }
    console.log(`\n  🤖 Ollama Agent Harness`);
    console.log(`  ───────────────────────`);
    console.log(`  Open in your browser:  http://localhost:${port}`);
    console.log(`  Ollama host:           ${ollamaHost}`);
    console.log(`\n  Press Ctrl+C to stop.\n`);
  });
})();
