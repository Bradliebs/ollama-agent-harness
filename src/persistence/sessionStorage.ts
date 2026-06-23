import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SessionEvent, SessionEventData, SessionMeta, SessionStatus } from '../types';
import { withFileLock } from './atomicFile';

export interface SessionTranscriptDiagnostics {
  path: string;
  missing: boolean;
  totalLines: number;
  validEvents: number;
  corruptLines: number;
  unreadable: boolean;
  error?: string;
}

export interface SessionTranscriptReadResult {
  events: SessionEvent[];
  diagnostics: SessionTranscriptDiagnostics;
}

export interface SessionStorageHealth {
  status: 'healthy' | 'warning' | 'missing' | 'error';
  sessionDir: string;
  transcripts: number;
  metaFiles: number;
  corruptTranscriptFiles: number;
  corruptTranscriptLines: number;
  corruptMetaFiles: number;
  unreadableFiles: number;
}

export class SessionStorage {
  private transcriptPath: string;
  private metaPath: string;
  private meta: SessionMeta;

  constructor(projectDir: string, model: string, sessionId?: string) {
    const id = sessionId ?? crypto.randomUUID();
    const sessionsDir = path.join(projectDir, '.harness', 'sessions');
    this.transcriptPath = path.join(sessionsDir, `${id}.jsonl`);
    this.metaPath = path.join(sessionsDir, `${id}.meta.json`);
    this.meta = {
      sessionId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model,
      projectDir,
      status: 'running',
      checkpointCount: 0,
    };
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.transcriptPath), { recursive: true });
    await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf-8');
  }

  setMeta<K extends keyof SessionMeta>(key: K, value: SessionMeta[K]): void {
    this.meta[key] = value;
  }

  async append(type: SessionEvent['type'], data: SessionEventData): Promise<void> {
    const event: SessionEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.transcriptPath, line, 'utf-8');
    const patch: Partial<SessionMeta> = { updatedAt: event.timestamp };
    if (data.kind === 'continuity_checkpoint') {
      patch.checkpointCount = (this.meta.checkpointCount ?? 0) + 1;
      patch.lastCheckpointAt = event.timestamp;
      patch.title = this.meta.title ?? data.checkpoint.currentGoal.slice(0, 80);
    } else if (data.kind === 'message' && data.message.role === 'user' && !this.meta.title) {
      patch.title = data.message.content?.slice(0, 80) ?? 'Untitled session';
    }
    await this.updateMeta(patch);
  }

  async updateMeta(patch: Partial<SessionMeta>): Promise<SessionMeta> {
    await fs.mkdir(path.dirname(this.metaPath), { recursive: true });
    return withFileLock(this.metaPath, async () => {
      // Re-read from disk inside the lock to pick up concurrent changes
      const fresh = await this.getMeta();
      this.meta = { ...fresh, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf-8');
      return this.meta;
    });
  }

  async markStatus(status: SessionStatus, lastError?: string): Promise<void> {
    await this.updateMeta({ status, lastError });
  }

  async readAll(): Promise<SessionEvent[]> {
    const result = await this.readAllDetailed();
    return result.events;
  }

  async readAllDetailed(): Promise<SessionTranscriptReadResult> {
    return readTranscriptFile(this.transcriptPath);
  }

  async getMeta(): Promise<SessionMeta> {
    try {
      const content = await fs.readFile(this.metaPath, 'utf-8');
      return JSON.parse(content) as SessionMeta;
    } catch {
      return this.meta;
    }
  }

  getSessionId(): string {
    return this.meta.sessionId;
  }

  getTranscriptPath(): string {
    return this.transcriptPath;
  }

  static async listSessions(projectDir: string): Promise<SessionMeta[]> {
    const sessionsDir = path.join(projectDir, '.harness', 'sessions');
    try {
      const files = await fs.readdir(sessionsDir);
      const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
      const metas: SessionMeta[] = [];
      for (const file of metaFiles) {
        try {
          const content = await fs.readFile(path.join(sessionsDir, file), 'utf-8');
          metas.push(JSON.parse(content) as SessionMeta);
        } catch {
          // Skip corrupt meta files
        }
      }
      return metas.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    } catch {
      return [];
    }
  }

  static async inspectStorage(projectDir: string): Promise<SessionStorageHealth> {
    const sessionsDir = path.join(projectDir, '.harness', 'sessions');
    let files: string[];
    try {
      files = await fs.readdir(sessionsDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        status: code === 'ENOENT' ? 'missing' : 'error',
        sessionDir: sessionsDir,
        transcripts: 0,
        metaFiles: 0,
        corruptTranscriptFiles: 0,
        corruptTranscriptLines: 0,
        corruptMetaFiles: 0,
        unreadableFiles: code === 'ENOENT' ? 0 : 1,
      };
    }

    let corruptTranscriptFiles = 0;
    let corruptTranscriptLines = 0;
    let corruptMetaFiles = 0;
    let unreadableFiles = 0;
    const transcripts = files.filter((file) => file.endsWith('.jsonl'));
    const metaFiles = files.filter((file) => file.endsWith('.meta.json'));

    for (const file of transcripts) {
      const result = await readTranscriptFile(path.join(sessionsDir, file));
      if (result.diagnostics.unreadable) unreadableFiles += 1;
      if (result.diagnostics.corruptLines > 0) {
        corruptTranscriptFiles += 1;
        corruptTranscriptLines += result.diagnostics.corruptLines;
      }
    }

    for (const file of metaFiles) {
      try {
        JSON.parse(await fs.readFile(path.join(sessionsDir, file), 'utf-8'));
      } catch {
        corruptMetaFiles += 1;
      }
    }

    const status = unreadableFiles > 0
      ? 'error'
      : corruptTranscriptFiles > 0 || corruptMetaFiles > 0
        ? 'warning'
        : 'healthy';
    return {
      status,
      sessionDir: sessionsDir,
      transcripts: transcripts.length,
      metaFiles: metaFiles.length,
      corruptTranscriptFiles,
      corruptTranscriptLines,
      corruptMetaFiles,
      unreadableFiles,
    };
  }

  static async listRecoverableSessions(projectDir: string): Promise<SessionMeta[]> {
    const recoverableStatuses: Set<SessionStatus> = new Set(['running', 'error', 'aborted']);
    const sessions = await SessionStorage.listSessions(projectDir);
    return sessions.filter((session) => typeof session.status === 'string' && recoverableStatuses.has(session.status));
  }

  static async markStaleRunningSessions(projectDir: string, staleBeforeMs: number = Date.now()): Promise<number> {
    const sessionsDir = path.join(projectDir, '.harness', 'sessions');
    let files: string[];
    try {
      files = await fs.readdir(sessionsDir);
    } catch {
      return 0;
    }

    let marked = 0;
    for (const file of files.filter((name) => name.endsWith('.meta.json'))) {
      const metaPath = path.join(sessionsDir, file);
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SessionMeta;
        if (meta.status !== 'running') continue;
        const updatedMs = Date.parse(meta.updatedAt ?? meta.createdAt);
        if (Number.isFinite(updatedMs) && updatedMs >= staleBeforeMs) continue;
        const next: SessionMeta = {
          ...meta,
          status: 'aborted',
          updatedAt: new Date().toISOString(),
          lastError: meta.lastError ?? 'Server restarted before this run completed.',
        };
        await fs.writeFile(metaPath, JSON.stringify(next, null, 2), 'utf-8');
        marked++;
      } catch {
        // Skip corrupt meta files; listSessions follows the same tolerant policy.
      }
    }
    return marked;
  }
}

async function readTranscriptFile(filePath: string): Promise<SessionTranscriptReadResult> {
  const diagnostics: SessionTranscriptDiagnostics = {
    path: filePath,
    missing: false,
    totalLines: 0,
    validEvents: 0,
    corruptLines: 0,
    unreadable: false,
  };
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const events: SessionEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      diagnostics.totalLines += 1;
      try {
        events.push(JSON.parse(line) as SessionEvent);
        diagnostics.validEvents += 1;
      } catch {
        diagnostics.corruptLines += 1;
      }
    }
    return { events, diagnostics };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') diagnostics.missing = true;
    else {
      diagnostics.unreadable = true;
      diagnostics.error = error instanceof Error ? error.message : String(error);
    }
    return { events: [], diagnostics };
  }
}
