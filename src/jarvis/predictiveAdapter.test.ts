import type { SessionEvent } from '../types';
import { createSignal } from '../nervous/signals';
import type { EvidenceCard } from '../types/evidence';
import { eventsFromAmbientSignals, eventsFromEvidenceCards, eventsFromSession, mergeAndSort } from './predictiveAdapter';

function sessEvent(id: string, ts: string, data: SessionEvent['data']): SessionEvent {
  return { id, timestamp: ts, type: 'system', data };
}

describe('predictive adapter', () => {
  it('extracts tool_call and tool_result keys from session events', () => {
    const events: SessionEvent[] = [
      sessEvent('1', '2026-05-12T10:00:00Z', { kind: 'tool_call', call: { name: 'grep', input: {} } }),
      sessEvent('2', '2026-05-12T10:00:01Z', { kind: 'tool_result', call: { name: 'grep', input: {} }, result: { success: true, output: 'hit' } }),
    ];
    const actions = eventsFromSession(events);
    expect(actions.map((a) => a.key)).toEqual(['grep', 'grep.ok']);
  });

  it('marks user messages distinctly', () => {
    const events: SessionEvent[] = [
      sessEvent('1', '2026-05-12T10:00:00Z', { kind: 'message', message: { role: 'user', content: 'hi' } }),
    ];
    expect(eventsFromSession(events)[0].key).toBe('user_message');
  });

  it('converts ambient signals using source.type', () => {
    const sig = createSignal('USER_INTENT', 'ambient.file', 'low', 'change');
    const out = eventsFromAmbientSignals([sig]);
    expect(out[0].key).toBe('ambient.file.USER_INTENT');
    expect(out[0].capability).toBe('ambient');
  });

  it('flattens evidence cards into mode/tool/file/command actions', () => {
    const card: EvidenceCard = {
      id: 'c1', kind: 'chat', mode: 'build', createdAt: '2026-05-12T11:00:00Z',
      request: 'do thing', tools: [{ name: 'bash', success: true }], files: [{ path: 'a.ts', action: 'edit' }],
      commands: [{ command: 'npm test', success: true }], artifacts: [],
    };
    const actions = eventsFromEvidenceCards([card]);
    expect(actions.map((a) => a.key)).toEqual(['mode.build', 'tool.bash.ok', 'file.edit', 'command.ok']);
  });

  it('mergeAndSort returns chronological order across streams', () => {
    const a = [{ key: 'a', at: '2026-05-12T10:00:00Z' }];
    const b = [{ key: 'b', at: '2026-05-12T09:00:00Z' }];
    expect(mergeAndSort(a, b).map((x) => x.key)).toEqual(['b', 'a']);
  });
});
