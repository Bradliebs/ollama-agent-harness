import { Ollama } from 'ollama';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AudioTranscribeTool } from '../tools/multimodalTools';
import { PdfReadTool } from '../tools/pdfTool';

export interface SetupHealthInput {
  host: string;
  visionModel: string;
  audioTranscribeCommand: string;
  audioSamplePath?: string;
  pdfOcrCommand?: string;
}

export interface SetupHealthResult {
  ollama: { ok: boolean; message: string; modelCount: number };
  vision: { ok: boolean; message: string };
  audio: { ok: boolean; message: string };
  pdfOcr?: { ok: boolean; message: string };
}

export async function checkSetupHealth(input: SetupHealthInput): Promise<SetupHealthResult> {
  const audio = await checkAudioHealth(input.audioTranscribeCommand, input.audioSamplePath);
  const pdfOcr = await checkPdfOcrHealth(input.pdfOcrCommand);
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
      pdfOcr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ollama: { ok: false, message: `Cannot connect to Ollama: ${message}`, modelCount: 0 },
      vision: input.visionModel ? { ok: false, message: 'Vision model could not be checked because Ollama is unavailable.' } : { ok: false, message: 'No vision model configured.' },
      audio,
      pdfOcr,
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
