// Brief trigger entry helper.
//
// Returns a TriggerDefinition compatible with the existing TriggerScheduler
// that POSTs /api/jarvis/brief/save twice a day. Users add it to their
// `.harness/triggers/triggers.json` via the Triggers tab; we never auto-install.

import type { TriggerDefinition } from '../services/triggerScheduler';

export interface BriefTriggerOptions {
  /** Hostname/port the trigger should hit. Default 127.0.0.1:3000. */
  baseUrl?: string;
  /** Interval in seconds between brief saves. Default 12 hours. */
  intervalSeconds?: number;
  /** Trigger id. Default `harness.daily-brief`. */
  id?: string;
  /** When false, the returned definition is disabled and only acts as a template. */
  enabled?: boolean;
}

export function defaultBriefTriggerDefinition(options: BriefTriggerOptions = {}): TriggerDefinition {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:3000';
  return {
    id: options.id ?? 'harness.daily-brief',
    command: 'curl',
    args: ['-X', 'POST', '--silent', `${baseUrl}/api/jarvis/brief/save`],
    intervalSeconds: options.intervalSeconds ?? 60 * 60 * 12,
    enabled: options.enabled ?? false,
  };
}
