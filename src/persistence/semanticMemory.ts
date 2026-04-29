import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionEvent, SessionMeta } from '../types';
import { SessionStorage } from './sessionStorage';

export interface SemanticMemoryEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: string;
  text: string;
  tokens: string[];
}

export interface SemanticSearchResult {
  entry: SemanticMemoryEntry;
  score: number;
}

export interface SemanticMemoryContextEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: string;
  text: string;
  isAnchor: boolean;
}

export interface SemanticMemoryContext {
  entry: SemanticMemoryEntry;
  events: SemanticMemoryContextEvent[];
}

export interface MemoryPalaceRoom {
  id: string;
  title: string;
  entryCount: number;
  sessions: string[];
  anchors: Array<{
    id: string;
    sessionId: string;
    timestamp: string;
    kind: string;
    text: string;
  }>;
}

export interface MemoryPalace {
  generatedAt: string;
  entryCount: number;
  roomCount: number;
  rooms: MemoryPalaceRoom[];
}

export async function rebuildSemanticMemory(projectDir: string): Promise<SemanticMemoryEntry[]> {
  const sessions = await SessionStorage.listSessions(projectDir);
  const entries: SemanticMemoryEntry[] = [];
  for (const session of sessions) {
    const storage = new SessionStorage(projectDir, session.model, session.sessionId);
    const events = await storage.readAll();
    entries.push(...eventsToEntries(session, events));
  }
  await writeIndex(projectDir, entries);
  return entries;
}

export async function searchSemanticMemory(projectDir: string, query: string, limit = 8): Promise<SemanticSearchResult[]> {
  const entries = await readOrBuildIndex(projectDir);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }
  return entries
    .map((entry) => ({ entry, score: scoreEntry(queryTokens, entry.tokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getSemanticMemoryEntry(projectDir: string, entryId: string): Promise<SemanticMemoryEntry | null> {
  const entries = await readOrBuildIndex(projectDir);
  return entries.find((entry) => entry.id === entryId) ?? null;
}

export async function getSemanticMemoryContext(projectDir: string, entryId: string, windowSize = 3): Promise<SemanticMemoryContext | null> {
  const entry = await getSemanticMemoryEntry(projectDir, entryId);
  if (!entry) return null;
  const storage = new SessionStorage(projectDir, 'unknown', entry.sessionId);
  const events = await storage.readAll();
  const eventIndex = events.findIndex((event) => event.id === entryId);
  if (eventIndex < 0) {
    return { entry, events: [] };
  }
  const start = Math.max(0, eventIndex - windowSize);
  const end = Math.min(events.length, eventIndex + windowSize + 1);
  return {
    entry,
    events: events.slice(start, end).map((event) => ({
      id: event.id,
      sessionId: entry.sessionId,
      timestamp: event.timestamp,
      kind: event.type,
      text: eventToText(event).slice(0, 800),
      isAnchor: event.id === entryId,
    })),
  };
}

export async function buildMemoryPalace(projectDir: string): Promise<MemoryPalace> {
  const entries = await readOrBuildIndex(projectDir);
  const groups = new Map<string, SemanticMemoryEntry[]>();
  for (const entry of entries) {
    const roomId = roomIdForKind(entry.kind);
    groups.set(roomId, [...(groups.get(roomId) ?? []), entry]);
  }
  const rooms = Array.from(groups.entries())
    .map(([id, roomEntries]) => toRoom(id, roomEntries))
    .sort((a, b) => b.entryCount - a.entryCount || a.title.localeCompare(b.title));

  return {
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    roomCount: rooms.length,
    rooms,
  };
}

function eventsToEntries(session: SessionMeta, events: SessionEvent[]): SemanticMemoryEntry[] {
  return events.flatMap((event) => {
    const text = eventToText(event);
    if (!text) {
      return [];
    }
    return [{
      id: event.id,
      sessionId: session.sessionId,
      timestamp: event.timestamp,
      kind: event.type,
      text,
      tokens: tokenize(text),
    }];
  });
}

function eventToText(event: SessionEvent): string {
  switch (event.data.kind) {
    case 'message':
      return event.data.message.content ?? '';
    case 'tool_result':
      return event.data.result.output;
    case 'compact_boundary':
      return event.data.summary;
    case 'continuity_checkpoint':
      return [
        event.data.checkpoint.currentGoal,
        event.data.checkpoint.summary,
        event.data.checkpoint.nextAction,
        ...event.data.checkpoint.recentMessages,
      ].join('\n');
    case 'system':
      return event.data.content;
    default:
      return '';
  }
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []));
}

function scoreEntry(queryTokens: string[], entryTokens: string[]): number {
  const entrySet = new Set(entryTokens);
  const matches = queryTokens.filter((token) => entrySet.has(token)).length;
  return matches / Math.sqrt(Math.max(1, entryTokens.length));
}

async function readOrBuildIndex(projectDir: string): Promise<SemanticMemoryEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), 'utf-8');
    return JSON.parse(raw) as SemanticMemoryEntry[];
  } catch {
    return rebuildSemanticMemory(projectDir);
  }
}

async function writeIndex(projectDir: string, entries: SemanticMemoryEntry[]): Promise<void> {
  const filePath = indexPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

function indexPath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'memory', 'semantic-index.json');
}

function toRoom(id: string, entries: SemanticMemoryEntry[]): MemoryPalaceRoom {
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    id,
    title: roomTitle(id),
    entryCount: entries.length,
    sessions: Array.from(new Set(entries.map((entry) => entry.sessionId))).sort(),
    anchors: sorted.slice(0, 6).map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      kind: entry.kind,
      text: entry.text.slice(0, 260),
    })),
  };
}

function roomIdForKind(kind: string): string {
  if (kind.includes('checkpoint') || kind.includes('compact')) return 'continuity';
  if (kind.includes('tool')) return 'tools';
  if (kind.includes('message')) return 'conversation';
  return 'system';
}

function roomTitle(id: string): string {
  switch (id) {
    case 'continuity': return 'Continuity Hall';
    case 'tools': return 'Tool Workshop';
    case 'conversation': return 'Conversation Gallery';
    default: return 'System Archive';
  }
}
