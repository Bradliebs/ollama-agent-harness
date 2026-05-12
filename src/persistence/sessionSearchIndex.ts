import * as fs from 'fs/promises';
import * as path from 'path';
import { SessionStorage } from './sessionStorage';
import type { SessionEvent, SessionMeta } from '../types';

export interface SessionSearchEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  role: string;
  text: string;
  tokens: string[];
}

export interface SessionSearchResult {
  entry: SessionSearchEntry;
  score: number;
}

export interface SessionSearchIndexMetadata {
  rebuiltAt: string;
  sessionCount: number;
  entryCount: number;
  sourceUpdatedAt: string;
}

export interface SessionSearchIndexFile {
  metadata: SessionSearchIndexMetadata;
  entries: SessionSearchEntry[];
}

export interface SessionSearchIndexStatus extends SessionSearchIndexMetadata {
  exists: boolean;
  fresh: boolean;
  indexPath: string;
}

export async function rebuildSessionSearchIndex(projectDir: string): Promise<SessionSearchEntry[]> {
  const rebuilt = await rebuildSessionSearchIndexWithMetadata(projectDir);
  return rebuilt.entries;
}

export async function rebuildSessionSearchIndexWithMetadata(projectDir: string, now = new Date()): Promise<SessionSearchIndexFile> {
  const sessions = await SessionStorage.listSessions(projectDir);
  const entries: SessionSearchEntry[] = [];
  for (const session of sessions) {
    const storage = new SessionStorage(projectDir, session.model, session.sessionId);
    const events = await storage.readAll();
    entries.push(...eventsToSearchEntries(session, events));
  }
  const metadata: SessionSearchIndexMetadata = {
    rebuiltAt: now.toISOString(),
    sessionCount: sessions.length,
    entryCount: entries.length,
    sourceUpdatedAt: sourceUpdatedAt(sessions),
  };
  const index = { metadata, entries };
  await writeIndex(projectDir, index);
  return index;
}

export async function searchSessions(projectDir: string, query: string, limit = 10): Promise<SessionSearchResult[]> {
  const { entries } = await readOrBuildIndex(projectDir);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(queryTokens, entry.tokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.timestamp.localeCompare(a.entry.timestamp))
    .slice(0, limit);
}

export async function getSessionSearchIndexStatus(projectDir: string): Promise<SessionSearchIndexStatus> {
  const filePath = indexPath(projectDir);
  const sessions = await SessionStorage.listSessions(projectDir);
  const sourceUpdated = sourceUpdatedAt(sessions);
  try {
    const index = await readIndex(projectDir);
    return {
      ...index.metadata,
      exists: true,
      fresh: index.metadata.sourceUpdatedAt >= sourceUpdated,
      indexPath: filePath,
    };
  } catch {
    return {
      exists: false,
      fresh: false,
      indexPath: filePath,
      rebuiltAt: '',
      sessionCount: sessions.length,
      entryCount: 0,
      sourceUpdatedAt: sourceUpdated,
    };
  }
}

function eventsToSearchEntries(session: SessionMeta, events: SessionEvent[]): SessionSearchEntry[] {
  return events.flatMap((event) => {
    const text = eventToText(event);
    if (!text) return [];
    return [{
      id: event.id,
      sessionId: session.sessionId,
      timestamp: event.timestamp,
      role: eventRole(event),
      text,
      tokens: tokenize(text),
    }];
  });
}

function eventToText(event: SessionEvent): string {
  switch (event.data.kind) {
    case 'message': return event.data.message.content ?? '';
    case 'tool_result': return event.data.result.output;
    case 'compact_boundary': return event.data.summary;
    case 'continuity_checkpoint': return [event.data.checkpoint.currentGoal, event.data.checkpoint.summary, event.data.checkpoint.nextAction].join('\n');
    case 'system': return event.data.content;
    default: return '';
  }
}

function eventRole(event: SessionEvent): string {
  if (event.data.kind === 'message') return event.data.message.role;
  return event.type;
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []));
}

function scoreEntry(queryTokens: string[], entryTokens: string[]): number {
  const entrySet = new Set(entryTokens);
  const matches = queryTokens.filter((token) => entrySet.has(token)).length;
  return matches / Math.sqrt(Math.max(1, entryTokens.length));
}

async function readOrBuildIndex(projectDir: string): Promise<SessionSearchIndexFile> {
  try {
    return await readIndex(projectDir);
  } catch {
    return rebuildSessionSearchIndexWithMetadata(projectDir);
  }
}

async function readIndex(projectDir: string): Promise<SessionSearchIndexFile> {
  const parsed = JSON.parse(await fs.readFile(indexPath(projectDir), 'utf-8')) as SessionSearchEntry[] | SessionSearchIndexFile;
  if (Array.isArray(parsed)) {
    return { metadata: { rebuiltAt: '', sessionCount: 0, entryCount: parsed.length, sourceUpdatedAt: '' }, entries: parsed };
  }
  return parsed;
}

async function writeIndex(projectDir: string, index: SessionSearchIndexFile): Promise<void> {
  const filePath = indexPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index, null, 2), 'utf-8');
}

function sourceUpdatedAt(sessions: SessionMeta[]): string {
  return sessions.reduce((latest, session) => {
    const timestamp = session.updatedAt ?? session.createdAt;
    return timestamp > latest ? timestamp : latest;
  }, '');
}

function indexPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'memory', 'session-search-index.json');
}
