// Cookbook recipe — Whisper STT adapter for the Jarvis voice layer.
//
// Wires `whisper.cpp` (or any compatible CLI) into the harness so the voice
// interface in `src/jarvis/voice.ts` becomes operational. Runs the binary
// per request with a temporary audio file, returns the transcript.
//
// Prerequisites:
//   * Build whisper.cpp and place the binary on PATH (e.g. `whisper`).
//   * A model file (e.g. `ggml-base.en.bin`) — either on PATH or pointed to
//     by the HARNESS_WHISPER_MODEL env var.
//
// Wiring:
//   import { setSpeechToText } from '../src/jarvis/voice';
//   import { createWhisperSTT } from '../cookbook/voice-whisper';
//   setSpeechToText(createWhisperSTT({ binary: 'whisper', model: process.env.HARNESS_WHISPER_MODEL }));
//
// Trust ladder gating:
//   The mic transport (browser MediaRecorder, OS hotkey, etc.) should
//   evaluate the `voice_listen` capability against the trust ladder before
//   capturing audio. This adapter only does transcription; it does not
//   capture audio itself.

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SpeechToText } from '../src/jarvis/voice';

export interface WhisperOptions {
  /** Path to the whisper binary, default `whisper`. */
  binary?: string;
  /** Path to the ggml model file. */
  model?: string;
  /** Extra CLI args. */
  extraArgs?: string[];
}

export function createWhisperSTT(options: WhisperOptions = {}): SpeechToText {
  const binary = options.binary ?? 'whisper';
  return {
    name: `whisper:${binary}`,
    async transcribe(audio: Buffer): Promise<{ text: string; confidence?: number }> {
      const tmp = path.join(os.tmpdir(), `harness-stt-${Date.now()}.wav`);
      await fs.writeFile(tmp, audio);
      try {
        const args = ['-f', tmp, '-otxt'];
        if (options.model) args.push('-m', options.model);
        if (options.extraArgs) args.push(...options.extraArgs);
        const text = await new Promise<string>((resolve, reject) => {
          const proc = spawn(binary, args);
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          proc.on('close', (code: number | null) => {
            if (code !== 0) reject(new Error(`whisper exited with code ${code}: ${stderr.trim().slice(0, 240)}`));
            else resolve(stdout.trim());
          });
          proc.on('error', reject);
        });
        return { text };
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
    },
  };
}
