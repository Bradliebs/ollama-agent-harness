// Predictive engine adapters.
//
// The predictive engine is pure: it consumes ActionEvent[] and returns
// suggestions. These adapters convert the harness's existing data sources
// into ActionEvent[] so callers do not have to reimplement the conversion.
//
// Sources:
//   * SessionEvent[] from `SessionStorage` — tool calls become ActionEvents
//   * NervousSignal[] from the SignalBus rolling log
//   * EvidenceCard[] from the evidence store
//
// Output is always chronologically sorted so the predictive engine's
// windowed scan produces meaningful "after X then Y" results.

import type { SessionEvent } from '../types';
import type { NervousSignal } from '../nervous/signals';
import type { EvidenceCard } from '../types/evidence';
import type { ActionEvent } from './predictiveEngine';

export function eventsFromSession(events: SessionEvent[]): ActionEvent[] {
  const out: ActionEvent[] = [];
  for (const event of events) {
    if (event.data.kind === 'tool_call') {
      out.push({ key: event.data.call.name, at: event.timestamp, capability: 'tool' });
    } else if (event.data.kind === 'tool_result') {
      out.push({
        key: `${event.data.call.name}.${event.data.result.success ? 'ok' : 'fail'}`,
        at: event.timestamp,
        capability: 'tool_result',
      });
    } else if (event.data.kind === 'message' && event.data.message.role === 'user') {
      out.push({ key: 'user_message', at: event.timestamp });
    }
  }
  return out;
}

export function eventsFromAmbientSignals(signals: NervousSignal[]): ActionEvent[] {
  return signals.map((s) => ({
    key: `${s.source}.${s.type}`,
    at: s.createdAt,
    capability: s.source.startsWith('ambient.') ? 'ambient' : undefined,
    metadata: s.metadata,
  }));
}

export function eventsFromEvidenceCards(cards: EvidenceCard[]): ActionEvent[] {
  const out: ActionEvent[] = [];
  for (const card of cards) {
    out.push({ key: `mode.${card.mode}`, at: card.createdAt });
    for (const tool of card.tools) {
      out.push({ key: `tool.${tool.name}.${tool.success ? 'ok' : 'fail'}`, at: card.createdAt, capability: tool.name });
    }
    for (const file of card.files) {
      out.push({ key: `file.${file.action}`, at: card.createdAt, capability: `file_${file.action}` });
    }
    for (const command of card.commands) {
      out.push({ key: `command.${command.success === false ? 'fail' : 'ok'}`, at: card.createdAt });
    }
  }
  return out;
}

/** Merge multiple sources, sort, return chronological. */
export function mergeAndSort(...streams: ActionEvent[][]): ActionEvent[] {
  const all = streams.flat();
  all.sort((a, b) => a.at.localeCompare(b.at));
  return all;
}
