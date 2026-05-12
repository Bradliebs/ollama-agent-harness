// TUI public entry point. Exposes a single `runTui` function the CLI
// dispatches to. Keeps the client construction in `client.ts` so it
// stays easy to unit-test independently.

export { createTuiClient } from './client';
export type { TuiClient, TuiClientOptions } from './client';
export {
  formatActiveSubagentsBar,
  formatChatEntry,
  formatStatusLine,
  parseSseChunk,
  stripAnsi,
  wrapText,
} from './render';
export type { ActiveSubagentSummary, ChatEntry, ChatRole, SseParseResult, TuiSize } from './render';

import { createTuiClient } from './client';

export interface RunTuiOptions {
  baseUrl?: string;
  model?: string;
}

/**
 * Boot the TUI. Resolves when the user issues /quit, /exit, or sends
 * EOF on stdin. Errors during boot reject; runtime errors are surfaced
 * inside the transcript instead.
 */
export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const client = createTuiClient(options);
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
    process.stdin.once('end', onExit);
  });
  await client.stop();
}
