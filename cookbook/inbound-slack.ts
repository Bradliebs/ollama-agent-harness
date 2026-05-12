// Cookbook recipe — Slack inbound poller + triage pipeline.
//
// Polls Slack channels for new messages and feeds them into the Jarvis
// inbound triage pipeline. Drafts replies for `urgent` / `reply_now` buckets;
// surfaces them through the `onTriaged` callback so the UI can present
// approve-to-send.
//
// Prerequisites:
//   * Slack bot token (xoxb-…) with channels:history scope
//   * The bot must be invited to each watched channel
//
// Wiring:
//   import { startSlackInbox } from '../cookbook/inbound-slack';
//   import { registerInboundPoller } from '../src/jarvis/inboundTriage';
//   const handle = startSlackInbox({
//     token: process.env.SLACK_BOT_TOKEN!,
//     channels: ['C0123456'],
//     pollMs: 30_000,
//     draftReply: async (msg) => `Acknowledged: ${msg.body.slice(0, 80)}…`,
//     onTriaged: (result) => evidenceQueue.push(result),
//   });
//   registerInboundPoller('slack');
//
// Trust ladder gating:
//   Drafts NEVER auto-send. The downstream UI calls the existing Slack send
//   tool, which goes through the standard PermissionEngine and capability
//   grant. The trust ladder rung for `slack_send` controls whether the
//   "send" button surfaces or auto-clicks itself (rung 4 only).

import { triageInboundMessage, type InboundMessage, type TriageOptions, type TriageResult } from '../src/jarvis/inboundTriage';

export interface SlackInboxOptions {
  token: string;
  channels: string[];
  pollMs?: number;
  draftReply?: TriageOptions['draftReply'];
  onTriaged: (result: TriageResult) => void;
  /** Inject a fetch implementation (defaults to global fetch). */
  fetcher?: typeof fetch;
}

export interface SlackInboxHandle {
  stop: () => void;
  isRunning: () => boolean;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: Array<{ ts: string; user?: string; text?: string; thread_ts?: string }>;
  error?: string;
}

export function startSlackInbox(options: SlackInboxOptions): SlackInboxHandle {
  const pollMs = options.pollMs ?? 30_000;
  const fetcher = options.fetcher ?? fetch;
  const lastTs = new Map<string, string>();
  let stopped = false;

  async function pollChannel(channel: string): Promise<void> {
    const oldest = lastTs.get(channel);
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channel);
    if (oldest) url.searchParams.set('oldest', oldest);
    const response = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${options.token}` } });
    if (!response.ok) throw new Error(`Slack API ${response.status}`);
    const body = (await response.json()) as SlackHistoryResponse;
    if (!body.ok) throw new Error(`Slack: ${body.error ?? 'unknown error'}`);
    const messages = body.messages ?? [];
    for (const m of messages.slice().reverse()) {
      const inbound: InboundMessage = {
        id: `slack:${channel}:${m.ts}`,
        channel: 'slack',
        from: m.user ?? 'unknown',
        body: m.text ?? '',
        receivedAt: new Date(parseFloat(m.ts) * 1000).toISOString(),
        threadId: m.thread_ts ?? m.ts,
        metadata: { channel },
      };
      const result = await triageInboundMessage(inbound, { draftReply: options.draftReply });
      options.onTriaged(result);
      lastTs.set(channel, m.ts);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    for (const channel of options.channels) {
      try { await pollChannel(channel); } catch (err) {
        process.stderr.write(`[slack-inbox] ${channel}: ${(err as Error).message}\n`);
      }
    }
  }

  const timer = setInterval(tick, pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  // Fire one immediately so first-run feedback is visible
  void tick();

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    isRunning: () => !stopped,
  };
}
