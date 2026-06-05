import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Ollama } from 'ollama';
import type { Tool, ToolResult } from '../types';
import { findInstalledVisionModel, isVisionCapableModelName } from '../models/visionModels';
import { resolveProjectReadPath } from './pathResolution';

const MAX_IMAGE_BYTES = 10_000_000;
const MAX_TRANSCRIPT_CHARS = 50_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export const ImageAnalyzeTool: Tool = {
  name: 'image_analyze',
  description: 'Analyze a local image with an Ollama vision-capable model. Use this for attached image files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to an image file' },
      prompt: { type: 'string', description: 'Question or instruction for the image analysis' },
      model: { type: 'string', description: 'Vision-capable Ollama model to use, for example llava or qwen2-vl' },
      host: { type: 'string', description: 'Optional Ollama host URL' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectReadPath(input.path);
    if (!filePath) return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    if (!isImagePath(filePath)) return { success: false, output: 'File does not look like a supported image type.', error: 'unsupported image type' };
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_IMAGE_BYTES) {
        return { success: false, output: `Image exceeds ${MAX_IMAGE_BYTES} bytes.`, error: 'image too large' };
      }
      const image = await fs.readFile(filePath);
      const client = new Ollama({ host: sanitizeString(input.host) || process.env.OLLAMA_HOST || 'http://localhost:11434' });
      const model = await resolveVisionModel(input, client);
      if (!model) {
        return { success: false, output: 'No vision model was provided and no installed Ollama vision model could be auto-detected. Set HARNESS_VISION_MODEL to a model such as llava:latest.', error: 'missing vision model' };
      }
      const response = await client.chat({
        model,
        stream: false as const,
        messages: [{
          role: 'user',
          content: sanitizeString(input.prompt) || 'Describe this image and call out details relevant to the user request.',
          images: [image.toString('base64')],
        } as never],
      });
      return { success: true, output: response.message?.content || '(empty image analysis response)' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Image analysis failed: ${msg}`, error: msg };
    }
  },
};

async function resolveVisionModel(input: Record<string, unknown>, client: Ollama): Promise<string> {
  const configuredModel = sanitizeString(input.model) || process.env.HARNESS_VISION_MODEL || '';
  // List installed models once — used both as a validity check on the
  // configured/selected model AND as a fallback source when nothing
  // explicit is set. Without this validation, a configured model that
  // isn't actually installed (e.g. settings carries `qwen2-vl` but only
  // `llava` is pulled) sends every image_analyze call to its death.
  let installed: string[] = [];
  try {
    const response = await client.list();
    installed = response.models.map((model) => model.name);
  } catch {
    // If we can't list, fall back to the configured value as a best-effort.
    if (configuredModel) return configuredModel;
    return '';
  }
  const isInstalled = (name: string): boolean => {
    if (!name) return false;
    if (installed.includes(name)) return true;
    // Ollama tags models as "name:tag"; accept a configured bare name
    // when any installed model shares the same prefix.
    const bare = name.split(':')[0];
    return installed.some((entry) => entry === bare || entry.startsWith(`${bare}:`));
  };
  if (configuredModel && isInstalled(configuredModel)) return configuredModel;
  const selectedModel = sanitizeString(process.env.OLLAMA_MODEL);
  if (selectedModel && isVisionCapableModelName(selectedModel) && isInstalled(selectedModel)) return selectedModel;
  // Configured/selected model wasn't installed. Auto-fall-back to whichever
  // vision-capable model IS installed so the call succeeds instead of
  // looping with `model not found`.
  return findInstalledVisionModel(installed) ?? '';
}

export const AudioTranscribeTool: Tool = {
  name: 'audio_transcribe',
  description: 'Transcribe a local audio file using HARNESS_AUDIO_TRANSCRIBE_COMMAND. Use this for attached audio files before analysis.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to an audio file' },
    },
    required: ['path'],
  },
  isReadOnly: false,
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolveProjectReadPath(input.path);
    if (!filePath) return { success: false, output: 'Path is outside the project directory', error: 'path outside project' };
    // Precedence: an explicitly configured command always wins. When none
    // is set, fall back to auto-detecting an OpenAI Whisper install on PATH
    // so audio "just works" after `pip install openai-whisper` with no env
    // var to configure (mirrors how image_analyze auto-detects vision models).
    const commandTemplate = process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND?.trim() || resolveDefaultAudioCommand();
    if (!commandTemplate) {
      return {
        success: false,
        output: 'Audio transcription needs a one-time setup. Easiest: install OpenAI Whisper with "pip install -U openai-whisper" and it is auto-detected on PATH next time. Otherwise set HARNESS_AUDIO_TRANSCRIBE_COMMAND to a command containing {input}, for example: whisper "{input}" --model base --output_format txt --output_dir .',
        error: 'missing transcription command',
      };
    }

    try {
      await fs.stat(filePath);
      const { command, args } = buildCommand(commandTemplate, filePath);
      const transcript = await runTranscriptCommand(command, args);
      const output = transcript.length > MAX_TRANSCRIPT_CHARS
        ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n...(truncated)'
        : transcript;
      return { success: true, output: output || '(empty transcript)' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Audio transcription failed: ${msg}`, error: msg };
    }
  },
};

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const WHISPER_EXECUTABLE_CANDIDATES = process.platform === 'win32'
  ? ['whisper.exe', 'whisper']
  : ['whisper'];

/**
 * Best-effort zero-config audio setup: when no transcription command is
 * configured, locate an OpenAI Whisper executable on PATH and return a
 * ready-to-run command template. Output files are routed to the OS temp
 * directory so transcription never litters the project; the transcript
 * itself is captured from Whisper's stdout. Returns null when no Whisper
 * is found so callers can show setup guidance instead. `HARNESS_WHISPER_BIN`
 * overrides PATH discovery with an explicit executable path.
 */
export function resolveDefaultAudioCommand(): string | null {
  const override = process.env.HARNESS_WHISPER_BIN?.trim();
  const whisper = override && existsSync(override)
    ? override
    : findExecutableOnPath(WHISPER_EXECUTABLE_CANDIDATES);
  if (!whisper) return null;
  const outputDir = os.tmpdir();
  return `"${whisper}" "{input}" --model base --output_format txt --output_dir "${outputDir}"`;
}

function findExecutableOnPath(candidates: string[]): string | null {
  const pathValue = process.env.PATH || process.env.Path || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function sanitizeString(value: unknown): string {
  return String(value ?? '').trim().slice(0, 2000);
}

function buildCommand(template: string, inputPath: string): { command: string; args: string[] } {
  const parts = splitCommandLine(template.replaceAll('{input}', inputPath));
  if (parts.length === 0) throw new Error('Transcription command is empty');
  return { command: parts[0], args: parts.slice(1) };
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if ((char === '"' || char === "'") && !quote) { quote = char; continue; }
    if (char === quote) { quote = null; continue; }
    if (/\s/.test(char) && !quote) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function runTranscriptCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: MAX_TRANSCRIPT_CHARS * 4 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout.trim() || stderr.trim());
    });
  });
}
