// Run transcripts — structured capture of agent execution output.
//
// Records tool calls, token usage, duration, and status for each sub-agent
// run. Persisted as `.harness/transcripts/<id>.json` and events are
// emitted for live UI updates.
//
// Mirrors the Paperclip "transcripts" concept but uses our JSON-file
// persistence pattern and event system.

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { emitEvent } from '../persistence/eventStore';

// ─── Types ──────────────────────────────────────────────────────────

export type RunTranscriptStatus = 'running' | 'completed' | 'failed';

export interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  durationMs: number;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface RunTranscript {
  id: string;
  taskId?: string;
  agentId: string;
  model: string;
  companyId?: string;
  startedAt: string;
  completedAt?: string;
  status: RunTranscriptStatus;
  toolCalls: ToolCallRecord[];
  tokenUsage: TokenUsage;
  outputSummary: string;
  fullOutput?: string;
  error?: string;
}

export interface CreateTranscriptInput {
  taskId?: string;
  agentId: string;
  model: string;
  companyId?: string;
}

export interface UpdateTranscriptInput {
  completedAt?: string;
  status?: RunTranscriptStatus;
  toolCalls?: ToolCallRecord[];
  tokenUsage?: TokenUsage;
  outputSummary?: string;
  fullOutput?: string;
  error?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────

function transcriptsDir(projectDir: string): string {
  return path.join(projectDir, '.harness', 'transcripts');
}

function transcriptFile(projectDir: string, id: string): string {
  return path.join(transcriptsDir(projectDir), `${id}.json`);
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listTranscripts(projectDir: string, filter?: { taskId?: string; agentId?: string; companyId?: string; status?: RunTranscriptStatus }): Promise<RunTranscript[]> {
  const dir = transcriptsDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const transcripts: RunTranscript[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      const t = JSON.parse(raw) as RunTranscript;
      if (filter?.taskId && t.taskId !== filter.taskId) continue;
      if (filter?.agentId && t.agentId !== filter.agentId) continue;
      if (filter?.companyId && t.companyId !== filter.companyId) continue;
      if (filter?.status && t.status !== filter.status) continue;
      transcripts.push(t);
    } catch {
      // Skip corrupt files
    }
  }
  return transcripts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getTranscript(projectDir: string, id: string): Promise<RunTranscript | undefined> {
  try {
    const raw = await fs.readFile(transcriptFile(projectDir, id), 'utf-8');
    return JSON.parse(raw) as RunTranscript;
  } catch {
    return undefined;
  }
}

export async function createTranscript(projectDir: string, input: CreateTranscriptInput, now = new Date()): Promise<RunTranscript> {
  const id = crypto.randomUUID();
  const transcript: RunTranscript = {
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    model: input.model,
    companyId: input.companyId,
    startedAt: now.toISOString(),
    status: 'running',
    toolCalls: [],
    tokenUsage: { input: 0, output: 0 },
    outputSummary: '',
  };
  await fs.mkdir(transcriptsDir(projectDir), { recursive: true });
  await fs.writeFile(transcriptFile(projectDir, id), JSON.stringify(transcript, null, 2), 'utf-8');
  await emitEvent(projectDir, 'service', 'transcript.created', { transcript }, 'system', id).catch(() => {});
  return transcript;
}

export async function updateTranscript(projectDir: string, id: string, input: UpdateTranscriptInput, now = new Date()): Promise<RunTranscript> {
  const existing = await getTranscript(projectDir, id);
  if (!existing) throw new Error(`Transcript not found: ${id}`);
  const updated: RunTranscript = {
    ...existing,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.tokenUsage !== undefined ? { tokenUsage: input.tokenUsage } : {}),
    ...(input.outputSummary !== undefined ? { outputSummary: input.outputSummary } : {}),
    ...(input.fullOutput !== undefined ? { fullOutput: input.fullOutput } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  await fs.mkdir(transcriptsDir(projectDir), { recursive: true });
  await fs.writeFile(transcriptFile(projectDir, id), JSON.stringify(updated, null, 2), 'utf-8');

  const eventType = updated.status === 'completed' ? 'transcript.completed'
    : updated.status === 'failed' ? 'transcript.failed'
    : 'transcript.updated';
  await emitEvent(projectDir, 'service', eventType, { transcript: updated }, 'system', id).catch(() => {});
  return updated;
}

/**
 * Append a tool call record to a running transcript.
 */
export async function appendToolCall(projectDir: string, id: string, toolCall: ToolCallRecord): Promise<RunTranscript> {
  const existing = await getTranscript(projectDir, id);
  if (!existing) throw new Error(`Transcript not found: ${id}`);
  existing.toolCalls.push(toolCall);
  await fs.writeFile(transcriptFile(projectDir, id), JSON.stringify(existing, null, 2), 'utf-8');
  return existing;
}

/**
 * Add token usage to a transcript (incrementally).
 */
export async function addTokenUsage(projectDir: string, id: string, usage: Partial<TokenUsage>): Promise<RunTranscript> {
  const existing = await getTranscript(projectDir, id);
  if (!existing) throw new Error(`Transcript not found: ${id}`);
  existing.tokenUsage = {
    input: existing.tokenUsage.input + (usage.input ?? 0),
    output: existing.tokenUsage.output + (usage.output ?? 0),
  };
  await fs.writeFile(transcriptFile(projectDir, id), JSON.stringify(existing, null, 2), 'utf-8');
  return existing;
}

/**
 * Complete a transcript — set status, summary, and completedAt.
 */
export async function completeTranscript(
  projectDir: string,
  id: string,
  result: { success: boolean; summary: string; fullOutput?: string; error?: string; durationMs?: number },
  now = new Date(),
): Promise<RunTranscript> {
  return updateTranscript(projectDir, id, {
    status: result.success ? 'completed' : 'failed',
    completedAt: now.toISOString(),
    outputSummary: result.summary,
    fullOutput: result.fullOutput,
    error: result.error,
  }, now);
}

/**
 * Delete old transcripts older than a given number of days.
 */
export async function pruneOldTranscripts(projectDir: string, maxAgeDays: number = 30, now = new Date()): Promise<number> {
  const dir = transcriptsDir(projectDir);
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), 'utf-8');
      const t = JSON.parse(raw) as RunTranscript;
      if (t.startedAt && new Date(t.startedAt) < cutoff) {
        await fs.unlink(path.join(dir, entry.name));
        removed++;
      }
    } catch {
      // Skip corrupt files
    }
  }
  return removed;
}