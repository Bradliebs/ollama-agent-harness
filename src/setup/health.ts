import { Ollama } from 'ollama';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AudioTranscribeTool } from '../tools/multimodalTools';
import { findInstalledVisionModel, isCloudModelName } from '../models/visionModels';
import { PdfReadTool } from '../tools/pdfTool';
import { createBuiltinToolRegistry } from '../tools/registry';
import { OPENAI_COMPATIBLE_PRESETS, REPLICATE_PRESET, readApiKey } from '../core/chatClientFactory';
import { FALLBACK_COOLDOWN_MS } from '../core/fallbackChatClient';
import { loadSynthesisStats, adaptiveMaxTurns } from '../core/synthesisStats';

export interface SetupHealthInput {
  host: string;
  visionModel: string;
  audioTranscribeCommand: string;
  audioSamplePath?: string;
  pdfOcrCommand?: string;
  projectDir?: string;
}

export interface LocalHealthCheck {
  ok: boolean;
  message: string;
}

export interface BackendHealthCheck {
  /** Backend identifier matching HARNESS_BACKEND values (cerebras, groq, github, ...). */
  id: string;
  /** Human-readable provider label. */
  label: string;
  /** True when an API key is present in one of the configured env vars. */
  ok: boolean;
  /** Status message shown by the doctor. */
  message: string;
  /** Env var that supplied the key, if any. Useful for debugging precedence. */
  apiKeyEnvVar?: string;
  /**
   * Number of keys parsed from the env var (1 for a single key, >1 for a
   * comma-separated credential pool). Reports count only — never the keys
   * themselves, which would leak via the doctor output.
   */
  keyCount?: number;
  /** Optional signup link for missing keys. */
  signupUrl?: string;
}

export interface SetupHealthResult {
  ollama: { ok: boolean; message: string; modelCount: number };
  vision: { ok: boolean; message: string };
  audio: { ok: boolean; message: string };
  pdfOcr?: { ok: boolean; message: string };
  local: {
    node: LocalHealthCheck;
    package: LocalHealthCheck;
    sessions: LocalHealthCheck;
    tools: LocalHealthCheck;
    automations: LocalHealthCheck;
    mycelium: LocalHealthCheck;
  };
  /**
   * Auth check for each known OpenAI-compatible backend preset.
   * Reports one entry per preset so the doctor surfaces "key present /
   * not present" without making a network call. Backends that require a
   * subscription still appear here as `ok: true` if the key is set; the
   * subscription gate only triggers on actual chat calls.
   */
  backends: BackendHealthCheck[];
  /** Fallback routing configuration for remote providers. */
  fallback: FallbackRoutingConfig;
  /** SMTP email configuration status. */
  smtp: { ok: boolean; message: string };
  /** Per-model synthesis turn statistics (optional, populated when stats file exists). */
  synthesisStats?: Record<string, { fired: number; total: number; adaptiveMaxTurns: number }>;
}

export interface FallbackRoutingConfig {
  /** Whether auto-fallback is enabled (HARNESS_REMOTE_AUTO_FALLBACK !== '0'). */
  enabled: boolean;
  /** Cooldown window in ms after a backend hits a limit error. */
  cooldownMs: number;
  /** Configured fallback order, or 'default' if using the built-in order. */
  order: string;
  /** Number of backends with a configured API key. */
  configuredCount: number;
}

export async function checkSetupHealth(input: SetupHealthInput): Promise<SetupHealthResult> {
  const audio = await checkAudioHealth(input.audioTranscribeCommand, input.audioSamplePath);
  const pdfOcr = await checkPdfOcrHealth(input.pdfOcrCommand);
  const local = await checkLocalHealth(input.projectDir ?? process.cwd());
  const backends = checkBackendAuth();
  const fallback = checkFallbackConfig(backends);
  const smtp = checkSmtpConfig();
  const rawStats = await loadSynthesisStats(input.projectDir ?? process.cwd());
  const synthesisStats: Record<string, { fired: number; total: number; adaptiveMaxTurns: number }> = {};
  for (const [model, record] of Object.entries(rawStats)) {
    synthesisStats[model] = { ...record, adaptiveMaxTurns: adaptiveMaxTurns(rawStats, model, 25) };
  }
  try {
    const response = await new Ollama({ host: input.host }).list();
    const modelNames = response.models.map((model) => model.name);
    const matchingVisionModel = input.visionModel
      ? (isCloudModelName(input.visionModel) || modelNames.some((name) => name === input.visionModel || name.startsWith(`${input.visionModel}:`)))
      : false;
    const detectedVisionModel = input.visionModel ? '' : findInstalledVisionModel(modelNames);
    return {
      ollama: {
        ok: true,
        message: modelNames.length > 0 ? `Connected to Ollama with ${modelNames.length} model(s).` : 'Connected to Ollama, but no models are installed.',
        modelCount: modelNames.length,
      },
      vision: input.visionModel
        ? {
          ok: matchingVisionModel,
          message: matchingVisionModel
            ? (isCloudModelName(input.visionModel) && !modelNames.some((name) => name === input.visionModel)
              ? `Vision model '${input.visionModel}' is a cloud model (resolved remotely).`
              : `Vision model '${input.visionModel}' is installed.`)
            : `Vision model '${input.visionModel}' was not found in Ollama.`,
        }
        : detectedVisionModel
          ? { ok: true, message: `Auto-detected vision model '${detectedVisionModel}'.` }
          : { ok: false, message: 'No vision model configured and no installed vision model was auto-detected.' },
      audio,
      pdfOcr,
      local,
      backends,
      fallback,
      smtp,
      ...(Object.keys(synthesisStats).length > 0 ? { synthesisStats } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ollama: { ok: false, message: `Cannot connect to Ollama: ${message}`, modelCount: 0 },
      vision: input.visionModel ? { ok: false, message: 'Vision model could not be checked because Ollama is unavailable.' } : { ok: false, message: 'No vision model configured.' },
      audio,
      pdfOcr,
      local,
      backends,
      fallback,
      smtp,
      ...(Object.keys(synthesisStats).length > 0 ? { synthesisStats } : {}),
    };
  }
}

/**
 * Inspect process.env to determine which remote backends have a
 * key configured. No network calls are made here — actual chat health is
 * exercised by the agent loop on first use, and we want `harness doctor`
 * to be fast and offline-safe.
 */
function checkBackendAuth(): BackendHealthCheck[] {
  const checks: BackendHealthCheck[] = [];
  for (const [id, preset] of [...Object.entries(OPENAI_COMPATIBLE_PRESETS), ['replicate', REPLICATE_PRESET] as const]) {
    const key = readApiKey(preset);
    if (key) {
      const sourceEnv = preset.apiKeyEnvVars.find((name) => process.env[name] && process.env[name]!.trim().length > 0);
      // Count credential-pool entries without ever surfacing the keys
      // themselves. A single key reports as 1, a comma-separated list
      // reports its parsed count.
      const keyCount = key.split(',').map((k) => k.trim()).filter(Boolean).length;
      const poolNote = keyCount > 1 ? ` (pool of ${keyCount} keys)` : '';
      checks.push({
        id,
        label: preset.label,
        ok: true,
        message: `API key configured (via ${sourceEnv})${poolNote}.`,
        apiKeyEnvVar: sourceEnv,
        keyCount,
        signupUrl: preset.signupUrl,
      });
    } else {
      const envVarList = preset.apiKeyEnvVars.join(' or ');
      checks.push({
        id,
        label: preset.label,
        ok: false,
        message: `No API key. Set ${envVarList}${preset.signupUrl ? ` (get one at ${preset.signupUrl})` : ''}.`,
        signupUrl: preset.signupUrl,
      });
    }
  }
  return checks;
}

function checkFallbackConfig(backends: BackendHealthCheck[]): FallbackRoutingConfig {
  const enabled = process.env.HARNESS_REMOTE_AUTO_FALLBACK !== '0';
  const configuredOrder = (process.env.HARNESS_REMOTE_FALLBACK_ORDER || '').trim();
  return {
    enabled,
    cooldownMs: FALLBACK_COOLDOWN_MS,
    order: configuredOrder || 'default',
    configuredCount: backends.filter((b) => b.ok).length,
  };
}

function checkSmtpConfig(): { ok: boolean; message: string } {
  const host = process.env.HARNESS_SMTP_HOST?.trim();
  const user = process.env.HARNESS_SMTP_USER?.trim();
  const pass = process.env.HARNESS_SMTP_PASS?.trim();
  const from = process.env.HARNESS_SMTP_FROM?.trim();
  if (!host || !user || !pass) {
    const missing: string[] = [];
    if (!host) missing.push('HARNESS_SMTP_HOST');
    if (!user) missing.push('HARNESS_SMTP_USER');
    if (!pass) missing.push('HARNESS_SMTP_PASS');
    return { ok: false, message: `SMTP not configured. Missing: ${missing.join(', ')}.` };
  }
  const port = process.env.HARNESS_SMTP_PORT?.trim() || '587';
  return { ok: true, message: `SMTP configured: ${host}:${port} as ${from || user}.` };
}

async function checkLocalHealth(projectDir: string): Promise<SetupHealthResult['local']> {
  const packagePath = path.join(projectDir, 'package.json');
  const sessionsDir = path.join(projectDir, '.harness', 'sessions');
  const automationsDir = path.join(projectDir, '.harness', 'automations');
  const registry = createBuiltinToolRegistry();
  return {
    node: checkNodeVersion(),
    package: await checkPackage(packagePath),
    sessions: await checkWritableDirectory(sessionsDir, 'Session storage is writable.'),
    tools: { ok: registry.listTools().length > 0, message: `${registry.listTools().length} built-in tool(s) across ${registry.listToolsets().length} toolset(s).` },
    automations: await checkWritableDirectory(automationsDir, 'Automation storage is writable.'),
    mycelium: await checkMyceliumHealth(projectDir),
  };
}

async function checkMyceliumHealth(projectDir: string): Promise<LocalHealthCheck> {
  // Lazy-load to avoid importing the mycelium module unless health checks run.
  try {
    const { loadMyceliumGraph } = await import('../mycelium/graph');
    const graph = await loadMyceliumGraph(projectDir);
    const stats = graph.stats();
    if (stats.nodes === 0) {
      return { ok: true, message: 'Mycelium graph is empty (run `harness mycelium seed` to populate).' };
    }
    const recent = graph.listEpisodes(20);
    const avgReward = recent.length > 0
      ? recent.reduce((sum, e) => sum + e.reward, 0) / recent.length
      : 0;
    return {
      ok: true,
      message: `${stats.nodes} nodes, ${stats.edges} edges (${stats.protectedEdges} protected, ${stats.archivedEdges} archived), avg reward ${avgReward.toFixed(2)} over last ${recent.length} episode(s).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cannot read mycelium graph: ${message}` };
  }
}

function checkNodeVersion(): LocalHealthCheck {
  const major = Number(process.versions.node.split('.')[0]);
  return Number.isFinite(major) && major >= 20
    ? { ok: true, message: `Node ${process.versions.node}` }
    : { ok: false, message: `Node ${process.versions.node}; Node 20+ is recommended.` };
}

async function checkPackage(packagePath: string): Promise<LocalHealthCheck> {
  try {
    const parsed = JSON.parse(await fs.readFile(packagePath, 'utf-8')) as { name?: string; scripts?: Record<string, string> };
    const hasValidation = Boolean(parsed.scripts?.test && (parsed.scripts.typecheck || parsed.scripts.lint));
    return {
      ok: hasValidation,
      message: hasValidation ? `${parsed.name ?? 'package'} has test and typecheck scripts.` : 'package.json is missing test or typecheck scripts.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cannot read package.json: ${message}` };
  }
}

async function checkWritableDirectory(dirPath: string, okMessage: string): Promise<LocalHealthCheck> {
  const probe = path.join(dirPath, '.doctor-probe');
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(probe, 'ok', 'utf-8');
    await fs.rm(probe, { force: true });
    return { ok: true, message: okMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Directory is not writable: ${message}` };
  }
}

async function checkAudioHealth(audioCommand: string, audioSamplePath?: string): Promise<{ ok: boolean; message: string }> {
  if (!audioCommand) return { ok: false, message: 'No audio transcription command configured.' };
  if (!audioSamplePath) return { ok: true, message: 'Audio transcription command is configured. Add a sample file path to run an end-to-end transcription check.' };

  const originalCommand = process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
  try {
    process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = audioCommand;
    const result = await AudioTranscribeTool.execute({ path: audioSamplePath });
    if (!result.success) return { ok: false, message: result.output || 'Audio transcription sample check failed.' };
    const preview = result.output.trim().replace(/\s+/g, ' ').slice(0, 120);
    return { ok: true, message: preview ? `Audio sample transcribed: ${preview}` : 'Audio sample transcribed successfully.' };
  } finally {
    if (originalCommand === undefined) delete process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    else process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND = originalCommand;
  }
}

async function checkPdfOcrHealth(pdfOcrCommand?: string): Promise<{ ok: boolean; message: string }> {
  if (!pdfOcrCommand) return { ok: false, message: 'No PDF OCR command configured.' };
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-pdf-doctor-'));
  const pdfPath = path.join(tmpDir, 'probe.pdf');
  const projectRel = path.relative(process.cwd(), pdfPath);
  const insideProject = !projectRel.startsWith('..') && !path.isAbsolute(projectRel);
  const originalCommand = process.env.HARNESS_PDF_OCR_COMMAND;
  try {
    await fs.writeFile(pdfPath, buildSyntheticPdf('Harness OCR probe'));
    if (!insideProject) {
      return { ok: true, message: 'PDF OCR command is configured. (Skipped end-to-end probe because the temp file is outside the project directory.)' };
    }
    process.env.HARNESS_PDF_OCR_COMMAND = pdfOcrCommand;
    const result = await PdfReadTool.execute({ path: projectRel, ocr: true });
    if (!result.success) return { ok: false, message: result.output || 'PDF OCR probe failed.' };
    return { ok: true, message: 'PDF OCR command executed successfully on a synthetic probe.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `PDF OCR probe failed: ${message}` };
  } finally {
    if (originalCommand === undefined) delete process.env.HARNESS_PDF_OCR_COMMAND;
    else process.env.HARNESS_PDF_OCR_COMMAND = originalCommand;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildSyntheticPdf(text: string): Buffer {
  // Minimal single-page PDF with one text string. Sufficient as an OCR probe input.
  const safe = text.replace(/[\\()]/g, '');
  const stream = `BT /F1 24 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) { offsets.push(Buffer.byteLength(pdf)); pdf += obj + '\n'; }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}
