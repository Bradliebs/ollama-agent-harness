// Telegram inbound poller cookbook recipe.
//
// Polls Telegram getUpdates and feeds each message into the jarvis
// inbound triage pipeline. Drafts replies for urgent / reply_now buckets;
// surfaces them via the onTriaged callback for human approve-to-send.
//
// Wiring:
//   import { startTelegramInbox } from '../cookbook/inbound-telegram';
//   import { registerInboundPoller } from '../src/jarvis/inboundTriage';
//   const handle = startTelegramInbox({
//     token: process.env.HARNESS_TELEGRAM_BOT_TOKEN!,
//     pollMs: 30_000,
//     draftReply: async (msg) => `Acknowledged: ${msg.body.slice(0, 80)}…`,
//     onTriaged: (result) => evidenceQueue.push(result),
//   });
//   registerInboundPoller('telegram');

import { triageInboundMessage, type InboundMessage, type TriageOptions, type TriageResult } from '../src/jarvis/inboundTriage';

export interface TelegramInboxOptions {
  token: string;
  pollMs?: number;
  draftReply?: TriageOptions['draftReply'];
  onTriaged: (result: TriageResult) => void;
  fetcher?: typeof fetch;
}

export interface TelegramInboxHandle {
  stop: () => void;
  isRunning: () => boolean;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number };
    date: number;
    text?: string;
  };
}

export function startTelegramInbox(options: TelegramInboxOptions): TelegramInboxHandle {
  const pollMs = options.pollMs ?? 30_000;
  const fetcher = options.fetcher ?? fetch;
  let stopped = false;
  let lastUpdateId: number | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    const url = new URL(`https://api.telegram.org/bot${options.token}/getUpdates`);
    if (lastUpdateId !== undefined) url.searchParams.set('offset', String(lastUpdateId + 1));
    url.searchParams.set('timeout', '0');
    try {
      const response = await fetcher(url.toString());
      if (!response.ok) throw new Error(`Telegram API ${response.status}`);
      const body = (await response.json()) as { ok: boolean; result?: TgUpdate[]; description?: string };
      if (!body.ok) throw new Error(`Telegram: ${body.description ?? 'unknown error'}`);
      const updates = body.result ?? [];
      for (const update of updates) {
        if (update.update_id > (lastUpdateId ?? -1)) lastUpdateId = update.update_id;
        if (!update.message?.text) continue;
        const m = update.message;
        const inbound: InboundMessage = {
          id: `telegram:${m.chat.id}:${m.message_id}`,
          channel: 'telegram',
          from: m.from?.username ?? m.from?.first_name ?? String(m.from?.id ?? 'unknown'),
          body: m.text,
          receivedAt: new Date(m.date * 1000).toISOString(),
          threadId: String(m.chat.id),
          metadata: { chatId: m.chat.id },
        };
        const result = await triageInboundMessage(inbound, { draftReply: options.draftReply });
        options.onTriaged(result);
      }
    } catch (err) {
      process.stderr.write(`[telegram-inbox] ${(err as Error).message}\n`);
    }
  }

  const timer = setInterval(tick, pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    isRunning: () => !stopped,
  };
}
