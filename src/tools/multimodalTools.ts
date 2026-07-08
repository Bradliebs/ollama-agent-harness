import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Ollama } from 'ollama';
import type { Tool, ToolResult } from '../types';
import { findInstalledVisionModel, isVisionCapableModelName, isVisionModelUsable } from '../models/visionModels';
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
        return { success: false, output: 'No vision model was provided and no installed Ollama vision model could be auto-detected. Set HARNESS_VISION_MODEL to a vision model — a local one such as llava:latest, or a cloud one such as minimax-m3:cloud.', error: 'missing vision model' };
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
  // List installed models once. Used both to validate the configured/selected
  // model AND as the fallback source for auto-detection. Cloud models (`:cloud`)
  // are resolved remotely and never appear here, so they are handled via
  // isVisionModelUsable instead of requiring a local-install match.
  let installed: string[] = [];
  let listed = false;
  try {
    const response = await client.list();
    installed = (response.models ?? []).map((model) => model.name);
    listed = true;
  } catch {
    // Listing failed (Ollama unreachable). Fall through: an explicitly
    // configured model is still worth attempting so the user gets a real
    // Ollama error rather than a generic "no vision model" message.
  }
  // 1. Explicit configuration wins. Trust a configured model when it is
  //    usable (installed or a cloud model) OR when we could not list at all.
  //    This is the robust path for cloud vision models like minimax-m3:cloud
  //    that the local tags list never reports.
  if (configuredModel && (isVisionModelUsable(configuredModel, installed) || !listed)) {
    return configuredModel;
  }
  // 2. The active chat model, when it is itself vision-capable and usable.
  //    Lets `minimax-m3:cloud` selected as the main model handle images with
  //    zero extra configuration.
  const selectedModel = sanitizeString(process.env.OLLAMA_MODEL);
  if (selectedModel && isVisionCapableModelName(selectedModel) && isVisionModelUsable(selectedModel, installed)) {
    return selectedModel;
  }
  // 3. Auto-detect any vision-capable model present in the list (local or a
  //    cloud entry that Ollama did surface).
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
    const commandTemplate = process.env.HARNESS_AUDIO_TRANSCRIBE_COMMAND;
    if (!commandTemplate) {
      return {
        success: false,
        output: 'No audio transcription command is configured. Set HARNESS_AUDIO_TRANSCRIBE_COMMAND with {input}, for example: whisper {input} --model base --output_format txt --output_dir -',
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
