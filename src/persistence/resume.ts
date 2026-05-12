import type { Message } from 'ollama';
import { SessionStorage } from './sessionStorage';
import type { SessionEvent, SessionMeta } from '../types';

export interface ResumeResult {
  messages: Message[];
  meta: SessionMeta;
  eventCount: number;
}

export async function resumeSession(
  projectDir: string,
  sessionId: string,
  model: string,
): Promise<ResumeResult> {
  const storage = new SessionStorage(projectDir, model, sessionId);
  const events = await storage.readAll();
  const meta = await storage.getMeta();

  // Rebuild messages from transcript events
  // Note: session-scoped permissions are NOT restored (deliberate safety choice)
  const messages = eventsToMessages(events);

  return {
    messages,
    meta,
    eventCount: events.length,
  };
}

export async function forkSession(
  projectDir: string,
  sourceSessionId: string,
  model: string,
): Promise<{ newStorage: SessionStorage; messages: Message[] }> {
  const source = new SessionStorage(projectDir, model, sourceSessionId);
  const events = await source.readAll();
  const messages = eventsToMessages(events);

  // Create new session with a reference to the parent
  const newStorage = new SessionStorage(projectDir, model);
  await newStorage.initialize();

  // Replay messages into the new session transcript
  for (const event of events) {
    await newStorage.append(event.type, event.data);
  }

  await newStorage.updateMeta({ parentSessionId: sourceSessionId });

  // Add fork marker
  await newStorage.append('system', {
    kind: 'system',
    content: `Forked from session ${sourceSessionId}`,
  });

  return { newStorage, messages };
}

function eventsToMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    switch (event.data.kind) {
      case 'message':
        messages.push(event.data.message);
        break;
      case 'tool_result':
        messages.push({
          role: 'tool' as const,
          content: event.data.result.output,
        });
        break;
      case 'compact_boundary':
        messages.length = 0;
        messages.push({
          role: 'system' as const,
          content: `[Compacted summary]\n${event.data.summary}`,
        });
        break;
      case 'continuity_checkpoint':
        messages.length = 0;
        messages.push({
          role: 'system' as const,
          content: checkpointToMessage(event.data.checkpoint),
        });
        break;
      // tool_call and system events don't produce standalone messages
    }
  }

  return messages;
}

function checkpointToMessage(checkpoint: SessionEventDataCheckpoint): string {
  return [
    '[Continuity checkpoint]',
    `Goal: ${checkpoint.currentGoal}`,
    `Summary: ${checkpoint.summary}`,
    `Next action: ${checkpoint.nextAction}`,
    checkpoint.openQuestions.length ? `Open questions: ${checkpoint.openQuestions.join('; ')}` : '',
    checkpoint.recentMessages.length ? `Recent context: ${checkpoint.recentMessages.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

type SessionEventDataCheckpoint = Extract<SessionEvent['data'], { kind: 'continuity_checkpoint' }>['checkpoint'];

export async function getLatestSession(
  projectDir: string,
): Promise<SessionMeta | null> {
  const sessions = await SessionStorage.listSessions(projectDir);
  return sessions.length > 0 ? sessions[0] : null;
}
