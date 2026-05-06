// Squad session persistence.
//
// Tracks which squad a chat session is associated with so callers do not
// need to re-pass `squadId` on every turn. Stored as a JSON map under
// `.harness/squads/sessions.json`. Cheap append-style writes.

import * as fs from 'fs/promises';
import * as path from 'path';

interface SquadSessionStore {
  version: 1;
  // sessionId → squadId
  associations: Record<string, string>;
}

function sessionsFilePath(projectDir: string): string {
  return path.join(projectDir, '.harness', 'squads', 'sessions.json');
}

async function readStore(projectDir: string): Promise<SquadSessionStore> {
  try {
    const raw = await fs.readFile(sessionsFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SquadSessionStore>;
    return {
      version: 1,
      associations: parsed.associations && typeof parsed.associations === 'object' && !Array.isArray(parsed.associations)
        ? Object.fromEntries(Object.entries(parsed.associations).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'))
        : {},
    };
  } catch {
    return { version: 1, associations: {} };
  }
}

async function writeStore(projectDir: string, store: SquadSessionStore): Promise<void> {
  const fp = sessionsFilePath(projectDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(store, null, 2), 'utf-8');
}

export async function getSquadForSession(projectDir: string, sessionId: string): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const store = await readStore(projectDir);
  return store.associations[sessionId];
}

export async function setSquadForSession(projectDir: string, sessionId: string, squadId: string): Promise<void> {
  if (!sessionId || !squadId) return;
  const store = await readStore(projectDir);
  if (store.associations[sessionId] === squadId) return;
  store.associations[sessionId] = squadId;
  await writeStore(projectDir, store);
}

export async function clearSquadForSession(projectDir: string, sessionId: string): Promise<boolean> {
  const store = await readStore(projectDir);
  if (!(sessionId in store.associations)) return false;
  delete store.associations[sessionId];
  await writeStore(projectDir, store);
  return true;
}

/**
 * Resolve the effective squadId for a chat turn. Caller-supplied id takes
 * precedence (and is persisted as the new association); otherwise the
 * stored association is returned, if any.
 */
export async function resolveSessionSquad(
  projectDir: string,
  sessionId: string,
  explicitSquadId?: string,
): Promise<string | undefined> {
  if (explicitSquadId && sessionId) {
    await setSquadForSession(projectDir, sessionId, explicitSquadId).catch(() => {});
    return explicitSquadId;
  }
  return getSquadForSession(projectDir, sessionId);
}
