import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SessionEvent, SessionEventData, SessionMeta } from '../types';

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
      model,
      projectDir,
    };
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.transcriptPath), { recursive: true });
    await fs.writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), 'utf-8');
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
  }

  async readAll(): Promise<SessionEvent[]> {
    try {
      const content = await fs.readFile(this.transcriptPath, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
    } catch {
      return [];
    }
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
      return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}
