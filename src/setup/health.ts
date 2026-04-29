import { Ollama } from 'ollama';
import { AudioTranscribeTool } from '../tools/multimodalTools';

export interface SetupHealthInput {
  host: string;
  visionModel: string;
  audioTranscribeCommand: string;
  audioSamplePath?: string;
}

export interface SetupHealthResult {
  ollama: { ok: boolean; message: string; modelCount: number };
  vision: { ok: boolean; message: string };
  audio: { ok: boolean; message: string };
}

export async function checkSetupHealth(input: SetupHealthInput): Promise<SetupHealthResult> {
  const audio = await checkAudioHealth(input.audioTranscribeCommand, input.audioSamplePath);
  try {
    const response = await new Ollama({ host: input.host }).list();
    const modelNames = response.models.map((model) => model.name);
    const matchingVisionModel = input.visionModel
      ? modelNames.some((name) => name === input.visionModel || name.startsWith(`${input.visionModel}:`))
      : false;
    return {
      ollama: {
        ok: true,
        message: modelNames.length > 0 ? `Connected to Ollama with ${modelNames.length} model(s).` : 'Connected to Ollama, but no models are installed.',
        modelCount: modelNames.length,
      },
      vision: input.visionModel
        ? {
          ok: matchingVisionModel,
          message: matchingVisionModel ? `Vision model '${input.visionModel}' is installed.` : `Vision model '${input.visionModel}' was not found in Ollama.`,
        }
        : { ok: false, message: 'No vision model configured.' },
      audio,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ollama: { ok: false, message: `Cannot connect to Ollama: ${message}`, modelCount: 0 },
      vision: input.visionModel ? { ok: false, message: 'Vision model could not be checked because Ollama is unavailable.' } : { ok: false, message: 'No vision model configured.' },
      audio,
    };
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
