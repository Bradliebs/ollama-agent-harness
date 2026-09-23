import express from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { OllamaClient } from '../core/ollamaClient';
import { RateLimiter } from '../core/rateLimiter';
import { getRuntimeTools } from '../tools';
import {
  clearRuntimeRegistry,
  composeDailyBrief,
  composeMermaidGraph,
  ensureCapability,
  eventsFromAmbientSignals,
  eventsFromEvidenceCards,
  getInboundTriageStatus,
  getKnowledgeGraphStatus,
  getMcpServerStatus,
  getRuntimeRegistryStatus,
  getVoiceStatus,
  loadTrustLadder,
  markRuntimeInstalled,
  mergeAndSort,
  mineNextActions,
  readAll as readKnowledgeGraph,
  recordOutcome,
  runCouncilForChat,
  saveRuntimeRegistry,
  saveTrustLadder,
  snapshotDailyBrief,
  startAmbientDaemon,
  type AmbientDaemonHandle,
  type RuntimeFeature,
} from '../jarvis';
import type { SignalBus } from '../nervous/signals';
import { readRunEvidence } from '../persistence/evidenceStore';
import { listLearningCandidates } from '../learning/sessionLearning';

interface SchedulerRegistryLike {
  list: () => Array<{ name: string }>;
  register: (entry: { name: string; stop: () => void; isRunning: () => boolean }) => void;
  unregister: (name: string) => void;
  stop: (name: string) => Promise<unknown>;
  restart: (name: string) => Promise<{ ok?: boolean; error?: string } | unknown>;
}

export interface JarvisRoutesDeps {
  projectDir: string;
  getOllamaHost: () => string;
  getAmbientBus: () => SignalBus;
  getAmbientHandle: () => AmbientDaemonHandle | null;
  setAmbientHandle: (handle: AmbientDaemonHandle | null) => void;
  schedulerRegistry: SchedulerRegistryLike;
  recordSwallowed: (label: string, error: unknown) => void;
  sendTelegramNotification: (title: string, body: string) => Promise<number>;
  getAutoDetectedWhisper: () => { python: string; modelName: string } | null;
  resolveWhisperBridgePath: () => string;
  getAssistantProfile: () => { enabled: boolean; ambient: boolean; proactive: boolean };
}

// Per-IP token bucket on the transcribe route. The route spawns a python
// subprocess and reads up to 50MB of audio per call — a stuck hands-free
// tab could fork-bomb whisper without this. 6 calls/min sustained, with
// burst of 6.
const whisperRateLimiter = new RateLimiter(6, 0.1);

const VALID_RUNTIME_FEATURES = new Set<RuntimeFeature>(['voice_stt', 'voice_tts', 'voice_wake', 'inbound_slack', 'inbound_telegram', 'inbound_email']);

function oneLineForBrief(text: string, max = 80): string {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + '…';
}

function getWhisperHealthSnapshot(autoDetectedWhisper: { python: string; modelName: string } | null): { ok: boolean; mode: 'binary' | 'python' | 'none'; hint: string; source?: 'env' | 'auto-detect' } {
  const binary = process.env.HARNESS_WHISPER_BINARY;
  const model = process.env.HARNESS_WHISPER_MODEL;
  const pythonExe = process.env.HARNESS_WHISPER_PYTHON;
  if (binary && model) {
    return { ok: true, mode: 'binary', hint: `whisper.cpp binary at ${binary}`, source: 'env' };
  }
  if (pythonExe) {
    const modelName = process.env.HARNESS_WHISPER_MODEL_NAME || 'base.en (default)';
    return { ok: true, mode: 'python', hint: `pywhispercpp via ${pythonExe} · model ${modelName}`, source: 'env' };
  }
  if (autoDetectedWhisper) {
    return {
      ok: true,
      mode: 'python',
      hint: `auto-detected: pywhispercpp via ${autoDetectedWhisper.python} · model ${autoDetectedWhisper.modelName}`,
      source: 'auto-detect',
    };
  }
  return {
    ok: false,
    mode: 'none',
    hint: 'Set HARNESS_WHISPER_BINARY+HARNESS_WHISPER_MODEL or HARNESS_WHISPER_PYTHON (+ optional HARNESS_WHISPER_MODEL_NAME). Auto-detect found nothing in well-known locations.',
  };
}

export function createJarvisRouter(deps: JarvisRoutesDeps): express.Router {
  const router = express.Router();

  router.get('/api/jarvis/status', async (_req, res) => {
    try {
      const [trust, knowledge] = await Promise.all([
        loadTrustLadder(deps.projectDir),
        getKnowledgeGraphStatus(deps.projectDir),
      ]);
      const voice = getVoiceStatus();
      const inbound = getInboundTriageStatus();
      const toolList = getRuntimeTools(deps.projectDir);
      const mcp = getMcpServerStatus(toolList.length);
      const ambientHandle = deps.getAmbientHandle();
      res.json({
        generatedAt: new Date().toISOString(),
        workspace: deps.projectDir,
        trustLadder: {
          capabilities: Object.values(trust.capabilities).map((c) => ({
            capability: c.capability,
            rung: c.rung,
            acceptedStreak: c.acceptedStreak,
            rejectedStreak: c.rejectedStreak,
            lastUsedAt: c.lastUsedAt,
          })),
          updatedAt: trust.updatedAt,
        },
        knowledgeGraph: knowledge,
        voice: { ...getVoiceStatus(), whisper: getWhisperHealthSnapshot(deps.getAutoDetectedWhisper()) },
        inbound: getInboundTriageStatus(),
        runtime: getRuntimeRegistryStatus(),
        mcpServer: mcp,
        assistantProfile: deps.getAssistantProfile(),
        schedulers: deps.schedulerRegistry.list(),
        ambient: { ready: true, running: ambientHandle?.isRunning() ?? false, watchers: ambientHandle?.watchersActive() ?? [], note: 'Runs by default under HARNESS_PROFILE=assistant; set HARNESS_AMBIENT_ENABLED=1/0 to force.' },
        predictive: { ready: true, note: 'Predictive engine is pure; feed it ActionEvent[] from sessions.' },
        modelCouncil: { ready: true, note: 'Council is transport-agnostic; wire to OllamaClient or OpenAIClient at the call site.' },
      });
      void voice;
      void inbound;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/jarvis/brief', async (_req, res) => {
    try {
      const [trust, knowledge, candidates, runs] = await Promise.all([
        loadTrustLadder(deps.projectDir),
        getKnowledgeGraphStatus(deps.projectDir),
        listLearningCandidates(deps.projectDir, 20).catch((err) => { deps.recordSwallowed('jarvis.brief.listLearningCandidates', err); return []; }),
        readRunEvidence(deps.projectDir, 50).catch((err) => { deps.recordSwallowed('jarvis.brief.readRunEvidence', err); return []; }),
      ]);
      const ambientSignals = deps.getAmbientBus().recent();
      const pendingLearningCandidates = candidates.map((c) => ({ id: c.id, prompt: c.prompt, outcome: c.outcome, createdAt: c.createdAt }));
      const events = mergeAndSort(eventsFromAmbientSignals(ambientSignals), eventsFromEvidenceCards(runs));
      const predictiveSuggestions = mineNextActions(events, { limit: 8 });
      const evidenceSummaries = runs.slice(0, 10).map((r) => ({ title: oneLineForBrief(r.request), status: r.kind, at: r.createdAt }));
      const markdown = composeDailyBrief({
        asOf: new Date().toISOString(),
        windowDescription: 'since server start',
        ambientSignals,
        pendingLearningCandidates,
        predictiveSuggestions,
        knowledgeGraph: knowledge,
        trustLadder: trust,
        evidenceSummaries,
      });
      res.json({ generatedAt: new Date().toISOString(), markdown, predictiveSuggestions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/jarvis/trust-ladder/promote', async (req, res) => {
    try {
      const capability = String((req.body && (req.body as Record<string, unknown>).capability) ?? '').trim();
      if (!capability) { res.status(400).json({ error: 'capability is required' }); return; }
      const snap = await loadTrustLadder(deps.projectDir);
      ensureCapability(snap, capability);
      const result = recordOutcome(snap, capability, 'accepted');
      await saveTrustLadder(deps.projectDir, snap);
      res.json({ capability, rung: snap.capabilities[capability].rung, promoted: result.promoted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/trust-ladder/demote', async (req, res) => {
    try {
      const capability = String((req.body && (req.body as Record<string, unknown>).capability) ?? '').trim();
      if (!capability) { res.status(400).json({ error: 'capability is required' }); return; }
      const snap = await loadTrustLadder(deps.projectDir);
      ensureCapability(snap, capability);
      const result = recordOutcome(snap, capability, 'rejected');
      await saveTrustLadder(deps.projectDir, snap);
      res.json({ capability, rung: snap.capabilities[capability].rung, demoted: result.demoted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/jarvis/next-suggestion', async (_req, res) => {
    try {
      const runs = await readRunEvidence(deps.projectDir, 50).catch(() => []);
      const events = mergeAndSort(eventsFromAmbientSignals(deps.getAmbientBus().recent()), eventsFromEvidenceCards(runs));
      const suggestions = mineNextActions(events, { limit: 1 });
      res.json({ suggestion: suggestions[0] ?? null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/brief/save', async (_req, res) => {
    try {
      const snap = await snapshotDailyBrief({ projectDir: deps.projectDir, ambientSignals: deps.getAmbientBus().recent(), windowDescription: 'snapshot' });
      const dir = path.join(deps.projectDir, '.harness', 'documents');
      await fs.mkdir(dir, { recursive: true });
      const filename = `jarvis-brief-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, snap.markdown, 'utf-8');
      res.json({ savedTo: path.relative(deps.projectDir, filePath), generatedAt: snap.generatedAt });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/brief/telegram', async (_req, res) => {
    try {
      const snap = await snapshotDailyBrief({ projectDir: deps.projectDir, ambientSignals: deps.getAmbientBus().recent(), windowDescription: 'snapshot' });
      // Telegram caps text length around 4096 chars per message; trim the body
      // and append a marker so the recipient knows there's more in the UI.
      const TELEGRAM_BODY_CAP = 3800;
      const body = snap.markdown.length <= TELEGRAM_BODY_CAP
        ? snap.markdown
        : snap.markdown.slice(0, TELEGRAM_BODY_CAP) + '\n\n…(truncated — open Mission Control for the full brief)';
      const sent = await deps.sendTelegramNotification('Daily Brief', body);
      if (sent === 0) {
        res.status(409).json({ error: 'No Telegram recipients available. Configure HARNESS_TELEGRAM_BOT_TOKEN and have someone send /start to the bot first.' });
        return;
      }
      res.json({ delivered: sent, generatedAt: snap.generatedAt });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/jarvis/ambient', (_req, res) => {
    const ambientHandle = deps.getAmbientHandle();
    res.json({
      running: ambientHandle?.isRunning() ?? false,
      watchers: ambientHandle?.watchersActive() ?? [],
      recentSignalCount: deps.getAmbientBus().recent().length,
    });
  });

  router.post('/api/jarvis/ambient/start', (_req, res) => {
    try {
      const ambientHandle = deps.getAmbientHandle();
      if (ambientHandle?.isRunning()) {
        res.json({ running: true, watchers: ambientHandle.watchersActive(), note: 'already running' });
        return;
      }
      const nextHandle = startAmbientDaemon(deps.getAmbientBus(), {
        watchDir: deps.projectDir,
        fileFilters: ['IMPLEMENTATION_PLAN.md', 'src/', 'cookbook/', '.harness/'],
        gitPollMs: Number(process.env.HARNESS_AMBIENT_GIT_POLL_MS ?? '15000') || 15000,
        schedulerMs: Number(process.env.HARNESS_AMBIENT_SCHEDULER_MS ?? '0') || 0,
        projectDir: deps.projectDir,
      });
      deps.setAmbientHandle(nextHandle);
      deps.schedulerRegistry.register({
        name: 'jarvis-ambient',
        stop: () => { deps.getAmbientHandle()?.stop(); },
        isRunning: () => deps.getAmbientHandle()?.isRunning() ?? false,
      });
      res.json({ running: true, watchers: nextHandle.watchersActive() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/ambient/stop', (_req, res) => {
    try {
      const ambientHandle = deps.getAmbientHandle();
      if (ambientHandle?.isRunning()) ambientHandle.stop();
      deps.setAmbientHandle(null);
      deps.schedulerRegistry.unregister('jarvis-ambient');
      res.json({ running: false });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/schedulers/:name/stop', async (req, res) => {
    try {
      const name = String(req.params.name ?? '');
      if (!deps.schedulerRegistry.list().some((entry) => entry.name === name)) {
        res.status(404).json({ error: `Unknown scheduler: ${name}` });
        return;
      }
      const result = await deps.schedulerRegistry.stop(name);
      res.json({ ok: (result as { ok?: boolean } | undefined)?.ok !== false, result, schedulers: deps.schedulerRegistry.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/schedulers/:name/restart', async (req, res) => {
    try {
      const name = String(req.params.name ?? '');
      if (!deps.schedulerRegistry.list().some((entry) => entry.name === name)) {
        res.status(404).json({ error: `Unknown scheduler: ${name}` });
        return;
      }
      const result = await deps.schedulerRegistry.restart(name) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) {
        res.status(409).json({ error: result.error ?? `Scheduler ${name} is not restartable`, schedulers: deps.schedulerRegistry.list() });
        return;
      }
      res.json({ ok: true, result, schedulers: deps.schedulerRegistry.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/runtime/register', (req, res) => {
    try {
      const feature = String((req.body as Record<string, unknown>)?.feature ?? '') as RuntimeFeature;
      const adapterName = String((req.body as Record<string, unknown>)?.adapterName ?? '').trim();
      if (!VALID_RUNTIME_FEATURES.has(feature)) { res.status(400).json({ error: `feature must be one of ${[...VALID_RUNTIME_FEATURES].join(', ')}` }); return; }
      if (!adapterName) { res.status(400).json({ error: 'adapterName is required' }); return; }
      markRuntimeInstalled(feature, adapterName);
      void saveRuntimeRegistry(deps.projectDir).catch((err) => deps.recordSwallowed('saveRuntimeRegistry', err));
      res.json({ feature, adapterName, status: getRuntimeRegistryStatus() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/jarvis/runtime/clear', (_req, res) => {
    clearRuntimeRegistry();
    void saveRuntimeRegistry(deps.projectDir).catch((err) => deps.recordSwallowed('saveRuntimeRegistry', err));
    res.json({ status: getRuntimeRegistryStatus() });
  });

  router.get('/api/jarvis/voice/health', (_req, res) => {
    res.json(getWhisperHealthSnapshot(deps.getAutoDetectedWhisper()));
  });

  router.post('/api/jarvis/voice/transcribe', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    if (!whisperRateLimiter.tryConsume()) {
      res.status(429).json({
        error: 'Too many transcribe requests — 6/min sustained limit hit.',
        hint: 'A stuck hands-free tab can flood this endpoint. Stop hands-free mode and retry in a minute.',
      });
      return;
    }
    const binary = process.env.HARNESS_WHISPER_BINARY;
    const model = process.env.HARNESS_WHISPER_MODEL;
    const autoDetectedWhisper = deps.getAutoDetectedWhisper();
    const pythonExe = process.env.HARNESS_WHISPER_PYTHON || (autoDetectedWhisper ? autoDetectedWhisper.python : undefined);
    const usePython = !binary && !!pythonExe;
    if (!usePython && (!binary || !model)) {
      res.status(503).json({
        error: 'Whisper not configured.',
        hint: 'Either set HARNESS_WHISPER_BINARY + HARNESS_WHISPER_MODEL (native whisper.cpp), or set HARNESS_WHISPER_PYTHON=python (after pip install pywhispercpp). Auto-detect found nothing.',
      });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Empty audio body. POST a 16kHz mono WAV.' });
      return;
    }
    const tmpDir = path.join(deps.projectDir, '.harness', 'jarvis', 'whisper-tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const wavPath = path.join(tmpDir, `stt-${id}.wav`);
    try {
      await fs.writeFile(wavPath, req.body);
      let cmd: string;
      let args: string[];
      if (usePython) {
        cmd = pythonExe!;
        args = [deps.resolveWhisperBridgePath(), wavPath];
      } else {
        cmd = binary!;
        args = ['-m', model!, '-f', wavPath, '--no-timestamps', '--no-prints'];
      }
      const text = await new Promise<string>((resolve, reject) => {
        // When auto-detect supplied the python path, also inject the model
        // name into the spawned process env so jarvis_whisper.py picks it up
        // without the user setting HARNESS_WHISPER_MODEL_NAME explicitly.
        const childEnv = { ...process.env };
        if (usePython && !process.env.HARNESS_WHISPER_MODEL_NAME && autoDetectedWhisper) {
          childEnv.HARNESS_WHISPER_MODEL_NAME = autoDetectedWhisper.modelName;
        }
        const proc = spawn(cmd, args, { windowsHide: true, env: childEnv });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on('error', (err) => reject(new Error(`Whisper spawn failed: ${err.message}`)));
        proc.on('close', (code: number | null) => {
          if (code !== 0) reject(new Error(`Whisper exited ${code}: ${stderr.trim().slice(0, 240)}`));
          else resolve(stdout.trim());
        });
      });
      res.json({ text, durationMs: 0 });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      fs.unlink(wavPath).catch(() => undefined);
    }
  });

  router.post('/api/jarvis/council/run', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const prompt = String(body.prompt ?? '').trim();
      const mode = String(body.mode ?? 'vote') as 'vote' | 'debate' | 'arbiter';
      const arbiter = typeof body.arbiter === 'string' ? body.arbiter : undefined;
      const memberInput = Array.isArray(body.members) ? (body.members as Array<{ model: string; weight?: number }>) : [];
      if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
      if (memberInput.length === 0) { res.status(400).json({ error: 'members array is required' }); return; }
      if (mode !== 'vote' && !arbiter) { res.status(400).json({ error: `mode "${mode}" requires an arbiter model` }); return; }
      const result = await runCouncilForChat(prompt, {
        mode,
        members: memberInput,
        arbiter,
        perMemberTimeoutMs: 60_000,
      }, (model: string) => new OllamaClient({ model, host: deps.getOllamaHost() }));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/jarvis/graph/mermaid', async (req, res) => {
    try {
      const records = await readKnowledgeGraph(deps.projectDir);
      const focus = typeof req.query.focus === 'string' ? req.query.focus : undefined;
      const mermaid = composeMermaidGraph(records, focus ? { focus } : {});
      res.json({ mermaid });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
