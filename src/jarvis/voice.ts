// Voice layer — interface only.
//
// Defines the SpeechToText, TextToSpeech, and WakeWord interfaces plus a
// null adapter so the rest of the harness can wire to "voice" without any
// native binary present. Real adapters ship as opt-in cookbook recipes:
//
//   * STT: whisper.cpp (https://github.com/ggerganov/whisper.cpp)
//   * TTS: piper       (https://github.com/rhasspy/piper)
//   * Wake: openWakeWord or porcupine
//
// To enable voice for real:
//   1. Install one of the binaries above.
//   2. `import { setSpeechToText, setTextToSpeech, setWakeWord } from 'src/jarvis/voice'`
//      in a startup hook and register an adapter that shells out to the binary.
//   3. Gate the adapter behind a Trust Ladder capability ('voice_listen',
//      'voice_speak') so the user controls when the mic is hot.
//
// All adapters return Promises so callers don't depend on the underlying
// streaming model. Streaming is layered on top via the EventEmitter on the
// SignalBus when the adapter publishes partial transcripts.

export interface SpeechToText {
  /** Transcribe an audio buffer (PCM 16-bit, 16kHz mono recommended). */
  transcribe(audio: Buffer, options?: { language?: string }): Promise<{ text: string; confidence?: number }>;
  /** Adapter capability name shown in `/api/jarvis/status`. */
  name: string;
}

export interface TextToSpeech {
  /** Render text to a WAV buffer. */
  speak(text: string, options?: { voice?: string; rate?: number }): Promise<Buffer>;
  name: string;
}

export interface WakeWord {
  /** Returns true when the current audio frame contains the wake word. */
  detect(audioFrame: Buffer): Promise<boolean>;
  name: string;
}

const nullSTT: SpeechToText = {
  name: 'null-stt',
  async transcribe(): Promise<{ text: string; confidence?: number }> {
    throw new Error('No speech-to-text adapter registered. Install whisper.cpp and call setSpeechToText().');
  },
};

const nullTTS: TextToSpeech = {
  name: 'null-tts',
  async speak(): Promise<Buffer> {
    throw new Error('No text-to-speech adapter registered. Install piper and call setTextToSpeech().');
  },
};

const nullWake: WakeWord = {
  name: 'null-wake',
  async detect(): Promise<boolean> {
    return false;
  },
};

let stt: SpeechToText = nullSTT;
let tts: TextToSpeech = nullTTS;
let wake: WakeWord = nullWake;

export function setSpeechToText(adapter: SpeechToText): void { stt = adapter; }
export function setTextToSpeech(adapter: TextToSpeech): void { tts = adapter; }
export function setWakeWord(adapter: WakeWord): void { wake = adapter; }

export function getSpeechToText(): SpeechToText { return stt; }
export function getTextToSpeech(): TextToSpeech { return tts; }
export function getWakeWord(): WakeWord { return wake; }

export interface VoiceStatus {
  stt: { name: string; ready: boolean };
  tts: { name: string; ready: boolean };
  wake: { name: string; ready: boolean };
}

export function getVoiceStatus(): VoiceStatus {
  return {
    stt: { name: stt.name, ready: stt.name !== 'null-stt' },
    tts: { name: tts.name, ready: tts.name !== 'null-tts' },
    wake: { name: wake.name, ready: wake.name !== 'null-wake' },
  };
}
