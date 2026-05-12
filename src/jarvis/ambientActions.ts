// Ambient → action policy.
//
// Pure evaluator that maps batches of NervousSignal events to a list of
// declarative `AmbientAction` records. The web server actually executes the
// actions; this module just classifies what should happen.
//
// Default policy:
//   * `ambient.file` (file changes)  → ingest entity:file records into the KG
//   * `ambient.git` clean transition → save the daily brief to .harness/documents
//   * everything else                → no action
//
// Custom policies can be loaded from JSON on disk in a follow-up; this v6
// keeps the policy hard-coded so we don't ship a new config surface.

import type { NervousSignal } from '../nervous/signals';

export type AmbientActionKind = 'kg_ingest_file' | 'save_brief' | 'noop';

export interface AmbientAction {
  kind: AmbientActionKind;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface AmbientActionPolicy {
  evaluate: (batch: NervousSignal[]) => AmbientAction[];
}

export const defaultAmbientActionPolicy: AmbientActionPolicy = {
  evaluate(batch: NervousSignal[]): AmbientAction[] {
    const actions: AmbientAction[] = [];
    let lastGitWasDirty = false;
    for (const signal of batch) {
      if (signal.source === 'ambient.file') {
        const files = (signal.metadata?.files as string[] | undefined) ?? [];
        if (files.length > 0) {
          actions.push({
            kind: 'kg_ingest_file',
            reason: `File changes detected (${files.length})`,
            payload: { files },
          });
        }
        continue;
      }
      if (signal.source === 'ambient.git') {
        const isDirty = signal.type === 'USER_INTENT';
        if (lastGitWasDirty && !isDirty) {
          actions.push({ kind: 'save_brief', reason: 'Git working tree returned to clean state' });
        }
        lastGitWasDirty = isDirty;
      }
    }
    return actions;
  },
};
